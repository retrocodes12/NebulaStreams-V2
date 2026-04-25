import crypto from 'node:crypto';
import path from 'node:path';
import { createReadStream, createWriteStream, promises as fsPromises } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import { cacheConfig } from '../config.js';
import { logger } from '../utils/logger.js';

const {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile
} = fsPromises;

const SAFE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/iu;

const nowIso = () => new Date().toISOString();

const isMissingFileError = (error) => error?.code === 'ENOENT';

export class CacheManager {
  constructor() {
    this.rootDir = path.dirname(cacheConfig.HTTP_CACHE_DIR);
    this.httpCacheDir = cacheConfig.HTTP_CACHE_DIR;
    this.providerCacheDir = cacheConfig.PROVIDER_CACHE_DIR;
    this.torrentCacheDir = cacheConfig.TORRENT_CACHE_DIR;
    this.indexDir = path.join(this.rootDir, 'index');
    this.tempDir = path.join(this.rootDir, 'tmp');
    this.statsSnapshotPath = path.join(this.rootDir, 'cache-stats.snapshot.json');
    this.maxCacheSizeBytes = cacheConfig.MAX_CACHE_SIZE_BYTES;
    this.cacheStatsTtlMs = cacheConfig.STATS_TTL_MS;
    this.reservedCacheBytes = 0;
    this.cacheStatsSnapshot = null;
    this.cacheStatsRefreshPromise = null;
  }

  async initialize() {
    await Promise.all([
      mkdir(this.httpCacheDir, { recursive: true }),
      mkdir(this.providerCacheDir, { recursive: true }),
      mkdir(this.torrentCacheDir, { recursive: true }),
      mkdir(this.indexDir, { recursive: true }),
      mkdir(this.tempDir, { recursive: true })
    ]);

    await this.removePartialFiles();
    await this.loadCacheStatsSnapshot();

    if (!this.cacheStatsSnapshot) {
      this.cacheStatsSnapshot = this.buildCacheStatsPayload({
        currentCacheSizeBytes: 0,
        httpEntries: 0,
        providerEntries: 0,
        torrentEntries: 0
      }, []);
    }

    setTimeout(() => {
      this.refreshCacheStatsSnapshot().catch((error) => {
        logger.warn('cache stats refresh after startup failed', { error });
      });
    }, 0).unref?.();

    setTimeout(() => {
      this.pruneCache().catch((error) => {
        logger.warn('cache prune after startup failed', { error });
      });
    }, 0).unref?.();
  }

  buildCacheStatsPayload(stats, activeTorrentPaths = []) {
    const collectedAt = Date.now();

    return {
      cacheDir: this.rootDir,
      maxCacheSizeBytes: this.maxCacheSizeBytes,
      currentCacheSizeBytes: stats.currentCacheSizeBytes,
      httpEntries: stats.httpEntries,
      providerEntries: stats.providerEntries,
      torrentEntries: stats.torrentEntries,
      activeTorrentEntries: activeTorrentPaths.length,
      collectedAt
    };
  }

  annotateCacheStatsSnapshot(snapshot, activeTorrentPaths = [], stale = false) {
    const collectedAt = Number(snapshot?.collectedAt) || 0;
    const snapshotAgeMs = collectedAt > 0 ? Math.max(0, Date.now() - collectedAt) : null;

    return {
      cacheDir: snapshot?.cacheDir || this.rootDir,
      maxCacheSizeBytes: Number(snapshot?.maxCacheSizeBytes) || this.maxCacheSizeBytes,
      currentCacheSizeBytes: Number(snapshot?.currentCacheSizeBytes) || 0,
      httpEntries: Number(snapshot?.httpEntries) || 0,
      providerEntries: Number(snapshot?.providerEntries) || 0,
      torrentEntries: Number(snapshot?.torrentEntries) || 0,
      activeTorrentEntries: activeTorrentPaths.length,
      collectedAt,
      snapshotAgeMs,
      stale
    };
  }

  async loadCacheStatsSnapshot() {
    try {
      const raw = await readFile(this.statsSnapshotPath, 'utf8');
      const parsed = JSON.parse(raw);
      this.cacheStatsSnapshot = this.annotateCacheStatsSnapshot(parsed);
    } catch (error) {
      if (!isMissingFileError(error)) {
        logger.warn('cache stats snapshot load failed', { error });
      }
    }
  }

  async writeCacheStatsSnapshot(snapshot) {
    const persistedSnapshot = {
      cacheDir: snapshot.cacheDir,
      maxCacheSizeBytes: snapshot.maxCacheSizeBytes,
      currentCacheSizeBytes: snapshot.currentCacheSizeBytes,
      httpEntries: snapshot.httpEntries,
      providerEntries: snapshot.providerEntries,
      torrentEntries: snapshot.torrentEntries,
      collectedAt: snapshot.collectedAt
    };

    await writeFile(this.statsSnapshotPath, JSON.stringify(persistedSnapshot));
  }

  async refreshCacheStatsSnapshot(activeTorrentPaths = []) {
    if (this.cacheStatsRefreshPromise) {
      return this.cacheStatsRefreshPromise;
    }

    this.cacheStatsRefreshPromise = (async () => {
      const entries = await this.collectEntries();
      const snapshot = this.buildCacheStatsPayload({
        currentCacheSizeBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
        httpEntries: entries.filter((entry) => entry.type === 'http').length,
        providerEntries: entries.filter((entry) => entry.type === 'provider').length,
        torrentEntries: entries.filter((entry) => entry.type === 'torrent').length
      }, activeTorrentPaths);

      this.cacheStatsSnapshot = snapshot;

      try {
        await this.writeCacheStatsSnapshot(snapshot);
      } catch (error) {
        logger.warn('cache stats snapshot write failed', { error });
      }

      return this.annotateCacheStatsSnapshot(snapshot, activeTorrentPaths, false);
    })().finally(() => {
      this.cacheStatsRefreshPromise = null;
    });

    return this.cacheStatsRefreshPromise;
  }

  getHttpCacheKey(targetUrl) {
    return crypto.createHash('sha256').update(targetUrl).digest('hex');
  }

  getTorrentPath(infoHash) {
    return path.join(this.torrentCacheDir, this.toCacheKey(infoHash));
  }

  async isCached(id) {
    const metadata = await this.readMetadata(id);

    if (!metadata) {
      return false;
    }

    const targetPath = this.resolveMetadataPath(metadata);

    try {
      await stat(targetPath);
      return true;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }

      await this.removeMetadataByKey(metadata.key);
      return false;
    }
  }

  async getCachedPath(id) {
    const metadata = await this.readMetadata(id);

    if (!metadata) {
      return null;
    }

    const targetPath = this.resolveMetadataPath(metadata);

    try {
      await stat(targetPath);
      return targetPath;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }

      await this.removeMetadataByKey(metadata.key);
      return null;
    }
  }

  async markAccess(id) {
    const metadata = await this.readMetadata(id);

    if (!metadata) {
      return false;
    }

    const targetPath = this.resolveMetadataPath(metadata);

    try {
      const updatedMetadata = {
        ...metadata,
        lastAccessedAt: nowIso()
      };

      await this.writeMetadata(updatedMetadata);
      await this.touchFsPath(targetPath);
      return true;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }

      await this.removeMetadataByKey(metadata.key);
      return false;
    }
  }

  async saveToCache(id, sourcePath) {
    const key = this.toCacheKey(id);
    const sourceStats = await stat(sourcePath);
    const kind = sourceStats.isDirectory() ? 'directory' : 'file';
    const targetPath = this.getTargetPathForSave(key, sourcePath, kind);
    const sourceSize = kind === 'file' ? sourceStats.size : await this.getPathSize(sourcePath, kind);
    const reservation = await this.reserveCacheSpace(sourceSize, [targetPath]);

    if (!reservation) {
      throw new Error('Cache hard limit reached');
    }

    try {
      await rm(targetPath, { recursive: true, force: true });

      try {
        await rename(sourcePath, targetPath);
      } catch (error) {
        if (error.code !== 'EXDEV') {
          throw error;
        }

        await this.copyIntoCache(sourcePath, targetPath, kind);
        await rm(sourcePath, { recursive: true, force: true });
      }

      const size = await this.getPathSize(targetPath, kind);
      const metadata = {
        id: String(id).trim(),
        key,
        kind,
        path: path.relative(this.rootDir, targetPath),
        size,
        lastAccessedAt: nowIso(),
        cachedAt: nowIso()
      };

      await this.writeMetadata(metadata);
      await this.pruneCache();

      return targetPath;
    } finally {
      reservation.release();
    }
  }

  async getHttpCacheEntry(targetUrl) {
    const cacheKey = this.getHttpCacheKey(targetUrl);
    const metadata = await this.readMetadata(cacheKey);

    if (!metadata) {
      logger.info('cache miss', {
        cacheKey,
        sourceType: 'http'
      });
      return null;
    }

    const dataPath = this.resolveMetadataPath(metadata);

    try {
      const fileStats = await stat(dataPath);
      logger.info('cache hit', {
        cacheKey,
        size: fileStats.size,
        sourceType: 'http'
      });

      return {
        cacheKey,
        dataPath,
        metaPath: this.getMetadataPath(cacheKey),
        metadata,
        size: fileStats.size
      };
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }

      await this.removeMetadataByKey(cacheKey);
      logger.info('cache miss', {
        cacheKey,
        sourceType: 'http'
      });
      return null;
    }
  }

  async createHttpCacheWrite(targetUrl, upstreamHeaders) {
    const cacheKey = this.getHttpCacheKey(targetUrl);
    const tempPath = path.join(
      this.tempDir,
      `${cacheKey}.${Date.now()}-${crypto.randomBytes(4).toString('hex')}.part`
    );
    const dataPath = path.join(this.httpCacheDir, `${cacheKey}.bin`);
    const writer = createWriteStream(tempPath, { flags: 'w' });
    const expectedSize = upstreamHeaders['content-length']
      ? Number.parseInt(upstreamHeaders['content-length'], 10)
      : null;

    if (!Number.isInteger(expectedSize) || expectedSize <= 0) {
      writer.destroy();
      await rm(tempPath, { force: true });
      return null;
    }

    const reservation = await this.reserveCacheSpace(expectedSize, [dataPath]);

    if (!reservation) {
      writer.destroy();
      await rm(tempPath, { force: true });
      logger.warn('cache write skipped due to hard limit', {
        cacheKey,
        expectedSize
      });
      return null;
    }

    return {
      writer,
      commit: async () => {
        try {
          await rm(dataPath, { force: true });
          await rename(tempPath, dataPath);

          const fileStats = await stat(dataPath);
          const metadata = {
            id: cacheKey,
            key: cacheKey,
            kind: 'file',
            path: path.relative(this.rootDir, dataPath),
            size: fileStats.size,
            lastAccessedAt: nowIso(),
            cachedAt: nowIso(),
            sourceType: 'http',
            url: targetUrl,
            contentType: upstreamHeaders['content-type'] ?? 'application/octet-stream',
            contentLength: upstreamHeaders['content-length']
              ? Number.parseInt(upstreamHeaders['content-length'], 10)
              : fileStats.size,
            etag: upstreamHeaders.etag ?? null,
            lastModified: upstreamHeaders['last-modified'] ?? null
          };

          await this.writeMetadata(metadata);
          logger.info('cache write committed', {
            cacheKey,
            size: fileStats.size,
            sourceType: 'http'
          });
        } finally {
          reservation.release();
        }
      },
      abort: async () => {
        try {
          writer.destroy();
          await rm(tempPath, { force: true });
        } finally {
          reservation.release();
        }
      }
    };
  }

  async touchPath(targetPath) {
    const normalizedTargetPath = path.resolve(targetPath);
    const inferredId = this.inferIdFromPath(normalizedTargetPath);

    if (!inferredId) {
      await this.touchFsPath(normalizedTargetPath);
      return;
    }

    const existingMetadata = await this.readMetadata(inferredId);

    if (existingMetadata) {
      await this.markAccess(inferredId);
      return;
    }

    try {
      const targetStats = await stat(normalizedTargetPath);
      const kind = targetStats.isDirectory() ? 'directory' : 'file';
      const existingSize = existingMetadata?.size ?? (kind === 'file' ? targetStats.size : 0);
      const metadata = {
        id: inferredId,
        key: this.toCacheKey(inferredId),
        kind,
        path: path.relative(this.rootDir, normalizedTargetPath),
        size: existingSize,
        lastAccessedAt: nowIso(),
        cachedAt: nowIso()
      };

      await this.writeMetadata(metadata);
      await this.touchFsPath(normalizedTargetPath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  async pruneCache(excludedPaths = [], targetSizeBytes = this.maxCacheSizeBytes) {
    const excluded = excludedPaths.map((entryPath) => path.resolve(entryPath));
    const entries = await this.collectEntries();
    let totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);

    if (totalSize <= targetSizeBytes) {
      return;
    }

    const removableEntries = entries
      .filter((entry) => !excluded.some((excludedPath) =>
        entry.path === excludedPath || entry.path.startsWith(`${excludedPath}${path.sep}`)))
      .sort((left, right) => left.lastAccessed - right.lastAccessed);

    for (const entry of removableEntries) {
      if (totalSize <= targetSizeBytes) {
        break;
      }

      await rm(entry.path, { recursive: true, force: true });
      await this.removeMetadataByKey(entry.key);
      logger.info('cache evicted', {
        cacheKey: entry.key,
        size: entry.size,
        type: entry.type
      });
      totalSize -= entry.size;
    }
  }

  async getCacheStats(activeTorrentPaths = []) {
    const snapshot = this.cacheStatsSnapshot;
    const snapshotAgeMs = snapshot?.collectedAt
      ? Math.max(0, Date.now() - snapshot.collectedAt)
      : Number.POSITIVE_INFINITY;

    if (snapshot && snapshotAgeMs <= this.cacheStatsTtlMs) {
      return this.annotateCacheStatsSnapshot(snapshot, activeTorrentPaths, false);
    }

    if (snapshot) {
      this.refreshCacheStatsSnapshot(activeTorrentPaths).catch((error) => {
        logger.warn('cache stats background refresh failed', { error });
      });
      return this.annotateCacheStatsSnapshot(snapshot, activeTorrentPaths, true);
    }

    this.refreshCacheStatsSnapshot(activeTorrentPaths).catch((error) => {
      logger.warn('cache stats background refresh failed', { error });
    });
    return this.annotateCacheStatsSnapshot(this.buildCacheStatsPayload({
      currentCacheSizeBytes: 0,
      httpEntries: 0,
      providerEntries: 0,
      torrentEntries: 0
    }, activeTorrentPaths), activeTorrentPaths, true);
  }

  toCacheKey(id) {
    const normalizedId = String(id || '').trim();

    if (!normalizedId) {
      throw new TypeError('Cache id must be a non-empty string');
    }

    if (SAFE_KEY_PATTERN.test(normalizedId)) {
      return normalizedId.toLowerCase();
    }

    return crypto.createHash('sha256').update(normalizedId).digest('hex');
  }

  getMetadataPath(id) {
    return path.join(this.indexDir, `${this.toCacheKey(id)}.json`);
  }

  getTargetPathForSave(key, sourcePath, kind) {
    if (kind === 'directory') {
      return path.join(this.torrentCacheDir, key);
    }

    const extension = path.extname(sourcePath) || '.bin';
    return path.join(this.httpCacheDir, `${key}${extension}`);
  }

  resolveMetadataPath(metadata) {
    return path.resolve(this.rootDir, metadata.path);
  }

  inferIdFromPath(targetPath) {
    const normalizedPath = path.resolve(targetPath);

    if (normalizedPath.startsWith(`${this.httpCacheDir}${path.sep}`)) {
      return path.basename(normalizedPath, path.extname(normalizedPath));
    }

    if (normalizedPath.startsWith(`${this.torrentCacheDir}${path.sep}`)) {
      return path.basename(normalizedPath);
    }

    return null;
  }

  async readMetadata(id) {
    const metadataPath = this.getMetadataPath(id);

    try {
      const buffer = await readFile(metadataPath, 'utf8');
      return JSON.parse(buffer);
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }

      throw error;
    }
  }

  async writeMetadata(metadata) {
    const payload = {
      ...metadata,
      key: this.toCacheKey(metadata.key ?? metadata.id)
    };

    await writeFile(this.getMetadataPath(payload.key), JSON.stringify(payload, null, 2));
  }

  async removeMetadataByKey(key) {
    await rm(this.getMetadataPath(key), { force: true });
  }

  async removePartialFiles() {
    const tempEntries = await readdir(this.tempDir, { withFileTypes: true });

    await Promise.all(tempEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.part'))
      .map((entry) => rm(path.join(this.tempDir, entry.name), { force: true })));
  }

  async collectEntries() {
    const metadataFiles = await readdir(this.indexDir, { withFileTypes: true });
    const entries = await this.collectProviderEntries();

    for (const entry of metadataFiles) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }

      const metadataPath = path.join(this.indexDir, entry.name);

      try {
        const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
        const targetPath = this.resolveMetadataPath(metadata);
        const size = metadata.kind === 'file'
          ? (await stat(targetPath)).size
          : Number.isFinite(metadata.size) ? metadata.size : 0;

        entries.push({
          key: metadata.key,
          type: metadata.path.startsWith('http/') ? 'http' : 'torrent',
          path: targetPath,
          size,
          lastAccessed: Date.parse(metadata.lastAccessedAt || metadata.cachedAt || nowIso()) || 0
        });
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }

        await unlink(metadataPath).catch(() => {});
      }
    }

    return entries;
  }

  async collectProviderEntries() {
    let entries = [];

    try {
      entries = await readdir(this.providerCacheDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }

      throw error;
    }

    const output = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }

      const entryPath = path.join(this.providerCacheDir, entry.name);

      try {
        const fileStats = await stat(entryPath);
        output.push({
          key: entry.name.replace(/\.json$/u, ''),
          type: 'provider',
          path: entryPath,
          size: fileStats.size,
          lastAccessed: fileStats.mtimeMs
        });
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
    }

    return output;
  }

  async getPathSize(targetPath, kind) {
    if (kind !== 'directory') {
      const targetStats = await stat(targetPath);
      return targetStats.size;
    }

    const entries = await readdir(targetPath, { withFileTypes: true });
    let total = 0;

    for (const entry of entries) {
      const entryPath = path.join(targetPath, entry.name);

      if (entry.isDirectory()) {
        total += await this.getPathSize(entryPath, 'directory');
        continue;
      }

      const targetStats = await stat(entryPath);
      total += targetStats.size;
    }

    return total;
  }

  async copyIntoCache(sourcePath, targetPath, kind) {
    await mkdir(path.dirname(targetPath), { recursive: true });

    if (kind === 'directory') {
      await mkdir(targetPath, { recursive: true });
      const entries = await readdir(sourcePath, { withFileTypes: true });

      for (const entry of entries) {
        const sourceEntryPath = path.join(sourcePath, entry.name);
        const targetEntryPath = path.join(targetPath, entry.name);
        const entryKind = entry.isDirectory() ? 'directory' : 'file';

        await this.copyIntoCache(sourceEntryPath, targetEntryPath, entryKind);
      }

      return;
    }

    try {
      await copyFile(sourcePath, targetPath);
    } catch (error) {
      if (error.code !== 'EFBIG') {
        throw error;
      }

      await pipeline(
        createReadStream(sourcePath),
        createWriteStream(targetPath, { flags: 'w' })
      );
    }
  }

  async touchFsPath(targetPath) {
    const now = new Date();

    try {
      await utimes(targetPath, now, now);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
  }

  async reserveCacheSpace(sizeBytes, excludedPaths = []) {
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      return {
        release() {}
      };
    }

    if (sizeBytes > this.maxCacheSizeBytes) {
      return null;
    }

    const entries = await this.collectEntries();
    const currentSize = entries.reduce((sum, entry) => sum + entry.size, 0);
    const targetSize = this.maxCacheSizeBytes - sizeBytes - this.reservedCacheBytes;

    if (targetSize < 0) {
      return null;
    }

    await this.pruneCache(excludedPaths, targetSize);

    const refreshedEntries = await this.collectEntries();
    const refreshedSize = refreshedEntries.reduce((sum, entry) => sum + entry.size, 0);

    if (refreshedSize + this.reservedCacheBytes + sizeBytes > this.maxCacheSizeBytes) {
      return null;
    }

    this.reservedCacheBytes += sizeBytes;

    let released = false;

    return {
      release: () => {
        if (released) {
          return;
        }

        released = true;
        this.reservedCacheBytes = Math.max(this.reservedCacheBytes - sizeBytes, 0);
      }
    };
  }
}
