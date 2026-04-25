import torrentStream from 'torrent-stream';

import { config } from '../config.js';
import {
  enhanceMagnet,
  extractInfoHash,
  resolveRequestedFile
} from '../utils/magnet.js';
import { logger } from '../utils/logger.js';
import { createHttpError, parseRangeHeader } from './streamManager.js';

const MIME_TYPES = new Map([
  ['.avi', 'video/x-msvideo'],
  ['.m4v', 'video/x-m4v'],
  ['.mkv', 'video/x-matroska'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.srt', 'application/x-subrip'],
  ['.ts', 'video/mp2t'],
  ['.vtt', 'text/vtt'],
  ['.webm', 'video/webm']
]);

const getMimeType = (fileName) => {
  const normalized = String(fileName || '').toLowerCase();

  for (const [extension, mimeType] of MIME_TYPES.entries()) {
    if (normalized.endsWith(extension)) {
      return mimeType;
    }
  }

  return 'application/octet-stream';
};

const waitForMetadata = (engine, timeoutMs) =>
  new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(createHttpError(504, `Torrent metadata lookup timed out after ${Math.floor(timeoutMs / 1000)} seconds`));
    }, timeoutMs);

    const handleMetadata = () => {
      cleanup();
      resolve();
    };

    const handleError = (error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      engine.off('torrent', handleMetadata);
      engine.off('error', handleError);
    };

    timeoutId.unref();
    engine.once('torrent', handleMetadata);
    engine.once('error', handleError);
  });

const waitForReady = (engine) =>
  new Promise((resolve, reject) => {
    if (engine.torrent) {
      resolve();
      return;
    }

    const handleReady = () => {
      cleanup();
      resolve();
    };

    const handleError = (error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      engine.off('ready', handleReady);
      engine.off('error', handleError);
    };

    engine.once('ready', handleReady);
    engine.once('error', handleError);
  });

const selectOnlyFile = (engine, selectedFile) => {
  for (const file of engine.files) {
    if (file === selectedFile) {
      file.select();
      continue;
    }

    file.deselect();
  }
};

const destroyEngineInstance = (engine) =>
  new Promise((resolve) => {
    if (!engine) {
      resolve();
      return;
    }

    engine.destroy(() => resolve());
  });

export const createTorrentSession = async ({
  magnet,
  cachePath,
  metadataTimeoutMs = config.TORRENT_METADATA_TIMEOUT_SECONDS * 1000,
  connections = config.TORRENT_CONNECTIONS
}) => {
  let enhancedMagnet;

  try {
    enhancedMagnet = enhanceMagnet(magnet);
  } catch (error) {
    throw createHttpError(400, error.message);
  }

  const infoHash = extractInfoHash(enhancedMagnet);

  if (!infoHash) {
    throw createHttpError(400, 'Invalid magnet URI');
  }

  const engine = torrentStream(enhancedMagnet, {
    path: cachePath,
    tmp: cachePath,
    connections,
    uploads: 0,
    verify: true,
    dht: true,
    tracker: true
  });

  try {
    await waitForMetadata(engine, metadataTimeoutMs);
    await waitForReady(engine);

    const file = resolveRequestedFile(engine.files);

    if (!file) {
      throw createHttpError(404, 'No streamable file found in torrent metadata');
    }

    selectOnlyFile(engine, file);

    return {
      engine,
      file,
      infoHash
    };
  } catch (error) {
    await destroyEngineInstance(engine);

    if (error?.statusCode) {
      logger.error('torrent session initialization failed', {
        infoHash,
        cachePath,
        error
      });
      throw error;
    }

    const wrappedError = createHttpError(502, 'Failed to initialize torrent engine');
    logger.error('torrent session initialization failed', {
      infoHash,
      cachePath,
      error
    });
    throw wrappedError;
  }
};

export class TorrentEngineService {
  constructor({ cacheManager }) {
    this.cacheManager = cacheManager;
    this.engines = new Map();
    this.idleTtlMs = config.TORRENT_IDLE_TTL_SECONDS * 1000;

    this.cleanupTimer = setInterval(() => {
      this.destroyIdleEngines().catch((error) => {
        logger.error('torrent cleanup failed', { error });
      });
    }, config.TORRENT_CLEANUP_INTERVAL_SECONDS * 1000);

    this.cleanupTimer.unref();
  }

  async getStreamDescriptor({ magnet, fileIndex, fileName, rangeHeader }) {
    const record = await this.getOrCreateEngine(magnet);
    return this.createStreamDescriptor(record, {
      fileIndex,
      fileName,
      rangeHeader
    });
  }

  async getStreamDescriptorByInfoHash({ infoHash, fileName, rangeHeader }) {
    const normalizedInfoHash = String(infoHash || '').trim().toLowerCase();

    if (!/^[a-z0-9]+$/iu.test(normalizedInfoHash)) {
      throw createHttpError(400, 'Invalid torrent infoHash');
    }

    const record = this.engines.get(normalizedInfoHash);

    if (!record) {
      throw createHttpError(404, 'Torrent engine is not active for the requested infoHash');
    }

    await record.initPromise;

    return this.createStreamDescriptor(record, {
      fileName,
      rangeHeader,
      requireExplicitFileName: true
    });
  }

  getActiveCachePaths() {
    return Array.from(this.engines.values(), (record) => record.cachePath);
  }

  async close() {
    clearInterval(this.cleanupTimer);
    await Promise.all(Array.from(this.engines.keys(), (infoHash) => this.destroyEngine(infoHash)));
  }

  async getOrCreateEngine(magnet) {
    if (typeof magnet !== 'string' || !magnet.trim()) {
      throw createHttpError(400, 'A magnet query parameter is required');
    }

    let enhancedMagnet;

    try {
      enhancedMagnet = enhanceMagnet(magnet);
    } catch (error) {
      throw createHttpError(400, error.message);
    }

    const infoHash = extractInfoHash(enhancedMagnet);

    if (!infoHash) {
      throw createHttpError(400, 'Invalid magnet URI');
    }

    const existing = this.engines.get(infoHash);

    if (existing) {
      await existing.initPromise;
      return existing;
    }

    await this.enforceEngineLimit();

    const cachePath = this.cacheManager.getTorrentPath(infoHash);
    const record = {
      infoHash,
      cachePath,
      activeStreams: 0,
      lastAccessedAt: Date.now(),
      engine: null,
      file: null,
      initPromise: null,
      destroyPromise: null,
      onError: null
    };

    record.initPromise = this.initializeRecord(record, enhancedMagnet);
    this.engines.set(infoHash, record);

    try {
      await record.initPromise;
      return record;
    } catch (error) {
      this.engines.delete(infoHash);
      throw error;
    }
  }

  async initializeRecord(record, enhancedMagnet) {
    const session = await createTorrentSession({
      magnet: enhancedMagnet,
      cachePath: record.cachePath
    });

    record.engine = session.engine;
    record.file = session.file;
    record.infoHash = session.infoHash;
    record.onError = (error) => {
      logger.error('torrent engine error', {
        infoHash: record.infoHash,
        error
      });
      this.destroyEngine(record.infoHash).catch((destroyError) => {
        logger.error('torrent engine destroy after error failed', {
          infoHash: record.infoHash,
          error: destroyError
        });
      });
    };
    record.engine.on('error', record.onError);

    logger.info('torrent started', {
      infoHash: record.infoHash,
      fileName: record.file.name,
      fileLength: record.file.length,
      connections: config.TORRENT_CONNECTIONS
    });
  }

  async enforceEngineLimit() {
    if (this.engines.size < config.MAX_ACTIVE_TORRENTS) {
      return;
    }

    await this.destroyOldestIdleEngine();

    if (this.engines.size < config.MAX_ACTIVE_TORRENTS) {
      return;
    }

    throw createHttpError(503, 'Maximum active torrent engines reached');
  }

  async destroyIdleEngines() {
    const now = Date.now();
    const candidates = Array.from(this.engines.entries())
      .filter(([, record]) => record.activeStreams === 0 && now - record.lastAccessedAt >= this.idleTtlMs)
      .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt);

    for (const [infoHash] of candidates) {
      await this.destroyEngine(infoHash);
    }
  }

  async destroyOldestIdleEngine() {
    const candidate = Array.from(this.engines.entries())
      .filter(([, record]) => record.activeStreams === 0)
      .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt)[0];

    if (candidate) {
      await this.destroyEngine(candidate[0]);
    }
  }

  async destroyEngine(infoHash) {
    const record = this.engines.get(infoHash);

    if (!record) {
      return;
    }

    if (record.destroyPromise) {
      await record.destroyPromise;
      return;
    }

    record.destroyPromise = (async () => {
      this.engines.delete(infoHash);

      if (record.engine && record.onError) {
        record.engine.off('error', record.onError);
      }

      await destroyEngineInstance(record.engine);
      logger.info('torrent destroyed', {
        infoHash,
        activeStreams: record.activeStreams
      });
    })();

    await record.destroyPromise;
  }

  async createStreamDescriptor(record, { fileIndex, fileName, rangeHeader, requireExplicitFileName = false } = {}) {
    const normalizedIndex = fileIndex === undefined ? undefined : Number.parseInt(fileIndex, 10);
    const selectedFile = resolveRequestedFile(record.engine.files, {
      fileIndex: Number.isNaN(normalizedIndex) ? undefined : normalizedIndex,
      fileName
    }) || (!requireExplicitFileName ? record.file : null);

    if (!selectedFile) {
      throw createHttpError(404, 'Requested torrent file was not found');
    }

    if (requireExplicitFileName) {
      let decodedFileName;

      try {
        decodedFileName = decodeURIComponent(String(fileName || '').trim());
      } catch {
        throw createHttpError(400, 'Invalid torrent filename');
      }

      const normalizedNeedle = decodedFileName.toLowerCase();
      const normalizedSelectedName = selectedFile.name.toLowerCase();

      if (normalizedSelectedName !== normalizedNeedle && !normalizedSelectedName.endsWith(`/${normalizedNeedle}`)) {
        throw createHttpError(404, 'Requested torrent file was not found');
      }
    }

    if (selectedFile !== record.file) {
      selectOnlyFile(record.engine, selectedFile);
      record.file = selectedFile;
    }

    const range = parseRangeHeader(rangeHeader, selectedFile.length);
    const streamOptions = range.statusCode === 206 ? { start: range.start, end: range.end } : undefined;
    const stream = selectedFile.createReadStream(streamOptions);

    record.activeStreams += 1;
    record.lastAccessedAt = Date.now();

    await this.cacheManager.touchPath(record.cachePath);

    return {
      statusCode: range.statusCode,
      stream,
      headers: {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Length': range.contentLength,
        'Content-Range': range.contentRange,
        'Content-Type': getMimeType(selectedFile.name),
        'X-Torrent-Info-Hash': record.infoHash,
        'X-Torrent-File-Name': selectedFile.name
      },
      cleanup: async ({ completed }) => {
        record.activeStreams = Math.max(record.activeStreams - 1, 0);
        record.lastAccessedAt = Date.now();

        if (!completed && !stream.destroyed) {
          stream.destroy();
        }

        if (record.activeStreams === 0) {
          this.cacheManager.pruneCache(this.getActiveCachePaths()).catch((error) => {
            logger.error('cache prune after torrent stream failed', { error });
          });
        }
      }
    };
  }
}
