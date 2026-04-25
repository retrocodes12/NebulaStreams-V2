import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';
import { createClient } from 'redis';
import { config, cacheConfig } from '../config.js';
import { loadExtractor as resolveExtractorRedirect } from '../vendor/provider-pack/src/hdhub4u/extractors.js';
import { enhanceMagnet, extractInfoHash } from '../utils/magnet.js';
import { logger } from '../utils/logger.js';

const { mkdir, readFile, readdir, rm, writeFile } = fsPromises;

const detectSourceType = (source) => {
  const normalized = String(source || '').trim();

  if (!normalized) {
    return null;
  }

  if (normalized.startsWith('magnet:?')) {
    return 'magnet';
  }

  try {
    const parsedUrl = new URL(normalized);

    if (parsedUrl.protocol === 'magnet:') {
      return 'magnet';
    }

    if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
      return 'http';
    }
  } catch {
    return null;
  }

  return null;
};

const getRequestPublicBaseUrl = (req) => {
  if (config.PUBLIC_BASE_URL) {
    return config.PUBLIC_BASE_URL;
  }

  const host = String(req?.get?.('host') || '').trim();

  if (host) {
    return `${req.protocol}://${host}`;
  }

  return `http://127.0.0.1:${config.PORT}`;
};

const normalizeRequestedType = (type) => {
  if (typeof type !== 'string' || !type.trim()) {
    return null;
  }

  const normalized = type.trim().toLowerCase();

  if (normalized === 'http' || normalized === 'torrent') {
    return normalized;
  }

  return null;
};

const toStremioCompatibilityScore = (stream) => {
  const url = String(stream.url || '').toLowerCase();
  const title = `${String(stream.name || '')} ${String(stream.title || '')}`.toLowerCase();
  let score = 0;

  if (stream.magnet || stream.torrent) {
    return 20 + score;
  }

  if (url.includes('.mp4')) {
    score += 120;
  } else if (url.includes('.m3u8')) {
    score += 100;
  } else if (url.includes('.webm')) {
    score += 70;
  } else if (url.includes('.mkv')) {
    score += 40;
  } else {
    score += 50;
  }

  const qualityMatch = String(stream.quality || '').match(/(\d{3,4})/);

  if (qualityMatch?.[1]) {
    const quality = Number.parseInt(qualityMatch[1], 10);
    score += Math.min(quality, 1080);
  }

  if (/\b(hevc|x265|10bit|hdr|dolby vision|dovi|remux|untouch)\b/u.test(title)) {
    score -= 400;
  }

  if (/\b(x264|h264|aac)\b/u.test(title)) {
    score += 80;
  }

  if (title.includes('auto')) {
    score -= 40;
  }

  return score;
};

const getStreamFormatBadge = (stream) => {
  if (stream.magnet || stream.torrent) {
    return '[TORRENT]';
  }

  const url = String(stream.url || '').toLowerCase();
  const text = `${String(stream.name || '')} ${String(stream.title || '')}`.toLowerCase();
  const parts = [];

  if (url.includes('.mp4')) {
    parts.push('MP4');
  } else if (url.includes('.m3u8')) {
    parts.push('HLS');
  } else if (url.includes('.mkv')) {
    parts.push('MKV');
  } else if (url.includes('.webm')) {
    parts.push('WEBM');
  } else {
    parts.push('HTTP');
  }

  if (/\b(hevc|x265)\b/u.test(text)) {
    parts.push('HEVC');
  } else if (/\b(h264|x264)\b/u.test(text)) {
    parts.push('H264');
  }

  if (/\b10bit\b/u.test(text)) {
    parts.push('10BIT');
  }

  if (/\b(hdr|dolby vision|dovi)\b/u.test(text)) {
    parts.push('HDR');
  }

  return `[${parts.join('/')}]`;
};

const toTitleCaseLabel = (providerId) =>
  String(providerId || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());

const DEFAULT_QUALITY_PRIORITY = Object.freeze([
  '2160p',
  '1440p',
  '1080p',
  '720p',
  '480p',
  '360p',
  'auto',
  'unknown'
]);

const DEFAULT_STREAM_OPTIONS = Object.freeze({
  webReadyOnly: false,
  hideHeavyFormats: false,
  maxSizeGb: 0,
  blockHosts: Object.freeze([]),
  preferredAudioLanguage: null,
  dedupeMode: 'off',
  preferHdr: false,
  preferH264: false,
  preferSmallerFiles: false,
  preferDirectHosts: false,
  customProxyUrl: null
});
const DEFAULT_PRIVATE_PROVIDER_SETTINGS = Object.freeze({
  febboxUiCookie: null,
  showboxOssGroup: null
});
const PRIVATE_CONFIG_VERSION = 1;
const PRIVATE_PROVIDER_COOKIE_MAX_LENGTH = 4096;
const EXTRACTOR_REDIRECT_HOST_PATTERN = /\b(?:techyboy4u|gadgetsweb\.xyz|cryptoinsights\.site|bloggingvector|ampproject\.org)\b/iu;
const EXTRACTOR_REDIRECT_CACHE_TTL_MS = 30 * 60 * 1000;
const EXTRACTOR_REDIRECT_CACHE_MAX_ENTRIES = 512;

const HIGH_VALUE_CACHE_PROVIDERS = new Set(['4khdhub', '4khdhub_tv', 'hdhub4u']);
const HIGH_VALUE_CACHE_PATTERN = /\b(4khdhub|hdhub|hubcloud|hub cloud)\b/iu;
const LAST_GOOD_PRIMARY_PROVIDERS = new Set(['4khdhub', '4khdhub tv', 'hdhub4u', 'uhdmovies']);
const LAST_GOOD_SECONDARY_PROVIDERS = new Set(['vidsrc', 'vixsrc', 'vidlink', 'moviebox', 'cinestream', 'streamflix']);

const CONFIGURED_PROFILE_LABELS = Object.freeze({
  wf: Object.freeze({ code: 'WF', label: 'Web Fast' }),
  md: Object.freeze({ code: 'MD', label: 'Mobile Data' }),
  '4k': Object.freeze({ code: '4K', label: '4K HDR' }),
  an: Object.freeze({ code: 'AN', label: 'Anime' }),
  in: Object.freeze({ code: 'IN', label: 'Indian Content' }),
  tr: Object.freeze({ code: 'TR', label: 'Turkish Content' }),
  it: Object.freeze({ code: 'IT', label: 'Italian Content' }),
  la: Object.freeze({ code: 'LA', label: 'Latino Content' }),
  ar: Object.freeze({ code: 'AR', label: 'Arabic Content' })
});

const LANGUAGE_FLAG_MAP = Object.freeze({
  English: '🇺🇸',
  Hindi: '🇮🇳',
  Tamil: '🇮🇳',
  Telugu: '🇮🇳',
  Malayalam: '🇮🇳',
  Kannada: '🇮🇳',
  Spanish: '🇪🇸',
  Arabic: '🇸🇦',
  French: '🇫🇷',
  German: '🇩🇪',
  Russian: '🇷🇺',
  Portuguese: '🇵🇹',
  Japanese: '🇯🇵',
  Korean: '🇰🇷',
  Turkish: '🇹🇷',
  Italian: '🇮🇹'
});

const copyObjects = (items) => items.map((item) => ({ ...item }));
const serializeObjects = (items) => JSON.stringify(Array.isArray(items) ? items : []);
const deserializeObjects = (payload) => {
  if (typeof payload !== 'string' || !payload) {
    return [];
  }

  try {
    const parsed = JSON.parse(payload);
    return Array.isArray(parsed) ? copyObjects(parsed) : [];
  } catch {
    return [];
  }
};
const getSerializedApproxBytes = (payload) => Buffer.byteLength(String(payload || ''), 'utf8');

const delay = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

const normalizeProviderLabel = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const extractProviderLabelFromStremioStream = (stream) => {
  const titleLines = String(stream?.title || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const detailsLine = titleLines[1] || '';

  const explicitSourceMatch = detailsLine.match(/🔗\s+(.+?)\s+from\s+(.+)$/u);
  if (explicitSourceMatch?.[2]) {
    return normalizeProviderLabel(explicitSourceMatch[2]);
  }

  const sourceOnlyMatch = detailsLine.match(/🔗\s+(.+)$/u);
  return normalizeProviderLabel(sourceOnlyMatch?.[1] || '');
};

const extractQualityScoreFromStremioStream = (stream) => {
  const firstLine = String(stream?.name || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
  const match = firstLine.match(/(\b4k\b|\b\d{3,4}p\b)/iu);
  const qualityText = String(match?.[1] || '').trim().toLowerCase();

  if (qualityText.includes('4k')) {
    return 2160;
  }

  const qualityMatch = qualityText.match(/(\d{3,4})/);
  if (qualityMatch?.[1]) {
    return Number.parseInt(qualityMatch[1], 10);
  }

  return 0;
};

const getLastGoodStreamSetScore = (streams) => {
  if (!Array.isArray(streams) || streams.length === 0) {
    return 0;
  }

  const providers = streams
    .map((stream) => extractProviderLabelFromStremioStream(stream))
    .filter(Boolean);
  const uniqueProviders = new Set(providers);
  const bestQualityScore = Math.max(
    0,
    ...streams.map((stream) => extractQualityScoreFromStremioStream(stream))
  );
  const primaryHits = providers.filter((providerId) => LAST_GOOD_PRIMARY_PROVIDERS.has(providerId)).length;
  const secondaryHits = providers.filter((providerId) => LAST_GOOD_SECONDARY_PROVIDERS.has(providerId)).length;

  return (primaryHits * 10000) + (secondaryHits * 3000) + (uniqueProviders.size * 500) + bestQualityScore + streams.length;
};

const shouldPersistLastGoodStreamSet = (streams) => {
  if (!Array.isArray(streams) || streams.length === 0) {
    return false;
  }

  const providers = streams
    .map((stream) => extractProviderLabelFromStremioStream(stream))
    .filter(Boolean);
  const uniqueProviders = new Set(providers);
  const hasPrimary = providers.some((providerId) => LAST_GOOD_PRIMARY_PROVIDERS.has(providerId));
  const hasSecondary = providers.some((providerId) => LAST_GOOD_SECONDARY_PROVIDERS.has(providerId));
  const bestQualityScore = Math.max(
    0,
    ...streams.map((stream) => extractQualityScoreFromStremioStream(stream))
  );

  if (hasPrimary) {
    return true;
  }

  return hasSecondary || uniqueProviders.size >= 2 || bestQualityScore >= 1080;
};

const normalizeStremioResultCacheEntry = (payload) => {
  if (!payload || (typeof payload.serializedStreams !== 'string' && !Array.isArray(payload.streams))) {
    return null;
  }

  const expiresAt = Number(payload.expiresAt || 0);
  const staleExpiresAt = Number(payload.staleExpiresAt || expiresAt);

  if (!Number.isFinite(expiresAt) || !Number.isFinite(staleExpiresAt)) {
    return null;
  }

  return {
    expiresAt,
    staleExpiresAt,
    approxBytes: getSerializedApproxBytes(typeof payload.serializedStreams === 'string'
      ? payload.serializedStreams
      : serializeObjects(payload.streams)),
    serializedStreams: typeof payload.serializedStreams === 'string'
      ? payload.serializedStreams
      : serializeObjects(payload.streams)
  };
};

class RedisStreamResultCache {
  constructor() {
    this.client = null;
    this.enabled = false;
    this.available = false;
    this.failureCount = 0;
  }

  async initialize() {
    if (!config.STREAM_RESULT_EXTERNAL_CACHE_ENABLED || !config.REDIS_URL) {
      return;
    }

    this.enabled = true;
    this.client = createClient({
      url: config.REDIS_URL,
      socket: {
        connectTimeout: 3000,
        reconnectStrategy: (retries) => retries > 3 ? false : Math.min(retries * 100, 1000)
      }
    });

    this.client.on('error', (error) => {
      this.available = false;
      this.failureCount += 1;
      logger.warn('redis stream result cache error', { error });
    });

    this.client.on('ready', () => {
      this.available = true;
      logger.info('redis stream result cache connected');
    });

    try {
      await this.client.connect();
      this.available = true;
    } catch (error) {
      this.available = false;
      this.failureCount += 1;
      logger.warn('redis stream result cache unavailable, using local cache fallback', { error });
    }
  }

  getStats() {
    return {
      enabled: this.enabled,
      available: this.available,
      failureCount: this.failureCount
    };
  }

  getKey(cacheKey) {
    return `${config.REDIS_CACHE_PREFIX}:stremio-result:${createHash('sha1').update(cacheKey).digest('hex')}`;
  }

  async get(cacheKey) {
    if (!this.client || !this.available) {
      return null;
    }

    try {
      const rawPayload = await this.client.get(this.getKey(cacheKey));

      if (!rawPayload) {
        return null;
      }

      return normalizeStremioResultCacheEntry(JSON.parse(rawPayload));
    } catch (error) {
      this.available = false;
      this.failureCount += 1;
      logger.warn('redis stream result cache read failed', { error });
      return null;
    }
  }

  async set(cacheKey, entry) {
    if (!this.client || !this.available) {
      return;
    }

    const ttlSeconds = Math.max(1, Math.ceil((entry.staleExpiresAt - Date.now()) / 1000));

    try {
      await this.client.setEx(this.getKey(cacheKey), ttlSeconds, JSON.stringify(entry));
    } catch (error) {
      this.available = false;
      this.failureCount += 1;
      logger.warn('redis stream result cache write failed', { error });
    }
  }

  async close() {
    if (!this.client) {
      return;
    }

    try {
      await this.client.quit();
    } catch (error) {
      logger.warn('redis stream result cache close failed', { error });
    }
  }
}

const touchMapEntry = (map, key, value) => {
  map.delete(key);
  map.set(key, value);
};

const pruneMapByMaxEntries = (map, maxEntries) => {
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    return;
  }

  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;

    if (oldestKey === undefined) {
      break;
    }

    map.delete(oldestKey);
  }
};

const pruneMapByApproxBytes = (map, maxBytes, getEntryBytes = (entry) => entry?.approxBytes || 0) => {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || map.size === 0) {
    return;
  }

  let totalBytes = 0;

  for (const entry of map.values()) {
    totalBytes += Math.max(0, Number(getEntryBytes(entry)) || 0);
  }

  while (totalBytes > maxBytes && map.size > 0) {
    const oldestKey = map.keys().next().value;

    if (oldestKey === undefined) {
      break;
    }

    const oldestEntry = map.get(oldestKey);
    totalBytes -= Math.max(0, Number(getEntryBytes(oldestEntry)) || 0);
    map.delete(oldestKey);
  }
};
const HUBCLOUD_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const HUBCLOUD_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

const normalizeQualityKey = (quality) => {
  const normalized = String(quality || '').trim().toLowerCase();

  if (!normalized) {
    return 'unknown';
  }

  if (normalized.includes('2160') || normalized === '4k') {
    return '2160p';
  }

  if (normalized.includes('1440')) {
    return '1440p';
  }

  if (normalized.includes('1080')) {
    return '1080p';
  }

  if (normalized.includes('720')) {
    return '720p';
  }

  if (normalized.includes('480') || normalized.includes('sd') || normalized.includes('low hd')) {
    return '480p';
  }

  if (normalized.includes('360')) {
    return '360p';
  }

  if (normalized.includes('auto') || normalized.includes('adaptive') || normalized.includes('mid hd')) {
    return 'auto';
  }

  return 'unknown';
};

const getQualityPriorityScore = (stream, qualityPriority) => {
  const normalizedQuality = normalizeQualityKey(stream.quality);
  const index = qualityPriority.indexOf(normalizedQuality);

  if (index === -1) {
    return 0;
  }

  return (qualityPriority.length - index) * 10000;
};

const isHighValueCacheStream = (stream) => {
  const providerId = String(stream.provider || '').trim().toLowerCase();
  const text = [
    stream.name,
    stream.title,
    stream.sourceSite,
    stream.url,
    stream.filename
  ].map((value) => String(value || '')).join(' ');

  return normalizeQualityKey(stream.quality) === '2160p'
    || HIGH_VALUE_CACHE_PROVIDERS.has(providerId)
    || HIGH_VALUE_CACHE_PATTERN.test(text);
};

const shouldUseWeakResultCache = (streams) =>
  streams.length > 0 && !streams.some((stream) => isHighValueCacheStream(stream));

const shouldCacheEmptyFastResult = (result) =>
  result?.reason === 'all-complete';

const hasForwardHeaders = (headers) =>
  Boolean(headers && typeof headers === 'object' && Object.keys(headers).length > 0);

const isExtractorRedirectUrl = (streamUrl) => {
  try {
    const parsedUrl = new URL(String(streamUrl || '').trim());
    const hostname = parsedUrl.hostname.toLowerCase();
    return parsedUrl.searchParams.has('id') || EXTRACTOR_REDIRECT_HOST_PATTERN.test(hostname);
  } catch {
    return false;
  }
};

const isWebReadyHttpStream = (stream) =>
  stream.transport === 'http' &&
  Boolean(stream.url) &&
  (isPlainMp4Url(stream.url) || stream.behaviorHints?.notWebReady === false) &&
  !hasForwardHeaders(stream.headers);

const isAddonManagedHttpStream = (stream) =>
  stream.transport === 'http' &&
  Boolean(stream.url) &&
  isExtractorRedirectUrl(stream.url);

const isTrustedDirectHttpStream = (stream) =>
  stream.transport === 'http' &&
  Boolean(stream.url) &&
  !hasForwardHeaders(stream.headers) &&
  isHighValueCacheStream(stream);

const hasHeavyFormatTraits = (stream) => {
  const text = `${String(stream.name || '')} ${String(stream.title || '')}`.toLowerCase();
  return /\b(hevc|x265|10bit|hdr|hdr10|hdr10\+|dolby vision|dovi|remux|untouch)\b/u.test(text);
};

const parseSizeBytes = (value) => {
  const match = String(value || '').match(/(\d+(?:\.\d+)?)\s*(tb|gb|mb|kb|b)\b/i);

  if (!match) {
    return null;
  }

  const amount = Number.parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
    tb: 1024 * 1024 * 1024 * 1024
  }[unit];

  if (!Number.isFinite(amount) || !multiplier) {
    return null;
  }

  return Math.round(amount * multiplier);
};

const getStreamSizeBytes = (stream) => {
  const explicitSize = parseSizeBytes(stream.size);

  if (explicitSize) {
    return explicitSize;
  }

  return parseSizeBytes(`${String(stream.name || '')}\n${String(stream.title || '')}`);
};

const getStreamHostname = (stream) => {
  try {
    return new URL(String(stream.url || '').trim()).hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return '';
  }
};

const getExtractorRedirectEntryScore = (entry) => {
  const url = String(entry?.url || '').toLowerCase();
  const source = String(entry?.sourceSite || entry?.source || '').toLowerCase();
  let score = 0;

  if (url.includes('.m3u8')) {
    score += 500;
  } else if (url.includes('.mp4')) {
    score += 450;
  } else if (url.includes('pixeldrain')) {
    score += 400;
  } else if (url.includes('hub.') || url.includes('fsl') || url.includes('cdn.')) {
    score += 320;
  } else if (url.includes('hdstream4u')) {
    score += 260;
  }

  if (source.includes('pixeldrain')) {
    score += 120;
  } else if (source.includes('hubcdn')) {
    score += 110;
  } else if (source.includes('vidstack')) {
    score += 100;
  } else if (source.includes('fsl')) {
    score += 90;
  }

  if (entry?.headers && typeof entry.headers === 'object') {
    score += 10;
  }

  return score;
};

const toDiagnosticStreamExample = (stream) => ({
  name: stream.name || 'Untitled stream',
  quality: stream.quality || 'Unknown',
  host: getStreamHostname(stream) || 'Unknown host',
  size: stream.size || 'Unknown size'
});

const normalizeDedupeMode = (value) => {
  const normalized = String(value || '').trim().toLowerCase();

  if (normalized === 'smart' || normalized === 'filename' || normalized === 'host-quality') {
    return normalized;
  }

  return 'off';
};

const normalizeFilenameKey = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/u, '')
    .replace(/\[[^\]]+\]|\([^)]+\)/gu, ' ')
    .replace(/[_+.]+/g, ' ')
    .replace(/\b(2160p|1440p|1080p|720p|480p|360p|hevc|x265|x264|h264|hdr|hdr10\+?|dovi|dv|10bit|aac|atmos|web[- ]dl|webrip|bluray|multi)\b/gu, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const getExactUrlKey = (stream) => {
  if (!stream.url) {
    return '';
  }

  try {
    const parsedUrl = new URL(String(stream.url).trim());
    parsedUrl.hash = '';
    return `${parsedUrl.hostname.toLowerCase()}${parsedUrl.pathname}`;
  } catch {
    return String(stream.url || '').trim().toLowerCase();
  }
};

const getStreamDedupeKey = (stream, dedupeMode) => {
  if (stream.infoHash) {
    return `infohash:${String(stream.infoHash).toLowerCase()}`;
  }

  const qualityKey = normalizeQualityKey(stream.quality);
  const hostKey = getStreamHostname(stream);
  const filenameKey = normalizeFilenameKey(stream.filename || extractFilenameFromUrl(stream.url) || '');
  const sizeBytes = getStreamSizeBytes(stream);

  if (dedupeMode === 'filename') {
    return filenameKey ? `filename:${filenameKey}|${qualityKey}` : '';
  }

  if (dedupeMode === 'host-quality') {
    return hostKey ? `host-quality:${hostKey}|${qualityKey}` : '';
  }

  if (dedupeMode === 'smart') {
    if (filenameKey) {
      return `smart-filename:${filenameKey}|${qualityKey}`;
    }

    if (hostKey && sizeBytes) {
      return `smart-host-size:${hostKey}|${qualityKey}|${sizeBytes}`;
    }

    const exactUrlKey = getExactUrlKey(stream);

    if (exactUrlKey) {
      return `smart-url:${exactUrlKey}|${qualityKey}`;
    }
  }

  return '';
};

const applyConfiguredDedupe = (streams, streamOptions) => {
  const dedupeMode = normalizeDedupeMode(streamOptions.dedupeMode);

  if (dedupeMode === 'off' || streams.length <= 1) {
    return {
      streams,
      dedupeMode,
      removedCount: 0,
      examples: []
    };
  }

  const dedupedStreams = [];
  const seenKeys = new Set();
  let removedCount = 0;
  const examples = [];

  for (const stream of streams) {
    const dedupeKey = getStreamDedupeKey(stream, dedupeMode);

    if (!dedupeKey) {
      dedupedStreams.push(stream);
      continue;
    }

    if (seenKeys.has(dedupeKey)) {
      removedCount += 1;

       if (examples.length < 3) {
        examples.push(toDiagnosticStreamExample(stream));
      }
      continue;
    }

    seenKeys.add(dedupeKey);
    dedupedStreams.push(stream);
  }

  return {
    streams: dedupedStreams,
    dedupeMode,
    removedCount,
    examples
  };
};

const filterConfiguredStreamsDetailed = (streams, streamOptions) => {
  const filteredStreams = [];
  const diagnostics = {
    inputTotal: streams.length,
    keptTotal: 0,
    filteredTotal: 0,
    dedupedTotal: 0,
    dedupeMode: normalizeDedupeMode(streamOptions.dedupeMode),
    reasons: {
      nonHttp: 0,
      notWebReady: 0,
      heavyFormat: 0,
      tooLarge: 0,
      blockedHost: 0,
      languageMismatch: 0,
      duplicate: 0
    },
    examples: {
      nonHttp: [],
      notWebReady: [],
      heavyFormat: [],
      tooLarge: [],
      blockedHost: [],
      languageMismatch: [],
      duplicate: []
    }
  };
  const maxBytes = Number(streamOptions.maxSizeGb) > 0
    ? Number(streamOptions.maxSizeGb) * 1024 * 1024 * 1024
    : 0;
  const blockedHosts = Array.isArray(streamOptions.blockHosts)
    ? streamOptions.blockHosts.filter(Boolean)
    : [];

  for (const stream of streams) {
    let reason = null;

    if (stream.transport !== 'http') {
      reason = 'nonHttp';
    } else if (streamOptions.webReadyOnly && !isWebReadyHttpStream(stream) && !isTrustedDirectHttpStream(stream) && !isAddonManagedHttpStream(stream)) {
      reason = 'notWebReady';
    } else if (streamOptions.hideHeavyFormats && hasHeavyFormatTraits(stream)) {
      reason = 'heavyFormat';
    } else if (maxBytes > 0) {
      const sizeBytes = getStreamSizeBytes(stream);

      if (sizeBytes && sizeBytes > maxBytes) {
        reason = 'tooLarge';
      }
    }

    if (!reason && blockedHosts.length > 0) {
      const hostname = getStreamHostname(stream);

      if (hostname && blockedHosts.some((blockedHost) => hostname.includes(blockedHost))) {
        reason = 'blockedHost';
      }
    }

    if (reason) {
      diagnostics.filteredTotal += 1;
      diagnostics.reasons[reason] += 1;
      if (diagnostics.examples[reason].length < 3) {
        diagnostics.examples[reason].push(toDiagnosticStreamExample(stream));
      }
      continue;
    }

    filteredStreams.push(stream);
  }

  diagnostics.keptTotal = filteredStreams.length;

  return {
    streams: filteredStreams,
    diagnostics
  };
};

const filterConfiguredStreams = (streams, streamOptions) =>
  filterConfiguredStreamsDetailed(streams, streamOptions).streams;

const summarizeStreamOptions = (streamOptions) => {
  const parts = [];

  if (streamOptions.webReadyOnly) {
    parts.push('Web-ready only');
  }

  if (streamOptions.hideHeavyFormats) {
    parts.push('Hide HEVC / HDR / 10-bit');
  }

  if (Number(streamOptions.maxSizeGb) > 0) {
    parts.push(`Max ${Number(streamOptions.maxSizeGb)} GB`);
  }

  if (Array.isArray(streamOptions.blockHosts) && streamOptions.blockHosts.length > 0) {
    parts.push(`Block hosts: ${streamOptions.blockHosts.join(', ')}`);
  }

  if (streamOptions.preferredAudioLanguage) {
    parts.push(`Prefer audio: ${streamOptions.preferredAudioLanguage}`);
  }

  if (normalizeDedupeMode(streamOptions.dedupeMode) !== 'off') {
    const dedupeLabels = {
      smart: 'Smart dedupe',
      filename: 'Dedupe by filename',
      'host-quality': 'Dedupe by host + quality'
    };
    parts.push(dedupeLabels[normalizeDedupeMode(streamOptions.dedupeMode)] || 'Dedupe on');
  }

  if (streamOptions.preferHdr) {
    parts.push('Prefer HDR');
  }

  if (streamOptions.preferH264) {
    parts.push('Prefer H.264');
  }

  if (streamOptions.preferSmallerFiles) {
    parts.push('Prefer smaller files');
  }

  if (streamOptions.preferDirectHosts) {
    parts.push('Prefer direct hosts');
  }

  if (streamOptions.customProxyUrl) {
    parts.push('Custom proxy');
  }

  return parts.length > 0 ? parts.join(', ') : 'Default HTTP playback';
};

const normalizePrivateCookie = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  return trimmed.slice(0, PRIVATE_PROVIDER_COOKIE_MAX_LENGTH);
};

const normalizeCustomProxyUrl = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  try {
    const parsedUrl = new URL(trimmed);

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return null;
    }

    return parsedUrl.toString();
  } catch {
    return null;
  }
};

const matchesProxyPattern = (hostname, pattern) => {
  const normalizedHost = String(hostname || '').trim().toLowerCase();
  const normalizedPattern = String(pattern || '').trim().toLowerCase();

  if (!normalizedHost || !normalizedPattern) {
    return false;
  }

  if (normalizedPattern === '*') {
    return true;
  }

  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(1);
    return normalizedHost.endsWith(suffix);
  }

  if (!normalizedPattern.includes('*')) {
    return normalizedHost === normalizedPattern;
  }

  const escapedPattern = normalizedPattern
    .replace(/[.+?^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*/gu, '.*');
  const regex = new RegExp(`^${escapedPattern}$`, 'u');
  return regex.test(normalizedHost);
};

const getConfiguredProxyUrlForStream = (stream, customProxyUrl = null) => {
  const normalizedCustomProxyUrl = normalizeCustomProxyUrl(customProxyUrl);

  if (normalizedCustomProxyUrl) {
    return normalizedCustomProxyUrl;
  }

  if (!stream?.url || stream.transport !== 'http' || !Array.isArray(config.PROXY_CONFIG) || config.PROXY_CONFIG.length === 0) {
    return null;
  }

  try {
    const hostname = new URL(stream.url).hostname.toLowerCase();
    const matchedRule = config.PROXY_CONFIG.find((rule) => matchesProxyPattern(hostname, rule.pattern));
    return matchedRule?.proxyUrl || null;
  } catch {
    return null;
  }
};

const normalizePrivateProviderSettings = (value) => ({
  febboxUiCookie: normalizePrivateCookie(value?.febboxUiCookie),
  showboxOssGroup: normalizePrivateCookie(value?.showboxOssGroup)
});

const getPrivateProviderSettingsHash = (privateProviderSettings) => {
  const normalized = normalizePrivateProviderSettings(privateProviderSettings);

  if (!normalized.febboxUiCookie && !normalized.showboxOssGroup) {
    return null;
  }

  return createHash('sha1')
    .update(JSON.stringify(normalized))
    .digest('hex');
};

const buildCustomProxyStreamUrl = (stream, customProxyUrl) => {
  const normalizedProxyUrl = getConfiguredProxyUrlForStream(stream, customProxyUrl);

  if (!normalizedProxyUrl || !stream || !stream.url || stream.transport !== 'http') {
    return null;
  }

  const serializedHeaders = hasForwardHeaders(stream.headers)
    ? JSON.stringify(stream.headers)
    : '';

  if (normalizedProxyUrl.includes('{url}') || normalizedProxyUrl.includes('{headers}')) {
    return normalizedProxyUrl
      .replaceAll('{url}', encodeURIComponent(stream.url))
      .replaceAll('{headers}', encodeURIComponent(serializedHeaders));
  }

  try {
    const proxyUrl = new URL(normalizedProxyUrl);
    proxyUrl.searchParams.set('url', stream.url);

    if (serializedHeaders) {
      proxyUrl.searchParams.set('headers', serializedHeaders);
    }

    return proxyUrl.toString();
  } catch {
    return null;
  }
};

const buildAddonManagedStreamUrl = (stream, baseUrl) => {
  if (!baseUrl || !stream || stream.transport !== 'http' || !isExtractorRedirectUrl(stream.url)) {
    return null;
  }

  try {
    const streamUrl = new URL('/stream', baseUrl);
    streamUrl.searchParams.set('source', String(stream.url || '').trim());
    return streamUrl.toString();
  } catch {
    return null;
  }
};

const getDeliveryPriorityScore = (stream) => {
  if (stream.transport === 'http') {
    return hasForwardHeaders(stream.headers) ? -5000 : 5000;
  }

  if (stream.transport === 'torrent') {
    return -12000;
  }

  return 0;
};

const getProviderPriorityScore = (stream, providerOrder) => {
  if (!Array.isArray(providerOrder) || providerOrder.length === 0) {
    return 0;
  }

  const providerId = String(stream.provider || '').trim().toLowerCase();
  const index = providerOrder.indexOf(providerId);

  if (index === -1) {
    return 0;
  }

  return (providerOrder.length - index) * 1500;
};

const getProviderDiversityKey = (stream) => {
  const providerId = String(stream?.provider || 'default').trim().toLowerCase();
  return providerId === '4khdhub_tv' ? '4khdhub' : providerId;
};

const diversifyStreamsByProvider = (streams, { leadingCount = 5, softLimit = 6 } = {}) => {
  if (!Array.isArray(streams) || streams.length <= leadingCount) {
    return streams;
  }

  const output = [];
  const deferred = [];
  const providerCounts = new Map();

  for (const stream of streams) {
    const providerId = getProviderDiversityKey(stream);
    const currentCount = providerCounts.get(providerId) || 0;

    if (output.length < leadingCount || currentCount < softLimit) {
      output.push(stream);
      providerCounts.set(providerId, currentCount + 1);
    } else {
      deferred.push(stream);
    }
  }

  return output.concat(deferred);
};

const getStreamDiversityOptions = (streams, { requestedProviders = [] } = {}) => {
  if (!Array.isArray(streams) || streams.length === 0) {
    return { leadingCount: 5, softLimit: 6 };
  }

  if (Array.isArray(requestedProviders) && requestedProviders.length > 0) {
    return { leadingCount: 5, softLimit: 6 };
  }

  const fallbackProviderSet = new Set(['vidsrc', 'vixsrc', 'cinestream', 'vidlink', 'moviebox']);
  const hasFallbackProviders = streams.some((stream) =>
    fallbackProviderSet.has(String(stream.provider || '').trim().toLowerCase())
  );
  const providerFamilyCounts = new Map();

  for (const stream of streams) {
    const providerKey = getProviderDiversityKey(stream);
    providerFamilyCounts.set(providerKey, (providerFamilyCounts.get(providerKey) || 0) + 1);
  }

  const providerFamilyCount = providerFamilyCounts.size;
  const dominantFamilyCount = Math.max(...providerFamilyCounts.values());

  if (hasFallbackProviders) {
    return { leadingCount: 3, softLimit: 2 };
  }

  if (providerFamilyCount >= 2 && dominantFamilyCount >= 4) {
    return { leadingCount: 2, softLimit: 2 };
  }

  return { leadingCount: 5, softLimit: 6 };
};

const fetchTextWithTimeout = async (url, options = {}, timeout = 8000) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.text();
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
};

const stripHtml = (html) =>
  String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#8211;|&#8212;/gi, '-')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/\s+/g, ' ')
    .trim();

const extractHubCloudAnchorCandidates = (html) => {
  const candidates = [];
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorPattern.exec(html)) !== null) {
    const href = String(match[1] || '').replace(/&amp;/g, '&').trim();
    const text = stripHtml(match[2]);

    if (!href || !/^https?:\/\//i.test(href)) {
      continue;
    }

    candidates.push({ href, text });
  }

  return candidates;
};

const getHubCloudCandidateScore = ({ href, text }) => {
  const normalizedHref = href.toLowerCase();
  const normalizedText = text.toLowerCase();
  let score = 0;

  if (normalizedText.includes('pdl') || normalizedHref.includes('workers.dev')) {
    score += 500;
  }

  if (normalizedText.includes('pixel') || normalizedText.includes('10gbps') || normalizedHref.includes('pixel.')) {
    score += 400;
  }

  if (normalizedText.includes('fslv2')) {
    score += 250;
  } else if (normalizedText.includes('fsl')) {
    score += 220;
  }

  if (normalizedHref.includes('hubcloud') || normalizedHref.includes('gamerxyt.com')) {
    score -= 300;
  }

  return score;
};

const classifyHubCloudCandidate = ({ href, text }) => {
  const normalizedHref = String(href || '').toLowerCase();
  const normalizedText = String(text || '').toLowerCase();

  if (normalizedText.includes('fslv2')) {
    return 'FSLv2';
  }

  if (normalizedText.includes('fsl')) {
    return 'FSL';
  }

  if (normalizedText.includes('pixelserver') || normalizedText.includes('pixel') || normalizedHref.includes('pixeldrain')) {
    return 'PixelServer';
  }

  if (normalizedText.includes('pdl') || normalizedHref.includes('workers.dev')) {
    return 'PDL';
  }

  return 'Download';
};

const parseHubCloudTitle = (html) => {
  const explicitTitleMatch = html.match(/<div class="card-header[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (explicitTitleMatch?.[1]) {
    return stripHtml(explicitTitleMatch[1]);
  }

  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  return titleMatch?.[1] ? stripHtml(titleMatch[1]) : null;
};

const parseHubCloudSize = (html) => {
  const sizeMatch = html.match(/id=["']size["'][^>]*>([\s\S]*?)</i);
  return sizeMatch?.[1] ? stripHtml(sizeMatch[1]) : null;
};

const isHubCloudUrl = (streamUrl) => {
  try {
    return new URL(String(streamUrl || '').trim()).hostname.toLowerCase().includes('hubcloud');
  } catch {
    return false;
  }
};

const getStreamSearchText = (stream) =>
  `${String(stream.name || '')} ${String(stream.title || '')} ${String(stream.filename || '')} ${String(stream.language || '')}`.toLowerCase();

const getVisualTags = (stream) => {
  const text = getStreamSearchText(stream);
  const tags = [];

  if (text.includes('dolby vision') || text.includes('dovi')) {
    tags.push('DV');
  }

  if (text.includes('hdr10+')) {
    tags.push('HDR10+');
  } else if (text.includes('hdr10')) {
    tags.push('HDR10');
  } else if (text.includes('hdr')) {
    tags.push('HDR');
  }

  if (text.includes('imax')) {
    tags.push('IMAX');
  }

  if (text.includes('remux')) {
    tags.push('Remux');
  }

  if (text.includes('web-dl')) {
    tags.push('WEB-DL');
  } else if (text.includes('webrip')) {
    tags.push('WEBRip');
  } else if (text.includes('bluray') || text.includes('blu-ray')) {
    tags.push('BluRay');
  }

  return tags.filter((tag, index, list) => list.indexOf(tag) === index);
};

const getEncodeTags = (stream) => {
  const text = getStreamSearchText(stream);
  const tags = [];

  if (text.includes('hevc') || text.includes('x265') || text.includes('h265')) {
    tags.push('HEVC');
  } else if (text.includes('x264') || text.includes('h264')) {
    tags.push('H.264');
  }

  if (text.includes('10bit') || text.includes('10-bit')) {
    tags.push('10-bit');
  }

  return tags;
};

const getAudioTags = (stream) => {
  const text = getStreamSearchText(stream);
  const tags = [];

  if (text.includes('truehd')) {
    tags.push('TrueHD');
  }

  if (text.includes('atmos')) {
    tags.push('Atmos');
  }

  if (text.includes('ddp') || text.includes('dd+')) {
    tags.push('DD+');
  } else if (/\bdd\b/u.test(text)) {
    tags.push('DD');
  }

  if (text.includes('dts-hd')) {
    tags.push('DTS-HD');
  } else if (/\bdts\b/u.test(text)) {
    tags.push('DTS');
  }

  if (text.includes('aac')) {
    tags.push('AAC');
  }

  return tags.filter((tag, index, list) => list.indexOf(tag) === index);
};

const getCompactTags = (stream) => {
  const text = `${String(stream.name || '')} ${String(stream.title || '')}`.toLowerCase();
  const tags = [];

  if (text.includes('hdr10+') || text.includes('hdr10')) {
    tags.push('HDR10+');
  } else if (text.includes('hdr')) {
    tags.push('HDR');
  }

  if (text.includes('dolby vision') || text.includes('dovi')) {
    tags.push('Dolby Vision');
  }

  if (text.includes('web-dl') || text.includes('webrip')) {
    tags.push('WEB-DL');
  } else if (text.includes('bluray') || text.includes('blu-ray')) {
    tags.push('BluRay');
  }

  if (text.includes('hevc') || text.includes('x265')) {
    tags.push('hevc');
  } else if (text.includes('x264') || text.includes('h264')) {
    tags.push('h264');
  }

  if (text.includes('atmos')) {
    tags.push('Atmos');
  } else if (text.includes('aac')) {
    tags.push('AAC');
  }

  return tags;
};

const getTransportLabel = (stream) => {
  if (stream.transport === 'torrent' || stream.magnet || stream.torrent) {
    return 'P2P';
  }

  if (stream.transport === 'http') {
    return hasForwardHeaders(stream.headers) ? 'WEB PROXY' : 'WEB';
  }

  return 'EXT';
};

const truncateCardLine = (value, maxLength = 120) => {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trim()}…`;
};

const getStreamFilenameLabel = (stream) => {
  const filename = truncateCardLine(stream.filename || extractFilenameFromUrl(stream.url) || '');

  if (filename) {
    return filename;
  }

  const titleLine = String(stream.title || stream.name || '')
    .split('\n')
    .map((line) => truncateCardLine(line))
    .find(Boolean);
  return titleLine || null;
};

const getStreamSizeLabel = (stream) => {
  const explicitSize = truncateCardLine(stream.size || '');

  if (explicitSize) {
    return explicitSize;
  }

  const sizeMatch = `${String(stream.title || '')}\n${String(stream.name || '')}`.match(/\b\d+(?:\.\d+)?\s*(?:tb|gb|mb|kb)\b/iu);
  return sizeMatch ? sizeMatch[0].replace(/\s+/g, ' ') : null;
};

const AUDIO_LANGUAGE_PATTERNS = Object.freeze([
  ['Hindi', /\bhindi\b/u],
  ['English', /\benglish\b/u],
  ['Tamil', /\btamil\b/u],
  ['Telugu', /\btelugu\b/u],
  ['Malayalam', /\bmalayalam\b/u],
  ['Kannada', /\bkannada\b/u],
  ['French', /\bfrench\b/u],
  ['German', /\bgerman\b/u],
  ['Latino', /\b(?:latino|lat)\b/u],
  ['Spanish', /\b(?:spanish|espanol|español|castellano|esp)\b/u],
  ['Arabic', /(?:\barabic\b|\barab\b|عربي|مدبلج|مترجم)/u],
  ['Portuguese', /\bportuguese\b/u],
  ['Japanese', /\bjapanese\b/u],
  ['Korean', /\bkorean\b/u],
  ['Turkish', /\b(?:turkish|turkce|türkçe|tr)\b/u],
  ['Italian', /\b(?:italian|italiano|ita)\b/u]
]);

const normalizeAudioLanguageKey = (value) => {
  const normalized = String(value || '').trim().toLowerCase();

  if (!normalized || normalized === 'any' || normalized === 'unknown') {
    return null;
  }

  const matched = AUDIO_LANGUAGE_PATTERNS.find(([label]) => label.toLowerCase() === normalized);
  return matched ? matched[0] : null;
};

const getStreamLanguages = (stream) => {
  const text = getStreamSearchText(stream);
  const languages = [];

  for (const [label, pattern] of AUDIO_LANGUAGE_PATTERNS) {
    if (pattern.test(text)) {
      languages.push(label);
    }
  }

  return [...new Set(languages)];
};

const getLanguageLabel = (stream) => {
  const languages = getStreamLanguages(stream);

  if (languages.length === 0) {
    return 'Unknown';
  }

  return [...new Set(languages)].join(' + ');
};

const getSourceLabel = (stream) => {
  if (stream.sourceSite) {
    return stream.sourceSite;
  }

  return toTitleCaseLabel(stream.provider || 'default');
};

const dedupeCardTags = (values) =>
  values.filter((value, index, list) => value && list.indexOf(value) === index);

const getTorrentioStyleTechTags = (stream) => dedupeCardTags([
  ...getVisualTags(stream),
  ...getEncodeTags(stream),
  ...getAudioTags(stream)
]);

const getPreferredAudioLanguageScore = (stream, streamOptions) => {
  const preferredAudioLanguage = normalizeAudioLanguageKey(streamOptions.preferredAudioLanguage);

  if (!preferredAudioLanguage) {
    return 0;
  }

  const languages = getStreamLanguages(stream);

  if (languages.includes(preferredAudioLanguage)) {
    return 7000;
  }

  if (languages.length === 0) {
    return 1500;
  }

  return 0;
};

const getStreamPreferenceScore = (stream, streamOptions) => {
  const text = `${String(stream.name || '')} ${String(stream.title || '')}`.toLowerCase();
  let score = 0;

  if (streamOptions.preferHdr) {
    if (/\b(hdr|hdr10|hdr10\+|dolby vision|dovi)\b/u.test(text)) {
      score += 4500;
    }
  }

  if (streamOptions.preferH264) {
    if (/\b(h264|x264)\b/u.test(text)) {
      score += 4200;
    } else if (/\b(hevc|x265)\b/u.test(text)) {
      score -= 500;
    }
  }

  if (streamOptions.preferSmallerFiles) {
    const sizeBytes = getStreamSizeBytes(stream);

    if (sizeBytes) {
      const sizeGb = sizeBytes / (1024 * 1024 * 1024);
      score += Math.max(0, 4000 - Math.round(sizeGb * 350));
    }
  }

  if (streamOptions.preferDirectHosts) {
    if (stream.transport === 'http' && !hasForwardHeaders(stream.headers)) {
      score += 3800;
    }
  }

  return score;
};

const formatTorrentioStyleDescription = (stream) => {
  const qualityLabel = getStremioCardQualityLabel(stream);
  const size = getStreamSizeLabel(stream);
  const languageLabel = getLanguageLabel(stream);
  const sourceLabel = getSourceLabel(stream);
  const transportLabel = getTransportLabel(stream);
  const techTags = getTorrentioStyleTechTags(stream);
  const primaryFacts = [
    qualityLabel || null,
    size ? `💾 ${size}` : null,
    languageLabel !== 'Unknown' ? `🌐 ${languageLabel}` : null,
    sourceLabel ? `🔗 ${sourceLabel}` : null
  ].filter(Boolean).join(' • ');
  const secondaryFacts = [
    transportLabel ? `⚙️ ${transportLabel}` : null,
    ...techTags
  ].filter(Boolean).join(' • ');

  return [primaryFacts, secondaryFacts]
    .filter(Boolean)
    .map((line) => truncateCardLine(line, 140))
    .join('\n');
};

const formatStremioCardTitle = (stream) => {
  const filename = getStreamFilenameLabel(stream);
  const titleFirstLine = String(stream.title || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
  const qualityLabel = getStremioCardQualityLabel(stream);
  const fallbackLabel = [getSourceLabel(stream), qualityLabel].filter(Boolean).join(' ');
  const primaryLine = truncateCardLine(titleFirstLine || filename || fallbackLabel, 140);
  const detailsLine = formatTorrentioStyleDescription(stream);

  return [primaryLine, detailsLine].filter(Boolean).join('\n');
};

const getStremioCardQualityLabel = (stream) => {
  const normalizedQuality = normalizeQualityKey(stream.quality);
  return normalizedQuality === '2160p'
    ? '4K'
    : normalizedQuality === 'unknown'
      ? String(stream.quality || '').trim().toUpperCase() || null
      : normalizedQuality.toUpperCase();
};

const formatStremioCardFlags = (stream) => {
  const languages = getStreamLanguages(stream);
  if (languages.length === 0) {
    return '';
  }

  return [...new Set(
    languages
      .map((language) => LANGUAGE_FLAG_MAP[language] || null)
      .filter(Boolean)
  )].join(' ');
};

const extractFilenameFromUrl = (streamUrl) => {
  try {
    const parsedUrl = new URL(String(streamUrl || '').trim());
    const filename = decodeURIComponent(parsedUrl.pathname.split('/').pop() || '').trim();
    return filename || undefined;
  } catch {
    return undefined;
  }
};

const isPlainMp4Url = (streamUrl) => {
  try {
    const parsedUrl = new URL(String(streamUrl || '').trim());
    return parsedUrl.protocol === 'https:' && parsedUrl.pathname.toLowerCase().endsWith('.mp4');
  } catch {
    return false;
  }
};

const getTorrentSources = (magnet) => {
  try {
    const parsedUrl = new URL(String(magnet || '').trim());
    const trackers = parsedUrl.searchParams.getAll('tr')
      .map((trackerUrl) => trackerUrl.trim())
      .filter((trackerUrl) => /^https?:\/\/|^udp:\/\//u.test(trackerUrl))
      .map((trackerUrl) => `tracker:${trackerUrl}`);

    return trackers.filter((source, index) => trackers.indexOf(source) === index);
  } catch {
    return [];
  }
};

const toStremioStreamObject = (stream, parsedRequest, streamOptions = DEFAULT_STREAM_OPTIONS, baseUrl = null) => {
  const qualityLabel = getStremioCardQualityLabel(stream);
  const flags = formatStremioCardFlags(stream);
  const detailedTitle = formatStremioCardTitle(stream);
  const techTags = getTorrentioStyleTechTags(stream).slice(0, 3);
  const namePrefix = [config.STREMIO_ADDON_NAME, flags || null, qualityLabel || null].filter(Boolean).join(' ');
  const name = truncateCardLine([namePrefix, ...techTags].filter(Boolean).join(' • '), 90);
  const base = {
    name,
    title: detailedTitle,
    description: formatTorrentioStyleDescription(stream),
    behaviorHints: {
      bingeGroup: parsedRequest.mediaType === 'series'
        ? `${parsedRequest.imdbId}:${stream.provider || 'default'}:${stream.quality || 'unknown'}`
        : undefined
    }
  };

  if (stream.transport === 'torrent' && stream.magnet) {
    const infoHash = extractInfoHash(stream.magnet);

    if (!infoHash) {
      return null;
    }

    const sources = getTorrentSources(stream.magnet);

    return {
      ...base,
      infoHash,
      ...(sources.length > 0 ? { sources } : {})
    };
  }

  if (!stream.url) {
    return null;
  }

  const proxiedUrl = buildCustomProxyStreamUrl(stream, streamOptions.customProxyUrl);
  const addonManagedUrl = proxiedUrl ? null : buildAddonManagedStreamUrl(stream, baseUrl);
  const requestHeaders = (proxiedUrl || addonManagedUrl) ? null : hasForwardHeaders(stream.headers) ? { ...stream.headers } : null;
  const streamUrl = proxiedUrl || addonManagedUrl || stream.url;
  const isWebReady = (proxiedUrl || addonManagedUrl) ? true : isWebReadyHttpStream(stream);
  const filenameSourceUrl = addonManagedUrl ? stream.url : streamUrl;
  const derivedFilename = stream.filename || extractFilenameFromUrl(filenameSourceUrl);

  return {
    ...base,
    url: streamUrl,
    ...(derivedFilename ? { filename: derivedFilename } : {}),
    behaviorHints: {
      ...base.behaviorHints,
      notWebReady: !isWebReady,
      ...(requestHeaders ? {
        proxyHeaders: {
          request: requestHeaders
        }
      } : {})
    }
  };
};

export class HttpError extends Error {
  constructor(statusCode, message, details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const createHttpError = (statusCode, message, details) =>
  new HttpError(statusCode, message, details);

export const parseRangeHeader = (rangeHeader, totalSize) => {
  if (!rangeHeader) {
    return {
      start: 0,
      end: totalSize - 1,
      contentLength: totalSize,
      statusCode: 200,
      contentRange: null
    };
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());

  if (!match) {
    throw createHttpError(416, 'Only single byte ranges are supported');
  }

  const [, rawStart, rawEnd] = match;

  if (rawStart === '' && rawEnd === '') {
    throw createHttpError(416, 'Invalid range header');
  }

  let start = rawStart === '' ? null : Number.parseInt(rawStart, 10);
  let end = rawEnd === '' ? null : Number.parseInt(rawEnd, 10);

  if ((start !== null && Number.isNaN(start)) || (end !== null && Number.isNaN(end))) {
    throw createHttpError(416, 'Invalid range header');
  }

  if (start === null) {
    const suffixLength = end;

    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      throw createHttpError(416, 'Invalid suffix range');
    }

    start = Math.max(totalSize - suffixLength, 0);
    end = totalSize - 1;
  } else {
    end = end ?? totalSize - 1;
  }

  if (start < 0 || end < 0 || start > end || start >= totalSize) {
    throw createHttpError(416, 'Requested range is not satisfiable');
  }

  end = Math.min(end, totalSize - 1);

  return {
    start,
    end,
    contentLength: end - start + 1,
    statusCode: 206,
    contentRange: `bytes ${start}-${end}/${totalSize}`
  };
};

export class StreamManager {
  constructor({ torrentEngine, httpProxy, cacheManager, sourceRegistry, providerService, imdbResolver, userTracker = null }) {
    this.torrentEngine = torrentEngine;
    this.httpProxy = httpProxy;
    this.cacheManager = cacheManager;
    this.sourceRegistry = sourceRegistry;
    this.providerService = providerService;
    this.imdbResolver = imdbResolver;
    this.userTracker = userTracker;
    this.activeStreams = 0;
    this.stremioResultCache = new Map();
    this.stremioResultInFlight = new Map();
    this.stremioBackgroundRefreshes = new Set();
    this.stremioBackgroundRefreshQueue = [];
    this.activeStremioBackgroundRefreshes = 0;
    this.stremioResultCacheDir = cacheConfig.STREMIO_RESULT_CACHE_DIR;
    this.stremioResultCacheDirReady = null;
    this.privateConfigDir = path.join(config.CACHE_DIR, 'private-configs');
    this.privateConfigDirReady = null;
    this.privateConfigStore = new Map();
    this.redisStreamResultCache = new RedisStreamResultCache();
    this.hubCloudCache = new Map();
    this.hubCloudInFlight = new Map();
    this.extractorRedirectCache = new Map();
    this.extractorRedirectInFlight = new Map();
    this.loadSheddingUntil = 0;
    this.loadSheddingReason = null;
    this.popularStreamPrewarmTimer = null;
    this.popularStreamPrewarmInitialTimer = null;
    this.popularStreamPrewarmRunning = false;
    this.popularStreamPrewarmLastStartedAt = null;
    this.popularStreamPrewarmLastFinishedAt = null;
    this.popularStreamPrewarmLastError = null;
    this.popularStreamPrewarmLastResultCount = 0;
  }

  async initialize() {
    await this.ensureStremioResultCacheDir();
    await this.ensurePrivateConfigDir();
    await this.redisStreamResultCache.initialize();
    setTimeout(() => {
      this.loadPrivateConfigs().catch((error) => {
        logger.warn('private config background load failed', { error });
      });
    }, 0).unref?.();
    this.startPopularStreamPrewarm();
  }

  async close() {
    if (this.popularStreamPrewarmTimer) {
      clearInterval(this.popularStreamPrewarmTimer);
      this.popularStreamPrewarmTimer = null;
    }

    if (this.popularStreamPrewarmInitialTimer) {
      clearTimeout(this.popularStreamPrewarmInitialTimer);
      this.popularStreamPrewarmInitialTimer = null;
    }

    this.stremioBackgroundRefreshQueue = [];
    this.stremioBackgroundRefreshes.clear();
    await this.redisStreamResultCache.close();
  }

  getStats() {
    return {
      activeStreams: this.activeStreams,
      maxActiveStreams: config.MAX_ACTIVE_STREAMS,
      stremioResultCacheEntries: this.stremioResultCache.size,
      stremioResultInFlight: this.stremioResultInFlight.size,
      maxStremioResultInFlight: config.STREMIO_MAX_INFLIGHT_SEARCHES,
      stremioBackgroundRefreshActive: this.activeStremioBackgroundRefreshes,
      stremioBackgroundRefreshQueued: this.stremioBackgroundRefreshQueue.length,
      stremioBackgroundRefreshTracked: this.stremioBackgroundRefreshes.size,
      maxStremioBackgroundRefreshQueue: config.STREMIO_BACKGROUND_REFRESH_QUEUE_MAX,
      redisStreamResultCache: this.redisStreamResultCache.getStats(),
      hubCloudCacheEntries: this.hubCloudCache.size,
      hubCloudInFlight: this.hubCloudInFlight.size,
      extractorRedirectCacheEntries: this.extractorRedirectCache.size,
      extractorRedirectInFlight: this.extractorRedirectInFlight.size,
      popularStreamPrewarm: {
        enabled: Boolean(config.POPULAR_STREAM_PREWARM_ENABLED && this.userTracker && config.PUBLIC_BASE_URL),
        running: this.popularStreamPrewarmRunning,
        intervalSeconds: config.POPULAR_STREAM_PREWARM_INTERVAL_SECONDS,
        limit: config.POPULAR_STREAM_PREWARM_LIMIT,
        lastStartedAt: this.popularStreamPrewarmLastStartedAt,
        lastFinishedAt: this.popularStreamPrewarmLastFinishedAt,
        lastError: this.popularStreamPrewarmLastError,
        lastResultCount: this.popularStreamPrewarmLastResultCount
      },
      loadSheddingUntil: this.loadSheddingUntil,
      loadSheddingReason: this.loadSheddingReason
    };
  }

  enableLoadShedding({ durationMs, reason }) {
    this.loadSheddingUntil = Math.max(this.loadSheddingUntil, Date.now() + durationMs);
    this.loadSheddingReason = reason || 'memory-pressure';
    this.stremioBackgroundRefreshQueue = [];
    this.stremioBackgroundRefreshes.clear();
  }

  isLoadShedding() {
    if (this.loadSheddingUntil <= Date.now()) {
      this.loadSheddingReason = null;
      return false;
    }

    return true;
  }

  async waitForStremioResultSlot({ resultCacheKey, tmdbId, mediaType }) {
    if (this.stremioResultInFlight.size < config.STREMIO_MAX_INFLIGHT_SEARCHES) {
      return true;
    }

    if (config.STREMIO_INFLIGHT_SLOT_WAIT_MS <= 0) {
      return false;
    }

    const deadline = Date.now() + config.STREMIO_INFLIGHT_SLOT_WAIT_MS;
    logger.warn('stremio stream search waiting for in-flight slot', {
      inFlightSearches: this.stremioResultInFlight.size,
      maxInFlightSearches: config.STREMIO_MAX_INFLIGHT_SEARCHES,
      waitMs: config.STREMIO_INFLIGHT_SLOT_WAIT_MS,
      tmdbId,
      mediaType
    });

    while (this.stremioResultInFlight.size >= config.STREMIO_MAX_INFLIGHT_SEARCHES) {
      if (this.stremioResultInFlight.has(resultCacheKey)) {
        return true;
      }

      const remainingMs = deadline - Date.now();

      if (remainingMs <= 0) {
        return false;
      }

      const activeRequests = Array.from(this.stremioResultInFlight.values());

      if (activeRequests.length === 0) {
        return true;
      }

      await Promise.race([
        Promise.race(activeRequests.map((request) => request.catch(() => undefined))),
        delay(Math.min(remainingMs, 500))
      ]);
    }

    return true;
  }

  handleMemoryPressure({ critical = false } = {}) {
    if (critical) {
      this.stremioResultCache.clear();
      this.hubCloudCache.clear();
      this.extractorRedirectCache.clear();
      this.stremioBackgroundRefreshQueue = [];
      this.stremioBackgroundRefreshes.clear();
      return;
    }

    pruneMapByMaxEntries(this.stremioResultCache, Math.max(50, Math.floor(config.STREMIO_RESULT_MEMORY_CACHE_MAX_ENTRIES / 4)));
    pruneMapByApproxBytes(this.stremioResultCache, Math.max(512 * 1024, Math.floor((config.STREMIO_RESULT_MEMORY_CACHE_MAX_MB * 1024 * 1024) / 4)));
    pruneMapByMaxEntries(this.hubCloudCache, Math.max(20, Math.floor(config.HUBCLOUD_MEMORY_CACHE_MAX_ENTRIES / 4)));
    pruneMapByApproxBytes(this.hubCloudCache, Math.max(128 * 1024, Math.floor((config.HUBCLOUD_MEMORY_CACHE_MAX_MB * 1024 * 1024) / 4)));
    pruneMapByMaxEntries(this.extractorRedirectCache, Math.max(20, Math.floor(EXTRACTOR_REDIRECT_CACHE_MAX_ENTRIES / 4)));
    if (this.stremioBackgroundRefreshQueue.length > 0) {
      const keep = Math.max(0, Math.floor(config.STREMIO_BACKGROUND_REFRESH_QUEUE_MAX / 4));
      if (this.stremioBackgroundRefreshQueue.length > keep) {
        this.stremioBackgroundRefreshQueue = this.stremioBackgroundRefreshQueue.slice(0, keep);
      }
    }
  }

  getProviderLiveLoad() {
    if (!this.providerService || typeof this.providerService.getLiveLoad !== 'function') {
      return {
        inFlightRequests: 0,
        activeProviderExecutions: 0
      };
    }

    return this.providerService.getLiveLoad();
  }

  shouldSkipBackgroundRefresh() {
    if (this.isLoadShedding()) {
      return true;
    }

    const providerLoad = this.getProviderLiveLoad();
    return this.stremioResultInFlight.size >= config.STREMIO_BACKGROUND_REFRESH_MAX_INFLIGHT_SEARCHES
      || providerLoad.activeProviderExecutions >= config.STREMIO_BACKGROUND_REFRESH_MAX_PROVIDER_EXECUTIONS;
  }

  shouldSkipPopularPrewarm() {
    if (this.isLoadShedding()) {
      return true;
    }

    const providerLoad = this.getProviderLiveLoad();
    return this.stremioResultInFlight.size >= config.POPULAR_STREAM_PREWARM_MAX_INFLIGHT_SEARCHES
      || providerLoad.activeProviderExecutions >= config.POPULAR_STREAM_PREWARM_MAX_PROVIDER_EXECUTIONS;
  }

  startPopularStreamPrewarm() {
    if (!config.POPULAR_STREAM_PREWARM_ENABLED || !this.userTracker || !config.PUBLIC_BASE_URL || this.popularStreamPrewarmTimer) {
      return;
    }

    const runPrewarm = () => {
      this.prewarmPopularStreams().catch((error) => {
        this.popularStreamPrewarmLastError = error?.message || String(error);
        logger.warn('popular stream prewarm failed', { error });
      });
    };

    const intervalMs = config.POPULAR_STREAM_PREWARM_INTERVAL_SECONDS * 1000;
    this.popularStreamPrewarmInitialTimer = setTimeout(runPrewarm, Math.min(60_000, intervalMs));
    this.popularStreamPrewarmInitialTimer.unref();
    this.popularStreamPrewarmTimer = setInterval(runPrewarm, intervalMs);
    this.popularStreamPrewarmTimer.unref();
  }

  async prewarmPopularStreams() {
    if (this.popularStreamPrewarmRunning || this.shouldSkipPopularPrewarm()) {
      return;
    }

    const popularSearches = this.userTracker.getPopularStreamSearches({
      limit: config.POPULAR_STREAM_PREWARM_LIMIT,
      maxAgeHours: config.POPULAR_STREAM_PREWARM_MAX_AGE_HOURS
    });

    if (popularSearches.length === 0) {
      return;
    }

    this.popularStreamPrewarmRunning = true;
    this.popularStreamPrewarmLastStartedAt = new Date().toISOString();
    this.popularStreamPrewarmLastError = null;
    let refreshedCount = 0;

    try {
      for (const search of popularSearches) {
        if (this.shouldSkipPopularPrewarm()) {
          break;
        }

        const resultCacheKey = this.buildStremioResultCacheKey({
          tmdbId: search.tmdbId,
          mediaType: search.mediaType,
          season: search.season,
          episode: search.episode,
          providers: search.providers,
          qualityPriority: search.qualityPriority,
          streamOptions: search.streamOptions,
          publicBaseUrl: config.PUBLIC_BASE_URL || null
        });
        const cachedResult = await this.getCachedStremioStreams(resultCacheKey);

        if (cachedResult?.state === 'fresh') {
          continue;
        }

        await this.getOrBuildStremioStreams({
          resultCacheKey,
          baseUrl: config.PUBLIC_BASE_URL,
          parsed: {
            imdbId: search.imdbId || String(search.tmdbId),
            mediaType: search.mediaType,
            season: search.season,
            episode: search.episode
          },
          requestedProviders: search.providers,
          qualityPriority: search.qualityPriority,
          streamOptions: search.streamOptions,
          tmdbId: search.tmdbId
        });
        refreshedCount += 1;
      }

      this.popularStreamPrewarmLastResultCount = refreshedCount;
      this.popularStreamPrewarmLastFinishedAt = new Date().toISOString();
      logger.info('popular stream prewarm finished', {
        checkedCount: popularSearches.length,
        refreshedCount
      });
    } catch (error) {
      this.popularStreamPrewarmLastError = error?.message || String(error);
      throw error;
    } finally {
      this.popularStreamPrewarmRunning = false;
    }
  }

  async ensureStremioResultCacheDir() {
    if (!this.stremioResultCacheDirReady) {
      this.stremioResultCacheDirReady = mkdir(this.stremioResultCacheDir, { recursive: true });
    }

    await this.stremioResultCacheDirReady;
  }

  async ensurePrivateConfigDir() {
    if (!this.privateConfigDirReady) {
      this.privateConfigDirReady = mkdir(this.privateConfigDir, { recursive: true });
    }

    await this.privateConfigDirReady;
  }

  normalizePrivateConfigRecord(payload) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const providers = this.providerService.normalizeProviders(payload.providers);
    const requestedQualityPriority = Array.isArray(payload.qualityPriority)
      ? payload.qualityPriority
        .map((value) => normalizeQualityKey(value))
        .filter(Boolean)
      : [];
    const qualityPriority = requestedQualityPriority.filter((quality, index) =>
      requestedQualityPriority.indexOf(quality) === index
    );

    for (const quality of DEFAULT_QUALITY_PRIORITY) {
      if (!qualityPriority.includes(quality)) {
        qualityPriority.push(quality);
      }
    }

    const baseStreamOptions = payload.streamOptions && typeof payload.streamOptions === 'object'
      ? payload.streamOptions
      : {};
    const streamOptions = {
      webReadyOnly: Boolean(baseStreamOptions.webReadyOnly),
      hideHeavyFormats: Boolean(baseStreamOptions.hideHeavyFormats),
      maxSizeGb: Number.isFinite(Number(baseStreamOptions.maxSizeGb)) && Number(baseStreamOptions.maxSizeGb) > 0
        ? Number(baseStreamOptions.maxSizeGb)
        : 0,
      blockHosts: Array.isArray(baseStreamOptions.blockHosts)
        ? baseStreamOptions.blockHosts
          .map((value) => String(value || '').trim().toLowerCase())
          .filter(Boolean)
          .filter((value, index, values) => values.indexOf(value) === index)
        : [],
      preferredAudioLanguage: normalizeAudioLanguageKey(baseStreamOptions.preferredAudioLanguage),
      dedupeMode: normalizeDedupeMode(baseStreamOptions.dedupeMode),
      preferHdr: Boolean(baseStreamOptions.preferHdr),
      preferH264: Boolean(baseStreamOptions.preferH264),
      preferSmallerFiles: Boolean(baseStreamOptions.preferSmallerFiles),
      preferDirectHosts: Boolean(baseStreamOptions.preferDirectHosts),
      customProxyUrl: normalizeCustomProxyUrl(baseStreamOptions.customProxyUrl)
    };
    const privateProviderSettings = normalizePrivateProviderSettings(payload.privateProviderSettings);
    const profileCode = typeof payload.profileCode === 'string'
      ? payload.profileCode.trim().toLowerCase()
      : null;

    return {
      version: PRIVATE_CONFIG_VERSION,
      providers,
      qualityPriority,
      streamOptions,
      privateProviderSettings,
      profileCode: profileCode && CONFIGURED_PROFILE_LABELS[profileCode] ? profileCode : null,
      updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : new Date().toISOString()
    };
  }

  getPrivateConfigPath(configId) {
    return path.join(this.privateConfigDir, `${configId}.json`);
  }

  async loadPrivateConfigs() {
    try {
      await this.ensurePrivateConfigDir();
      const entries = await readdir(this.privateConfigDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
          continue;
        }

        const configId = entry.name.slice(0, -'.json'.length);

        try {
          const payload = JSON.parse(await readFile(this.getPrivateConfigPath(configId), 'utf8'));
          const normalized = this.normalizePrivateConfigRecord(payload);

          if (normalized) {
            this.privateConfigStore.set(configId, normalized);
          }
        } catch (error) {
          logger.warn('private config load failed', {
            configId,
            error
          });
        }
      }
    } catch (error) {
      logger.warn('private config directory scan failed', { error });
    }
  }

  getRequestedPrivateConfig(req) {
    const configId = typeof req.params?.privateConfigId === 'string'
      ? req.params.privateConfigId.trim()
      : '';

    if (!configId) {
      return null;
    }

    const privateConfig = this.privateConfigStore.get(configId) || null;

    if (!privateConfig) {
      throw createHttpError(404, 'Private config not found');
    }

    return privateConfig;
  }

  getRequestedPrivateProviderSettings(req) {
    const privateConfig = this.getRequestedPrivateConfig(req);

    if (!privateConfig) {
      return { ...DEFAULT_PRIVATE_PROVIDER_SETTINGS };
    }

    return {
      ...DEFAULT_PRIVATE_PROVIDER_SETTINGS,
      ...normalizePrivateProviderSettings(privateConfig.privateProviderSettings)
    };
  }

  async createPrivateConfig(payload) {
    const normalized = this.normalizePrivateConfigRecord(payload);

    if (!normalized) {
      throw createHttpError(400, 'Invalid private config payload');
    }

    const configId = createHash('sha1')
      .update(JSON.stringify({
        version: PRIVATE_CONFIG_VERSION,
        providers: normalized.providers,
        qualityPriority: normalized.qualityPriority,
        streamOptions: normalized.streamOptions,
        privateProviderSettingsHash: getPrivateProviderSettingsHash(normalized.privateProviderSettings),
        profileCode: normalized.profileCode
      }))
      .digest('hex')
      .slice(0, 24);

    await this.ensurePrivateConfigDir();
    await writeFile(this.getPrivateConfigPath(configId), JSON.stringify(normalized));
    this.privateConfigStore.set(configId, normalized);

    return {
      configId,
      manifestPath: `/private/${configId}/manifest.json`
    };
  }

  buildStremioResultCacheKey({
    tmdbId,
    mediaType,
    season,
    episode,
    providers,
    qualityPriority,
    streamOptions,
    privateProviderSettingsHash = null,
    publicBaseUrl = null
  }) {
    return JSON.stringify({
      version: 56,
      tmdbId,
      mediaType,
      season: season ?? null,
      episode: episode ?? null,
      providers: providers ?? [],
      qualityPriority,
      streamOptions: streamOptions ?? DEFAULT_STREAM_OPTIONS,
      privateProviderSettingsHash,
      publicBaseUrl
    });
  }

  getStremioResultCachePath(cacheKey) {
    const fileName = `${createHash('sha1').update(cacheKey).digest('hex')}.json`;
    return path.join(this.stremioResultCacheDir, fileName);
  }

  getStremioLastGoodCachePath(cacheKey) {
    const fileName = `${createHash('sha1').update(cacheKey).digest('hex')}.lastgood.json`;
    return path.join(this.stremioResultCacheDir, fileName);
  }

  sendStremioStreamsResponse(res, streams) {
    const normalizedStreams = Array.isArray(streams) ? streams : [];

    if (normalizedStreams.length === 0) {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=60');
    }

    res.setHeader('X-NebulaStreams-Stream-Count', String(normalizedStreams.length));
    res.json({
      streams: normalizedStreams
    });
  }

  toCacheLookupResult(cacheKey, entry) {
    if (!entry) {
      return null;
    }

    const now = Date.now();

    if (entry.expiresAt > now) {
      touchMapEntry(this.stremioResultCache, cacheKey, entry);
      return {
        state: 'fresh',
        streams: deserializeObjects(entry.serializedStreams),
        expiresAt: entry.expiresAt,
        staleExpiresAt: entry.staleExpiresAt
      };
    }

    if (entry.staleExpiresAt > now) {
      touchMapEntry(this.stremioResultCache, cacheKey, entry);
      return {
        state: 'stale',
        streams: deserializeObjects(entry.serializedStreams),
        expiresAt: entry.expiresAt,
        staleExpiresAt: entry.staleExpiresAt
      };
    }

    this.stremioResultCache.delete(cacheKey);
    return null;
  }

  async getCachedStremioStreams(cacheKey, { allowStale = false } = {}) {
    const cached = this.stremioResultCache.get(cacheKey);
    const cachedResult = this.toCacheLookupResult(cacheKey, cached);

    if (cachedResult && (cachedResult.state === 'fresh' || allowStale)) {
      return cachedResult;
    }

    const redisEntry = await this.redisStreamResultCache.get(cacheKey);
    const redisResult = this.toCacheLookupResult(cacheKey, redisEntry);

    if (redisResult && (redisResult.state === 'fresh' || allowStale)) {
      logger.info('stremio result redis cache hit', {
        state: redisResult.state,
        resultCount: redisResult.streams.length
      });
      return redisResult;
    }

    await this.ensureStremioResultCacheDir();

    try {
      const payload = JSON.parse(await readFile(this.getStremioResultCachePath(cacheKey), 'utf8'));
      const entry = normalizeStremioResultCacheEntry(payload);
      const diskResult = this.toCacheLookupResult(cacheKey, entry);

      if (!diskResult) {
        await rm(this.getStremioResultCachePath(cacheKey), { force: true });
        return null;
      }

      touchMapEntry(this.stremioResultCache, cacheKey, entry);
      pruneMapByMaxEntries(this.stremioResultCache, config.STREMIO_RESULT_MEMORY_CACHE_MAX_ENTRIES);
      pruneMapByApproxBytes(this.stremioResultCache, config.STREMIO_RESULT_MEMORY_CACHE_MAX_MB * 1024 * 1024);

      if (diskResult.state === 'fresh' || allowStale) {
        return diskResult;
      }

      return null;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn('stremio result cache read failed', {
          error
        });
      }

      return null;
    }
  }

  async getLastGoodStremioStreams(cacheKey) {
    await this.ensureStremioResultCacheDir();

    try {
      const payload = JSON.parse(await readFile(this.getStremioLastGoodCachePath(cacheKey), 'utf8'));
      const entry = normalizeStremioResultCacheEntry(payload);
      const result = this.toCacheLookupResult(cacheKey, entry);

      if (!result) {
        await rm(this.getStremioLastGoodCachePath(cacheKey), { force: true });
        return null;
      }

      return result.streams;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn('stremio last-good cache read failed', {
          error
        });
      }

      return null;
    }
  }

  async setCachedStremioStreams(cacheKey, streams, { weak = false } = {}) {
    const now = Date.now();
    const freshTtlSeconds = streams.length === 0
      ? config.STREMIO_EMPTY_RESULT_CACHE_TTL_SECONDS
      : weak
        ? Math.min(config.STREMIO_WEAK_RESULT_CACHE_TTL_SECONDS, config.STREMIO_RESULT_CACHE_TTL_SECONDS)
        : config.STREMIO_RESULT_CACHE_TTL_SECONDS;

    if (freshTtlSeconds <= 0) {
      return;
    }

    const freshTtlMs = freshTtlSeconds * 1000;
    const staleTtlMs = streams.length === 0 || weak
      ? freshTtlMs
      : Math.max(
        freshTtlMs,
        config.STREMIO_RESULT_STALE_TTL_SECONDS * 1000
      );
    const serializedStreams = serializeObjects(streams);
    const entry = {
      expiresAt: now + freshTtlMs,
      staleExpiresAt: now + staleTtlMs,
      weak: Boolean(weak),
      approxBytes: getSerializedApproxBytes(serializedStreams),
      serializedStreams
    };

    touchMapEntry(this.stremioResultCache, cacheKey, entry);
    pruneMapByMaxEntries(this.stremioResultCache, config.STREMIO_RESULT_MEMORY_CACHE_MAX_ENTRIES);
    pruneMapByApproxBytes(this.stremioResultCache, config.STREMIO_RESULT_MEMORY_CACHE_MAX_MB * 1024 * 1024);
    await this.redisStreamResultCache.set(cacheKey, entry);
    await this.ensureStremioResultCacheDir();

    try {
      await writeFile(this.getStremioResultCachePath(cacheKey), JSON.stringify(entry));
    } catch (error) {
      logger.warn('stremio result cache write failed', {
        error
      });
    }

    if (shouldPersistLastGoodStreamSet(streams)) {
      const lastGoodEntry = {
        expiresAt: now + (config.STREMIO_LAST_GOOD_TTL_SECONDS * 1000),
        staleExpiresAt: now + (config.STREMIO_LAST_GOOD_TTL_SECONDS * 1000),
        weak: false,
        approxBytes: getSerializedApproxBytes(serializedStreams),
        serializedStreams
      };

      try {
        await writeFile(this.getStremioLastGoodCachePath(cacheKey), JSON.stringify(lastGoodEntry));
      } catch (error) {
        logger.warn('stremio last-good cache write failed', {
          error
        });
      }
    }
  }

  getRequestedProviders(req) {
    const privateConfig = this.getRequestedPrivateConfig(req);

    if (privateConfig) {
      return [...privateConfig.providers];
    }

    const rawConfig = typeof req.params?.providerConfig === 'string'
      ? req.params.providerConfig
      : typeof req.query?.providers === 'string'
        ? req.query.providers
        : '';
    const decoded = rawConfig ? decodeURIComponent(rawConfig) : '';

    if (!decoded || decoded === 'all') {
      return [];
    }

    const requestedProviders = decoded
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    return this.providerService.normalizeProviders(requestedProviders);
  }

  getRequestedQualityPriority(req) {
    const privateConfig = this.getRequestedPrivateConfig(req);

    if (privateConfig) {
      return [...privateConfig.qualityPriority];
    }

    const rawConfig = typeof req.params?.qualityConfig === 'string'
      ? req.params.qualityConfig
      : typeof req.query?.qualities === 'string'
        ? req.query.qualities
        : '';
    const decoded = rawConfig ? decodeURIComponent(rawConfig) : '';

    if (!decoded || decoded === 'default') {
      return [...DEFAULT_QUALITY_PRIORITY];
    }

    const requestedQualities = decoded
      .split(',')
      .map((value) => normalizeQualityKey(value))
      .filter(Boolean);
    const uniqueQualities = requestedQualities.filter((quality, index) =>
      requestedQualities.indexOf(quality) === index
    );

    if (uniqueQualities.length === 0) {
      return [...DEFAULT_QUALITY_PRIORITY];
    }

    for (const quality of DEFAULT_QUALITY_PRIORITY) {
      if (!uniqueQualities.includes(quality)) {
        uniqueQualities.push(quality);
      }
    }

    return uniqueQualities;
  }

  getRequestedStreamOptions(req) {
    const privateConfig = this.getRequestedPrivateConfig(req);

    if (privateConfig) {
      return {
        ...DEFAULT_STREAM_OPTIONS,
        ...privateConfig.streamOptions,
        blockHosts: Array.isArray(privateConfig.streamOptions?.blockHosts)
          ? [...privateConfig.streamOptions.blockHosts]
          : [],
        customProxyUrl: normalizeCustomProxyUrl(privateConfig.streamOptions?.customProxyUrl)
      };
    }

    const rawConfig = typeof req.params?.optionConfig === 'string'
      ? req.params.optionConfig
      : typeof req.query?.options === 'string'
        ? req.query.options
        : '';
    const decoded = rawConfig ? decodeURIComponent(rawConfig) : '';

    if (!decoded || decoded === 'default') {
      return { ...DEFAULT_STREAM_OPTIONS };
    }

    const tokens = decoded
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

    let maxSizeGb = 0;
    let blockHosts = [];
    let preferredAudioLanguage = null;
    let dedupeMode = 'off';

    for (const token of tokens) {
      if (token.startsWith('max-size-gb=')) {
        const parsed = Number.parseFloat(token.slice('max-size-gb='.length));

        if (Number.isFinite(parsed) && parsed > 0) {
          maxSizeGb = parsed;
        }
      }

      if (token.startsWith('block-hosts=')) {
        blockHosts = token
          .slice('block-hosts='.length)
          .split('|')
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
          .filter((value, index, values) => values.indexOf(value) === index);
      }

      if (token.startsWith('preferred-audio=')) {
        preferredAudioLanguage = normalizeAudioLanguageKey(token.slice('preferred-audio='.length));
      }

      if (token.startsWith('dedupe=')) {
        dedupeMode = normalizeDedupeMode(token.slice('dedupe='.length));
      }
    }

    return {
      webReadyOnly: tokens.includes('web-ready-only'),
      hideHeavyFormats: tokens.includes('hide-heavy-formats'),
      maxSizeGb,
      blockHosts,
      preferredAudioLanguage,
      dedupeMode,
      preferHdr: tokens.includes('prefer-hdr'),
      preferH264: tokens.includes('prefer-h264'),
      preferSmallerFiles: tokens.includes('prefer-smaller-files'),
      preferDirectHosts: tokens.includes('prefer-direct-hosts'),
      customProxyUrl: null
    };
  }

  getRequestedConfiguredProfile(req) {
    const privateConfig = this.getRequestedPrivateConfig(req);

    if (privateConfig?.profileCode) {
      return CONFIGURED_PROFILE_LABELS[privateConfig.profileCode] || null;
    }

    const rawConfig = typeof req.params?.optionConfig === 'string'
      ? req.params.optionConfig
      : typeof req.query?.options === 'string'
        ? req.query.options
        : '';
    const decoded = rawConfig ? decodeURIComponent(rawConfig) : '';
    const profileToken = decoded
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .find((token) => token.startsWith('profile='));
    const queryProfile = typeof req.query?.profile === 'string'
      ? req.query.profile.trim().toLowerCase()
      : '';
    const profileKey = profileToken
      ? profileToken.slice('profile='.length)
      : queryProfile;

    return CONFIGURED_PROFILE_LABELS[profileKey] || null;
  }

  getAddonPresentation(req) {
    const providers = this.getRequestedProviders(req);
    const qualityPriority = this.getRequestedQualityPriority(req);
    const streamOptions = this.getRequestedStreamOptions(req);
    const privateProviderSettingsHash = getPrivateProviderSettingsHash(this.getRequestedPrivateProviderSettings(req));
    const configuredProfile = this.getRequestedConfiguredProfile(req);
    const hasDefaultQualityPriority = qualityPriority.join(',') === DEFAULT_QUALITY_PRIORITY.join(',');
    const hasDefaultStreamOptions = JSON.stringify(streamOptions) === JSON.stringify(DEFAULT_STREAM_OPTIONS);

    if (providers.length === 0 && hasDefaultQualityPriority && hasDefaultStreamOptions && !privateProviderSettingsHash) {
      return {
        providers,
        qualityPriority,
        streamOptions,
        addonId: config.STREMIO_ADDON_ID,
        addonName: config.STREMIO_ADDON_NAME,
        configurable: true,
        description: config.CONFIGURATION_DESCRIPTION
      };
    }

    const providerHash = createHash('sha1')
      .update(`${providers.join(',')}|${qualityPriority.join(',')}|${JSON.stringify(streamOptions)}|${privateProviderSettingsHash || ''}`)
      .digest('hex')
      .slice(0, 10);
    const providerSummary = providers.length > 0
      ? `${providers.length} selected provider${providers.length === 1 ? '' : 's'}`
      : 'all providers';
    const configuredLabel = configuredProfile || { code: 'CFG', label: 'Custom' };

    return {
      providers,
      qualityPriority,
      streamOptions,
      addonId: `${config.STREMIO_ADDON_ID}.${providerHash}`,
      addonName: `${config.STREMIO_ADDON_NAME}(${configuredLabel.code})`,
      configurable: true,
      description: `Configured install: ${configuredLabel.label}. Providers: ${providerSummary}. Quality priority: ${qualityPriority.join(' > ')}. Playback: ${summarizeStreamOptions(streamOptions)}`
    };
  }

  async handleStremioManifest(req, res) {
    const baseUrl = getRequestPublicBaseUrl(req);
    const addonPresentation = this.getAddonPresentation(req);

    res.json({
      id: addonPresentation.addonId,
      version: '1.0.0',
      name: addonPresentation.addonName,
      description: addonPresentation.description,
      resources: [{
        name: 'stream',
        types: ['movie', 'series'],
        idPrefixes: ['tt']
      }],
      types: ['movie', 'series'],
      idPrefixes: ['tt'],
      catalogs: [],
      behaviorHints: {
        configurable: addonPresentation.configurable
      },
      logo: `${baseUrl}/assets/nebulastreams-icon.jpg`,
      stremioAddonsConfig: {
        issuer: 'https://stremio-addons.net',
        signature: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..c1dKT48ayjjpai4JwQCcTA.cTsGooecPtjL0uCwd_o8UuHCo--DfHlIfkqcpk5Pk5UidakL038sCsT2RMB6AuUyBZOVlVP2LKHbygHwNcYtcADvRZIK53YGr-SL2V9L8YH6SFgUwJC5eBE8lOlUWKio.ygBtjPAXg3ikys04cQarXQ'
      }
    });
  }

  async handleStremioStreams(req, res, next) {
    try {
      const parsed = this.parseStremioStreamRequest(req.params.type, req.params.id);
      let tmdbId;

      try {
        tmdbId = await this.imdbResolver.resolve({
          imdbId: parsed.imdbId,
          mediaType: parsed.mediaType
        });
      } catch (error) {
        logger.warn('stremio imdb resolution failed', {
          imdbId: parsed.imdbId,
          mediaType: parsed.mediaType,
          error
        });
        this.sendStremioStreamsResponse(res, []);
        return;
      }

      if (!tmdbId) {
        this.sendStremioStreamsResponse(res, []);
        return;
      }

      const baseUrl = getRequestPublicBaseUrl(req);
      const requestedProviders = this.getRequestedProviders(req);
      const qualityPriority = this.getRequestedQualityPriority(req);
      const streamOptions = this.getRequestedStreamOptions(req);
      const privateProviderSettings = this.getRequestedPrivateProviderSettings(req);
      const privateProviderSettingsHash = getPrivateProviderSettingsHash(privateProviderSettings);
      const isConfiguredRequest = String(req.path || '').startsWith('/configured/')
        || String(req.path || '').startsWith('/private/');
      const bypassStremioResultCache = requestedProviders.length === 1 && requestedProviders[0] === 'allyoucanwatch';
      const resultCacheKey = this.buildStremioResultCacheKey({
        tmdbId,
        mediaType: parsed.mediaType,
        season: parsed.season,
        episode: parsed.episode,
        providers: requestedProviders,
        qualityPriority,
        streamOptions,
        privateProviderSettingsHash,
        publicBaseUrl: baseUrl
      });
      this.userTracker?.trackStreamSearch(req, {
        imdbId: parsed.imdbId,
        tmdbId,
        mediaType: parsed.mediaType,
        season: parsed.season,
        episode: parsed.episode,
        providers: requestedProviders,
        qualityPriority,
        streamOptions
      });
      const cachedResult = bypassStremioResultCache
        ? null
        : await this.getCachedStremioStreams(resultCacheKey, { allowStale: true });
      const lastGoodStreams = bypassStremioResultCache
        ? null
        : await this.getLastGoodStremioStreams(resultCacheKey);

      if (cachedResult?.state === 'fresh') {
        this.sendStremioStreamsResponse(res, cachedResult.streams);
        return;
      }

      if (bypassStremioResultCache) {
        const uncachedStreams = await this.buildStremioStreams({
          resultCacheKey,
          baseUrl,
          parsed,
          requestedProviders,
          qualityPriority,
          streamOptions,
          tmdbId,
          privateProviderSettings,
          cacheResult: false
        });

        res.setHeader('X-NebulaStreams-Mode', 'uncached-explicit-provider');
        this.sendStremioStreamsResponse(res, uncachedStreams);
        return;
      }

      if (this.isLoadShedding() && lastGoodStreams?.length) {
        logger.warn('serving last-good stremio streams during load shedding', {
          tmdbId,
          mediaType: parsed.mediaType,
          resultCount: lastGoodStreams.length,
          loadSheddingUntil: new Date(this.loadSheddingUntil).toISOString(),
          reason: this.loadSheddingReason
        });
        await this.setCachedStremioStreams(resultCacheKey, lastGoodStreams, { weak: true });
        res.setHeader('X-NebulaStreams-Cache', 'last-good-load-shed');
        this.sendStremioStreamsResponse(res, lastGoodStreams);
        return;
      }

      if (this.isLoadShedding()) {
        logger.warn('serving request through degraded uncached path during load shedding', {
          tmdbId,
          mediaType: parsed.mediaType,
          loadSheddingUntil: new Date(this.loadSheddingUntil).toISOString(),
          reason: this.loadSheddingReason
        });
        const degradedStreams = await this.buildStremioStreams({
          resultCacheKey,
          baseUrl,
          parsed,
          requestedProviders,
          qualityPriority,
          streamOptions,
          tmdbId,
          privateProviderSettings,
          cacheResult: false
        });

        res.setHeader('X-NebulaStreams-Mode', isConfiguredRequest ? 'configured-degraded' : 'default-degraded');
        this.sendStremioStreamsResponse(res, degradedStreams);
        return;
      }

      const buildInput = {
        resultCacheKey,
        baseUrl,
        parsed,
        requestedProviders,
        qualityPriority,
        streamOptions,
        tmdbId,
        privateProviderSettings
      };

      if (cachedResult?.state === 'stale') {
        this.scheduleStremioBackgroundRefresh(buildInput);
        res.setHeader('X-NebulaStreams-Cache', 'stale');
        this.sendStremioStreamsResponse(res, cachedResult.streams);
        return;
      }

      if (isConfiguredRequest && lastGoodStreams?.length) {
        this.scheduleStremioBackgroundRefresh(buildInput);
        await this.setCachedStremioStreams(resultCacheKey, lastGoodStreams, { weak: true });
        res.setHeader('X-NebulaStreams-Cache', 'last-good-refresh');
        this.sendStremioStreamsResponse(res, lastGoodStreams);
        return;
      }

      let stremioStreams;

      try {
        stremioStreams = await this.getOrBuildStremioStreams(buildInput);
      } catch (error) {
        if (lastGoodStreams?.length) {
          logger.warn('serving last-good stremio streams after rebuild failure', {
            tmdbId,
            mediaType: parsed.mediaType,
            resultCount: lastGoodStreams.length,
            error
          });
          await this.setCachedStremioStreams(resultCacheKey, lastGoodStreams, { weak: true });
          res.setHeader('X-NebulaStreams-Cache', 'last-good-error');
          this.sendStremioStreamsResponse(res, lastGoodStreams);
          return;
        }

        throw error;
      }

      if ((!Array.isArray(stremioStreams) || stremioStreams.length === 0) && lastGoodStreams?.length) {
        const freshScore = getLastGoodStreamSetScore(stremioStreams);
        const lastGoodScore = getLastGoodStreamSetScore(lastGoodStreams);

        if (lastGoodScore > freshScore) {
          logger.warn('serving last-good stremio streams after empty rebuild result', {
            tmdbId,
            mediaType: parsed.mediaType,
            resultCount: lastGoodStreams.length,
            lastGoodScore,
            freshScore
          });
          await this.setCachedStremioStreams(resultCacheKey, lastGoodStreams, { weak: true });
          res.setHeader('X-NebulaStreams-Cache', 'last-good-empty');
          this.sendStremioStreamsResponse(res, lastGoodStreams);
          return;
        }
      }

      this.sendStremioStreamsResponse(res, stremioStreams);
    } catch (error) {
      next(error);
    }
  }

  scheduleStremioBackgroundRefresh(input) {
    if (config.STREMIO_BACKGROUND_REFRESH_CONCURRENCY <= 0 || config.STREMIO_BACKGROUND_REFRESH_QUEUE_MAX <= 0) {
      return;
    }

    if (this.shouldSkipBackgroundRefresh()) {
      return;
    }

    if (this.stremioBackgroundRefreshes.has(input.resultCacheKey) || this.stremioResultInFlight.has(input.resultCacheKey)) {
      return;
    }

    const trackedCount = this.stremioBackgroundRefreshes.size;

    if (trackedCount >= config.STREMIO_BACKGROUND_REFRESH_QUEUE_MAX) {
      logger.warn('stremio background refresh skipped because queue is full', {
        queueSize: this.stremioBackgroundRefreshQueue.length,
        activeRefreshes: this.activeStremioBackgroundRefreshes,
        maxQueue: config.STREMIO_BACKGROUND_REFRESH_QUEUE_MAX,
        tmdbId: input.tmdbId,
        mediaType: input.parsed?.mediaType
      });
      return;
    }

    this.stremioBackgroundRefreshes.add(input.resultCacheKey);
    this.stremioBackgroundRefreshQueue.push(input);
    this.runStremioBackgroundRefreshQueue();
  }

  runStremioBackgroundRefreshQueue() {
    while (
      this.activeStremioBackgroundRefreshes < config.STREMIO_BACKGROUND_REFRESH_CONCURRENCY &&
      this.stremioBackgroundRefreshQueue.length > 0
    ) {
      const input = this.stremioBackgroundRefreshQueue.shift();
      this.activeStremioBackgroundRefreshes += 1;

      this.getOrBuildStremioStreams(input)
        .catch((error) => {
          logger.warn('stremio background refresh failed', {
            error,
            tmdbId: input.tmdbId,
            mediaType: input.parsed?.mediaType
          });
        })
        .finally(() => {
          this.activeStremioBackgroundRefreshes -= 1;
          this.stremioBackgroundRefreshes.delete(input.resultCacheKey);
          this.runStremioBackgroundRefreshQueue();
        });
    }
  }

  async getOrBuildStremioStreams({
    resultCacheKey,
    baseUrl,
    parsed,
    requestedProviders,
    qualityPriority,
    streamOptions,
    tmdbId,
    privateProviderSettings
  }) {
    const existingRequest = this.stremioResultInFlight.get(resultCacheKey);

    if (existingRequest) {
      return existingRequest.then((streams) => copyObjects(streams));
    }

    if (config.STREMIO_MAX_INFLIGHT_SEARCHES > 0 && this.stremioResultInFlight.size >= config.STREMIO_MAX_INFLIGHT_SEARCHES) {
      const slotAvailable = await this.waitForStremioResultSlot({
        resultCacheKey,
        tmdbId,
        mediaType: parsed.mediaType
      });
      const inFlightRequest = this.stremioResultInFlight.get(resultCacheKey);

      if (inFlightRequest) {
        return inFlightRequest.then((streams) => copyObjects(streams));
      }

      if (!slotAvailable) {
        logger.warn('stremio stream search rejected due to in-flight limit', {
          inFlightSearches: this.stremioResultInFlight.size,
          maxInFlightSearches: config.STREMIO_MAX_INFLIGHT_SEARCHES,
          waitMs: config.STREMIO_INFLIGHT_SLOT_WAIT_MS,
          tmdbId,
          mediaType: parsed.mediaType
        });
        throw createHttpError(503, 'Server is busy preparing streams');
      }
    }

    if (config.STREMIO_MAX_INFLIGHT_SEARCHES > 0 && this.stremioResultInFlight.size >= config.STREMIO_MAX_INFLIGHT_SEARCHES) {
      logger.warn('stremio stream search rejected due to in-flight limit', {
        inFlightSearches: this.stremioResultInFlight.size,
        maxInFlightSearches: config.STREMIO_MAX_INFLIGHT_SEARCHES,
        tmdbId,
        mediaType: parsed.mediaType
      });
      throw createHttpError(503, 'Server is busy preparing streams');
    }

    const request = this.buildStremioStreams({
      resultCacheKey,
      baseUrl,
      parsed,
      requestedProviders,
      qualityPriority,
      streamOptions,
      tmdbId,
      privateProviderSettings
    });

    this.stremioResultInFlight.set(resultCacheKey, request);

    try {
      const streams = await request;
      return copyObjects(streams);
    } finally {
      this.stremioResultInFlight.delete(resultCacheKey);
    }
  }

  async buildStremioStreams({
    resultCacheKey,
    baseUrl,
    parsed,
    requestedProviders,
    qualityPriority,
    streamOptions,
    tmdbId,
    privateProviderSettings,
    cacheResult = true
  }) {
    const result = await this.providerService.getFastStreams({
      providers: requestedProviders.length > 0 ? requestedProviders : null,
      tmdbId,
      mediaType: parsed.mediaType === 'series' ? 'tv' : 'movie',
      season: parsed.season,
      episode: parsed.episode,
      streamOptions,
      privateProviderSettings
    });

    if (result.streams.length === 0) {
      if (cacheResult && shouldCacheEmptyFastResult(result)) {
        await this.setCachedStremioStreams(resultCacheKey, []);
      } else if (!cacheResult) {
        logger.info('skipping stremio cache write for degraded configured request', {
          tmdbId,
          mediaType: parsed.mediaType,
          reason: result.reason,
          providersTried: result.tried
        });
      } else {
        logger.info('skipping empty stremio cache write for partial fast search result', {
          tmdbId,
          mediaType: parsed.mediaType,
          reason: result.reason,
          providersTried: result.tried
        });
      }
      return [];
    }

    const normalizedStreams = await this.normalizeProviderStreams(baseUrl, result.streams);
    const { streams: configuredStreams } = filterConfiguredStreamsDetailed(normalizedStreams, streamOptions);

    if (configuredStreams.length === 0) {
      logger.warn('stremio stream search produced no configured streams', {
        tmdbId,
        mediaType: parsed.mediaType,
        reason: result.reason,
        providersTried: result.tried,
        rawStreamCount: result.streams.length,
        normalizedStreamCount: normalizedStreams.length,
        streamOptions
      });
      if (cacheResult && shouldCacheEmptyFastResult(result)) {
        await this.setCachedStremioStreams(resultCacheKey, []);
      }
      return [];
    }

    configuredStreams.sort((left, right) =>
      (getQualityPriorityScore(right, qualityPriority) + getPreferredAudioLanguageScore(right, streamOptions) + getStreamPreferenceScore(right, streamOptions) + getProviderPriorityScore(right, result.providers) + getDeliveryPriorityScore(right) + toStremioCompatibilityScore(right)) -
      (getQualityPriorityScore(left, qualityPriority) + getPreferredAudioLanguageScore(left, streamOptions) + getStreamPreferenceScore(left, streamOptions) + getProviderPriorityScore(left, result.providers) + getDeliveryPriorityScore(left) + toStremioCompatibilityScore(left))
    );
    const postDedupeStreams = applyConfiguredDedupe(configuredStreams, streamOptions).streams;
    const dedupedStreams = diversifyStreamsByProvider(
      postDedupeStreams,
      getStreamDiversityOptions(postDedupeStreams, {
        requestedProviders
      })
    );
    const useWeakCache = shouldUseWeakResultCache(dedupedStreams);
    const stremioStreams = dedupedStreams
      .map((stream) => toStremioStreamObject(stream, parsed, streamOptions, baseUrl))
      .filter(Boolean);

    if (cacheResult) {
      await this.setCachedStremioStreams(resultCacheKey, stremioStreams, { weak: useWeakCache });
    }

    return stremioStreams;
  }

  async handleTorrentStream(req, res, next) {
    try {
      const descriptor = await this.handleStreamRequest({
        source: req.query.magnet,
        fileIndex: req.query.fileIndex,
        fileName: req.query.fileName,
        rangeHeader: req.headers.range
      });

      await this.sendStream(res, descriptor);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }

      next(error);
    }
  }

  async handleHttpStream(req, res, next) {
    try {
      const descriptor = await this.handleStreamRequest({
        source: req.query.url,
        rangeHeader: req.headers.range
      });

      await this.sendStream(res, descriptor);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }

      next(error);
    }
  }

  async handleAddSource(req, res, next) {
    try {
      const streamUrl = await this.createRegisteredStreamUrl(getRequestPublicBaseUrl(req), {
        type: req.body?.type,
        source: req.body?.source,
        headers: req.body?.headers,
        metadata: req.body?.metadata
      });

      res.json({
        streamUrl: streamUrl.toString(),
        sourceId: streamUrl.searchParams.get('sourceId')
      });
    } catch (error) {
      logger.error('add-source failed', {
        error
      });
      next(error);
    }
  }

  async handleCreatePrivateConfig(req, res, next) {
    try {
      const { configId, manifestPath } = await this.createPrivateConfig({
        providers: req.body?.providers,
        qualityPriority: req.body?.qualityPriority,
        streamOptions: req.body?.streamOptions,
        privateProviderSettings: req.body?.privateProviderSettings,
        profileCode: req.body?.profileCode
      });

      res.json({
        configId,
        manifestPath
      });
    } catch (error) {
      next(error);
    }
  }

  async handleProviderStreams(req, res, next) {
    try {
      const baseUrl = getRequestPublicBaseUrl(req);
      const provider = req.params.provider;
      const streams = await this.providerService.getStreams({
        provider,
        tmdbId: req.query.tmdbId,
        mediaType: req.query.mediaType,
        season: req.query.season,
        episode: req.query.episode
      });

      if (streams.length === 0) {
        res.json({
          provider,
          count: 0,
          streams: []
        });
        return;
      }

      const normalizedStreams = await this.normalizeProviderStreams(baseUrl, streams, provider);

      res.json({
        provider,
        count: normalizedStreams.length,
        streams: normalizedStreams
      });
    } catch (error) {
      next(error);
    }
  }

  async handleAggregateProviderStreams(req, res, next) {
    try {
      const baseUrl = getRequestPublicBaseUrl(req);
      const requestedProviders = typeof req.query.providers === 'string'
        ? req.query.providers.split(',').map((value) => value.trim()).filter(Boolean)
        : undefined;
      const result = await this.providerService.getAggregateStreams({
        providers: requestedProviders,
        tmdbId: req.query.tmdbId,
        mediaType: req.query.mediaType,
        season: req.query.season,
        episode: req.query.episode
      });

      if (result.streams.length === 0) {
        res.json({
          provider: null,
          count: 0,
          tried: result.tried,
          streams: []
        });
        return;
      }

      const normalizedStreams = await this.normalizeProviderStreams(baseUrl, result.streams);

      res.json({
        provider: null,
        count: normalizedStreams.length,
        tried: result.tried,
        streams: normalizedStreams
      });
    } catch (error) {
      next(error);
    }
  }

  async handleUnifiedStream(req, res, next) {
    try {
      const descriptor = await this.handleStreamRequest({
        sourceId: req.query.sourceId,
        type: req.query.type,
        source: req.query.source,
        rangeHeader: req.headers.range
      });

      await this.sendStream(res, descriptor);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }

      next(error);
    }
  }

  async handleStremioPreview(req, res, next) {
    try {
      const parsed = this.parseStremioStreamRequest(req.params.type, req.params.id);
      let tmdbId;

      try {
        tmdbId = await this.imdbResolver.resolve({
          imdbId: parsed.imdbId,
          mediaType: parsed.mediaType
        });
      } catch (error) {
        logger.warn('stremio preview imdb resolution failed', {
          imdbId: parsed.imdbId,
          mediaType: parsed.mediaType,
          error
        });
        res.json({
          resolved: false,
          reason: 'imdb-resolution-failed'
        });
        return;
      }

      if (!tmdbId) {
        res.json({
          resolved: false,
          reason: 'tmdb-not-found'
        });
        return;
      }

      const baseUrl = getRequestPublicBaseUrl(req);
      const requestedProviders = this.getRequestedProviders(req);
      const qualityPriority = this.getRequestedQualityPriority(req);
      const streamOptions = this.getRequestedStreamOptions(req);
      const privateProviderSettings = this.getRequestedPrivateProviderSettings(req);
      const result = await this.providerService.getFastStreams({
        providers: requestedProviders.length > 0 ? requestedProviders : null,
        tmdbId,
        mediaType: parsed.mediaType === 'series' ? 'tv' : 'movie',
        season: parsed.season,
        episode: parsed.episode,
        streamOptions,
        privateProviderSettings
      });
      const normalizedStreams = await this.normalizeProviderStreams(baseUrl, result.streams);
      const { streams: configuredStreams, diagnostics } = filterConfiguredStreamsDetailed(normalizedStreams, streamOptions);

      configuredStreams.sort((left, right) =>
        (getQualityPriorityScore(right, qualityPriority) + getPreferredAudioLanguageScore(right, streamOptions) + getStreamPreferenceScore(right, streamOptions) + getProviderPriorityScore(right, result.providers) + getDeliveryPriorityScore(right) + toStremioCompatibilityScore(right)) -
        (getQualityPriorityScore(left, qualityPriority) + getPreferredAudioLanguageScore(left, streamOptions) + getStreamPreferenceScore(left, streamOptions) + getProviderPriorityScore(left, result.providers) + getDeliveryPriorityScore(left) + toStremioCompatibilityScore(left))
      );
      const dedupeResult = applyConfiguredDedupe(configuredStreams, streamOptions);
      diagnostics.dedupedTotal = dedupeResult.removedCount;
      diagnostics.reasons.duplicate = dedupeResult.removedCount;
      diagnostics.examples.duplicate = dedupeResult.examples;

      res.json({
        resolved: true,
        tmdbId,
        providersTried: result.tried,
        providerOrder: result.providers,
        diagnostics,
        sample: dedupeResult.streams.slice(0, 6).map((stream) => ({
          name: stream.name,
          quality: stream.quality,
          host: getStreamHostname(stream),
          size: stream.size || null,
          url: stream.url || null
        }))
      });
    } catch (error) {
      next(error);
    }
  }

  async handleCacheStats(_req, res, next) {
    try {
      const stats = await this.cacheManager.getCacheStats(this.torrentEngine.getActiveCachePaths());
      res.json(stats);
    } catch (error) {
      next(error);
    }
  }

  async handleTorrentFileStream(req, res, next) {
    try {
      const descriptor = await this.torrentEngine.getStreamDescriptorByInfoHash({
        infoHash: req.params.infoHash,
        fileName: req.params.filename,
        rangeHeader: req.headers.range
      });

      await this.sendStream(res, descriptor);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }

      next(error);
    }
  }

  async handleStreamRequest(input = {}) {
    if (typeof input.sourceId === 'string' && input.sourceId.trim()) {
      const resolved = this.sourceRegistry.get(input.sourceId.trim());

      if (!resolved) {
        throw createHttpError(404, 'Source id was not found or has expired');
      }

      return this.handleStreamRequest({
        ...input,
        type: resolved.type,
        source: resolved.source,
        headers: resolved.headers,
        metadata: resolved.metadata,
        fallback: resolved.fallback,
        sourceId: null
      });
    }

    const rawSource = input.source ?? input.url ?? input.magnet;
    const requestedType = normalizeRequestedType(input.type);
    const detectedType = detectSourceType(rawSource);
    const normalizedDetectedType = detectedType === 'magnet' ? 'torrent' : detectedType;

    if (!detectedType || !normalizedDetectedType) {
      throw createHttpError(400, 'A valid HTTP URL or magnet link is required');
    }

    if (requestedType && requestedType !== normalizedDetectedType) {
      throw createHttpError(400, `Query parameter type=${requestedType} does not match the provided source`);
    }

    if (normalizedDetectedType === 'http' && isExtractorRedirectUrl(rawSource)) {
      const fallback = await this.prepareFallback(input.fallback);

      return this.resolveManagedHttpDescriptor(rawSource, {
        rangeHeader: input.rangeHeader,
        inheritedHeaders: input.headers,
        fallback,
        fileIndex: input.fileIndex,
        fileName: input.fileName
      });
    }

    const preparedSource = await this.prepareSource(input);
    const sourceType = preparedSource.type;
    const source = preparedSource.source;
    const fallback = preparedSource.fallback;

    if (sourceType === 'torrent') {
      return this.torrentEngine.getStreamDescriptor({
        magnet: source,
        fileIndex: input.fileIndex,
        fileName: input.fileName,
        rangeHeader: input.rangeHeader
      });
    }

    const cachedEntry = await this.cacheManager.getHttpCacheEntry(source);

    if (cachedEntry) {
      await this.cacheManager.touchPath(cachedEntry.dataPath);
      return this.httpProxy.createCachedDescriptor(cachedEntry, input.rangeHeader);
    }

    try {
      return await this.httpProxy.getUpstreamStreamDescriptor({
        targetUrl: source,
        rangeHeader: input.rangeHeader,
        requestHeaders: preparedSource.headers
      });
    } catch (error) {
      if (fallback?.type === 'torrent') {
        logger.warn('http source failed, falling back to torrent', {
          source,
          fallbackSource: fallback.source,
          error
        });

        return this.torrentEngine.getStreamDescriptor({
          magnet: fallback.source,
          fileIndex: input.fileIndex,
          fileName: input.fileName,
          rangeHeader: input.rangeHeader
        });
      }

      throw error;
    }
  }

  async resolveManagedHttpDescriptor(streamUrl, options = {}) {
    const resolvedEntries = await this.resolveExtractorRedirectEntries(streamUrl, options.inheritedHeaders);

    if (!Array.isArray(resolvedEntries) || resolvedEntries.length === 0) {
      if (options.fallback?.type === 'torrent') {
        logger.warn('managed http source resolution failed, falling back to torrent', {
          streamUrl,
          fallbackSource: options.fallback.source
        });

        return this.torrentEngine.getStreamDescriptor({
          magnet: options.fallback.source,
          fileIndex: options.fileIndex,
          fileName: options.fileName,
          rangeHeader: options.rangeHeader
        });
      }

      throw createHttpError(502, 'Unable to resolve the selected stream source');
    }

    let lastError = null;

    for (const entry of resolvedEntries) {
      if (!entry?.url || typeof entry.url !== 'string') {
        continue;
      }

      try {
        return await this.httpProxy.getStreamDescriptor({
          targetUrl: entry.url,
          rangeHeader: options.rangeHeader,
          requestHeaders: entry.headers && typeof entry.headers === 'object' ? entry.headers : null
        });
      } catch (error) {
        lastError = error;
        logger.warn('managed http source candidate failed', {
          streamUrl,
          candidateUrl: entry.url,
          sourceSite: entry.sourceSite || null,
          error
        });
      }
    }

    if (options.fallback?.type === 'torrent') {
      logger.warn('all managed http source candidates failed, falling back to torrent', {
        streamUrl,
        fallbackSource: options.fallback.source,
        lastError
      });

      return this.torrentEngine.getStreamDescriptor({
        magnet: options.fallback.source,
        fileIndex: options.fileIndex,
        fileName: options.fileName,
        rangeHeader: options.rangeHeader
      });
    }

    throw lastError || createHttpError(502, 'Unable to resolve the selected stream source');
  }

  async prepareSource(input = {}) {
    const rawSource = input.source ?? input.url ?? input.magnet;
    const requestedType = normalizeRequestedType(input.type);
    const detectedType = detectSourceType(rawSource);
    const normalizedDetectedType = detectedType === 'magnet' ? 'torrent' : detectedType;

    if (!detectedType || !normalizedDetectedType) {
      throw createHttpError(400, 'A valid HTTP URL or magnet link is required');
    }

    if (requestedType && requestedType !== normalizedDetectedType) {
      throw createHttpError(400, `Query parameter type=${requestedType} does not match the provided source`);
    }

    if (normalizedDetectedType === 'http') {
      let normalizedUrl = input.deferValidation
        ? this.normalizeHttpSource(rawSource)
        : await this.httpProxy.validateTargetUrl(rawSource);
      let resolvedHeaders = input.headers && typeof input.headers === 'object' ? { ...input.headers } : null;

      if (isExtractorRedirectUrl(normalizedUrl)) {
        const resolvedSource = await this.resolveManagedHttpSource(normalizedUrl, resolvedHeaders);

        if (!resolvedSource?.url) {
          throw createHttpError(502, 'Unable to resolve the selected stream source');
        }

        normalizedUrl = input.deferValidation
          ? this.normalizeHttpSource(resolvedSource.url)
          : await this.httpProxy.validateTargetUrl(resolvedSource.url);
        resolvedHeaders = resolvedSource.headers && typeof resolvedSource.headers === 'object'
          ? { ...resolvedSource.headers }
          : resolvedHeaders;
      }

      return {
        type: 'http',
        source: normalizedUrl,
        streamSource: normalizedUrl,
        headers: resolvedHeaders,
        metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : null,
        fallback: await this.prepareFallback(input.fallback),
        cached: await this.cacheManager.isCached(this.cacheManager.getHttpCacheKey(normalizedUrl))
      };
    }

    let magnet;

    try {
      magnet = enhanceMagnet(rawSource);
    } catch (error) {
      throw createHttpError(400, error.message);
    }

    const infoHash = extractInfoHash(magnet);

    if (!infoHash) {
      throw createHttpError(400, 'Invalid magnet URI');
    }

    const cached = await this.cacheManager.isCached(infoHash);

    return {
      type: 'torrent',
      source: magnet,
      streamSource: String(rawSource).trim(),
      headers: null,
      metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : null,
      fallback: null,
      cached
    };
  }

  async createRegisteredStreamUrl(baseUrl, input = {}) {
    const preparedSource = await this.prepareSource(input);
    const sourceId = this.sourceRegistry.register({
      type: preparedSource.type,
      source: preparedSource.source,
      headers: preparedSource.headers,
      metadata: preparedSource.metadata,
      fallback: preparedSource.fallback
    });
    const streamUrl = new URL('/stream', baseUrl);
    streamUrl.searchParams.set('sourceId', sourceId);
    return streamUrl;
  }

  async resolveExtractorRedirectEntries(streamUrl, inheritedHeaders = null) {
    const normalizedUrl = String(streamUrl || '').trim();

    if (!isExtractorRedirectUrl(normalizedUrl)) {
      return [];
    }

    const cached = this.extractorRedirectCache.get(normalizedUrl);

    if (cached && cached.expiresAt > Date.now()) {
      touchMapEntry(this.extractorRedirectCache, normalizedUrl, cached);
      return Array.isArray(cached.value) ? cached.value.map((entry) => ({
        ...entry,
        headers: entry.headers && typeof entry.headers === 'object' ? { ...entry.headers } : null
      })) : [];
    }

    if (this.extractorRedirectInFlight.has(normalizedUrl)) {
      return this.extractorRedirectInFlight.get(normalizedUrl);
    }

    const request = (async () => {
      try {
        const extractedEntries = await resolveExtractorRedirect(normalizedUrl);
        const normalizedEntries = Array.isArray(extractedEntries)
          ? extractedEntries.flatMap((entry) => {
              if (!entry?.url || typeof entry.url !== 'string') {
                return [];
              }

              try {
                const resolvedUrl = this.normalizeHttpSource(entry.url);
                return [{
                  url: resolvedUrl,
                  headers: entry.headers && typeof entry.headers === 'object'
                    ? { ...entry.headers }
                    : (inheritedHeaders && typeof inheritedHeaders === 'object' ? { ...inheritedHeaders } : null),
                  sourceSite: entry.source || null,
                  size: entry.size || null,
                  title: entry.fileName || null,
                  filename: entry.fileName || extractFilenameFromUrl(resolvedUrl)
                }];
              } catch {
                return [];
              }
            })
          : [];

        normalizedEntries.sort((left, right) => getExtractorRedirectEntryScore(right) - getExtractorRedirectEntryScore(left));

        touchMapEntry(this.extractorRedirectCache, normalizedUrl, {
          expiresAt: Date.now() + EXTRACTOR_REDIRECT_CACHE_TTL_MS,
          value: normalizedEntries,
          approxBytes: getSerializedApproxBytes(JSON.stringify(normalizedEntries))
        });
        pruneMapByMaxEntries(this.extractorRedirectCache, EXTRACTOR_REDIRECT_CACHE_MAX_ENTRIES);

        return normalizedEntries.map((entry) => ({
          ...entry,
          headers: entry.headers && typeof entry.headers === 'object' ? { ...entry.headers } : null
        }));
      } catch (error) {
        logger.warn('extractor redirect resolution failed', {
          streamUrl: normalizedUrl,
          error
        });
        touchMapEntry(this.extractorRedirectCache, normalizedUrl, {
          expiresAt: Date.now() + (10 * 60 * 1000),
          value: [],
          approxBytes: 2
        });
        pruneMapByMaxEntries(this.extractorRedirectCache, EXTRACTOR_REDIRECT_CACHE_MAX_ENTRIES);
        return [];
      }
    })();

    this.extractorRedirectInFlight.set(normalizedUrl, request);

    try {
      return await request;
    } finally {
      this.extractorRedirectInFlight.delete(normalizedUrl);
    }
  }

  async resolveManagedHttpSource(streamUrl, inheritedHeaders = null) {
    if (!isExtractorRedirectUrl(streamUrl)) {
      return null;
    }

    const resolvedEntries = await this.resolveExtractorRedirectEntries(streamUrl, inheritedHeaders);
    return resolvedEntries[0] || null;
  }

  async resolveHubCloudUrls(streamUrl, inheritedHeaders = null) {
    const normalizedUrl = String(streamUrl || '').trim();

    if (!isHubCloudUrl(normalizedUrl)) {
      return [];
    }

    const cached = this.hubCloudCache.get(normalizedUrl);

    if (cached && cached.expiresAt > Date.now()) {
      touchMapEntry(this.hubCloudCache, normalizedUrl, cached);
      return Array.isArray(cached.value) ? cached.value.map((entry) => ({ ...entry })) : [];
    }

    if (this.hubCloudInFlight.has(normalizedUrl)) {
      return this.hubCloudInFlight.get(normalizedUrl);
    }

    const request = (async () => {
      try {
        const initialHeaders = {
          'User-Agent': HUBCLOUD_USER_AGENT,
          ...(inheritedHeaders && typeof inheritedHeaders === 'object' ? inheritedHeaders : {}),
          Referer: normalizedUrl
        };
        const initialHtml = await fetchTextWithTimeout(normalizedUrl, { headers: initialHeaders }, 8000);
        const redirectMatch = initialHtml.match(/var url ?= ?'([^']+)'/i)
          || initialHtml.match(/id=["']download["'][^>]*href=["']([^"']+)["']/i);

        if (!redirectMatch?.[1]) {
          touchMapEntry(this.hubCloudCache, normalizedUrl, {
            expiresAt: Date.now() + HUBCLOUD_CACHE_TTL_MS,
            value: [],
            approxBytes: 2
          });
          pruneMapByMaxEntries(this.hubCloudCache, config.HUBCLOUD_MEMORY_CACHE_MAX_ENTRIES);
          pruneMapByApproxBytes(this.hubCloudCache, config.HUBCLOUD_MEMORY_CACHE_MAX_MB * 1024 * 1024);
          return [];
        }

        const redirectUrl = new URL(redirectMatch[1], normalizedUrl).toString();
        const linksHtml = await fetchTextWithTimeout(redirectUrl, {
          headers: {
            'User-Agent': HUBCLOUD_USER_AGENT,
            Referer: normalizedUrl
          }
        }, 8000);
        const title = parseHubCloudTitle(linksHtml);
        const size = parseHubCloudSize(linksHtml);
        const candidates = extractHubCloudAnchorCandidates(linksHtml)
          .map((candidate) => ({
            ...candidate,
            score: getHubCloudCandidateScore(candidate),
            server: classifyHubCloudCandidate(candidate)
          }))
          .filter((candidate) => candidate.score > 0)
          .sort((left, right) => right.score - left.score);

        if (candidates.length === 0) {
          touchMapEntry(this.hubCloudCache, normalizedUrl, {
            expiresAt: Date.now() + HUBCLOUD_CACHE_TTL_MS,
            value: [],
            approxBytes: 2
          });
          pruneMapByMaxEntries(this.hubCloudCache, config.HUBCLOUD_MEMORY_CACHE_MAX_ENTRIES);
          pruneMapByApproxBytes(this.hubCloudCache, config.HUBCLOUD_MEMORY_CACHE_MAX_MB * 1024 * 1024);
          return [];
        }

        const deduped = [];
        const seenKeys = new Set();

        for (const candidate of candidates) {
          let resolvedHref = candidate.href;
          let resolvedHeaders = null;

          if (candidate.server === 'PixelServer') {
            try {
              const pixelUrl = new URL(candidate.href);
              const pixelPath = pixelUrl.pathname.replace(/\/api\/file\//i, '/u/');
              const refererUrl = new URL(pixelPath, pixelUrl.origin).toString();
              const downloadUrl = new URL(candidate.href);
              if (!/\/api\/file\//i.test(downloadUrl.pathname)) {
                downloadUrl.pathname = downloadUrl.pathname.replace(/\/u\//i, '/api/file/');
              }
              if (!downloadUrl.searchParams.has('download')) {
                downloadUrl.searchParams.set('download', '');
              }
              resolvedHref = downloadUrl.toString();
              resolvedHeaders = {
                Referer: refererUrl,
                'User-Agent': HUBCLOUD_USER_AGENT
              };
            } catch {
              resolvedHeaders = {
                Referer: redirectUrl,
                'User-Agent': HUBCLOUD_USER_AGENT
              };
            }
          } else if (candidate.href.toLowerCase().includes('hubcdn')) {
            resolvedHeaders = {
              Referer: redirectUrl,
              'User-Agent': HUBCLOUD_USER_AGENT
            };
          }

          const dedupeKey = `${candidate.server}:${resolvedHref}`;
          if (seenKeys.has(dedupeKey)) {
            continue;
          }
          seenKeys.add(dedupeKey);

          deduped.push({
            url: resolvedHref,
            headers: resolvedHeaders,
            sourceSite: `HubCloud (${candidate.server})`,
            title,
            size
          });
        }

        touchMapEntry(this.hubCloudCache, normalizedUrl, {
          expiresAt: Date.now() + HUBCLOUD_CACHE_TTL_MS,
          value: deduped,
          approxBytes: getSerializedApproxBytes(JSON.stringify(deduped))
        });
        pruneMapByMaxEntries(this.hubCloudCache, config.HUBCLOUD_MEMORY_CACHE_MAX_ENTRIES);
        pruneMapByApproxBytes(this.hubCloudCache, config.HUBCLOUD_MEMORY_CACHE_MAX_MB * 1024 * 1024);

        return deduped.map((entry) => ({ ...entry }));
      } catch (error) {
        logger.warn('hubcloud resolution failed', {
          streamUrl: normalizedUrl,
          error
        });
        touchMapEntry(this.hubCloudCache, normalizedUrl, {
          expiresAt: Date.now() + (10 * 60 * 1000),
          value: [],
          approxBytes: 2
        });
        pruneMapByMaxEntries(this.hubCloudCache, config.HUBCLOUD_MEMORY_CACHE_MAX_ENTRIES);
        pruneMapByApproxBytes(this.hubCloudCache, config.HUBCLOUD_MEMORY_CACHE_MAX_MB * 1024 * 1024);
        return [];
      }
    })();

    this.hubCloudInFlight.set(normalizedUrl, request);

    try {
      return await request;
    } finally {
      this.hubCloudInFlight.delete(normalizedUrl);
    }
  }

  async normalizeProviderStreams(_baseUrl, streams, fallbackProvider = null) {
    const settled = await Promise.all(streams.flatMap((stream) => {
      const provider = stream.provider || fallbackProvider;
      const variants = [];
      const normalizedUrl = typeof stream.url === 'string' ? stream.url.trim() : '';
      const normalizedMagnet = typeof stream.magnet === 'string'
        ? stream.magnet.trim()
        : typeof stream.torrent === 'string'
          ? stream.torrent.trim()
          : '';

      if (normalizedUrl) {
        variants.push({
          transport: 'http',
          source: normalizedUrl,
          headers: stream.headers
        });
      }

      if (normalizedMagnet) {
        variants.push({
          transport: 'torrent',
          source: normalizedMagnet,
          headers: null
        });
      }

      return variants.map(async (variant) => {
        try {
          const {
            url: _url,
            magnet: _magnet,
            torrent: _torrent,
            ...rest
          } = stream;
          const normalizedEntries = [];

          if (variant.transport === 'http' && isHubCloudUrl(normalizedUrl)) {
            const resolvedHubCloudEntries = await this.resolveHubCloudUrls(normalizedUrl, variant.headers);

            if (resolvedHubCloudEntries.length > 0) {
              for (const resolvedEntry of resolvedHubCloudEntries) {
                normalizedEntries.push({
                  ...rest,
                  provider,
                  ...(resolvedEntry.sourceSite ? { sourceSite: resolvedEntry.sourceSite } : {}),
                  ...(resolvedEntry.title || rest.title ? { title: resolvedEntry.title || rest.title } : {}),
                  ...(resolvedEntry.size || rest.size ? { size: resolvedEntry.size || rest.size } : {}),
                  headers: resolvedEntry.headers,
                  transport: 'http',
                  url: resolvedEntry.url,
                  filename: extractFilenameFromUrl(resolvedEntry.url)
                });
              }

              return normalizedEntries;
            }
          }

          return [{
            ...rest,
            provider,
            headers: variant.headers,
            transport: variant.transport,
            ...(variant.transport === 'http'
              ? {
                  url: normalizedUrl,
                  filename: extractFilenameFromUrl(normalizedUrl)
                }
              : {
                  magnet: normalizedMagnet,
                  infoHash: extractInfoHash(normalizedMagnet) || null,
                  sources: getTorrentSources(normalizedMagnet)
                })
          }];
        } catch (error) {
          logger.warn('provider stream skipped', {
            provider,
            source: variant.source,
            transport: variant.transport,
            error
          });
          return null;
        }
      });
    }));

    return settled.flat().filter(Boolean);
  }

  parseStremioStreamRequest(type, id) {
    const normalizedType = String(type || '').trim().toLowerCase();
    const normalizedId = String(id || '').trim();

    if (normalizedType !== 'movie' && normalizedType !== 'series') {
      throw createHttpError(400, 'Unsupported Stremio stream type');
    }

    if (normalizedType === 'movie') {
      return {
        mediaType: 'movie',
        imdbId: normalizedId,
        season: null,
        episode: null
      };
    }

    const [imdbId, rawSeason, rawEpisode] = normalizedId.split(':');
    const season = Number.parseInt(rawSeason, 10);
    const episode = Number.parseInt(rawEpisode, 10);

    if (!imdbId || !Number.isInteger(season) || !Number.isInteger(episode)) {
      throw createHttpError(400, 'Series stream id must be in imdb:season:episode format');
    }

    return {
      mediaType: 'series',
      imdbId,
      season,
      episode
    };
  }

  async prepareFallback(fallbackInput) {
    if (!fallbackInput || typeof fallbackInput !== 'object') {
      return null;
    }

    const fallbackType = normalizeRequestedType(fallbackInput.type);

    if (fallbackType !== 'torrent' || typeof fallbackInput.source !== 'string') {
      return null;
    }

    let magnet;

    try {
      magnet = enhanceMagnet(fallbackInput.source);
    } catch {
      return null;
    }

    const infoHash = extractInfoHash(magnet);

    if (!infoHash) {
      return null;
    }

    return {
      type: 'torrent',
      source: magnet,
      headers: null,
      metadata: fallbackInput.metadata && typeof fallbackInput.metadata === 'object'
        ? { ...fallbackInput.metadata }
        : null
    };
  }

  normalizeHttpSource(source) {
    let parsedUrl;

    try {
      parsedUrl = new URL(String(source || '').trim());
    } catch {
      throw createHttpError(400, 'Invalid upstream URL');
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw createHttpError(400, 'Only HTTP and HTTPS upstream URLs are supported');
    }

    if (!parsedUrl.hostname) {
      throw createHttpError(400, 'Invalid upstream URL');
    }

    return parsedUrl.toString();
  }

  async sendStream(res, descriptor) {
    if (config.MAX_ACTIVE_STREAMS > 0 && this.activeStreams >= config.MAX_ACTIVE_STREAMS) {
      logger.warn('stream rejected due to active stream limit', {
        activeStreams: this.activeStreams,
        maxActiveStreams: config.MAX_ACTIVE_STREAMS
      });
      throw createHttpError(503, 'Server is at active stream capacity');
    }

    const {
      stream,
      statusCode = 200,
      headers = {},
      cleanup = null
    } = descriptor;

    let completed = false;
    this.activeStreams += 1;

    try {
      res.status(statusCode);

      for (const [headerName, headerValue] of Object.entries(headers)) {
        if (headerValue !== undefined && headerValue !== null) {
          res.setHeader(headerName, String(headerValue));
        }
      }

      await pipeline(stream, res);
      completed = true;
    } catch (error) {
      logger.error('stream pipeline failed', {
        activeStreams: this.activeStreams,
        error
      });
      throw error;
    } finally {
      this.activeStreams = Math.max(this.activeStreams - 1, 0);

      if (typeof cleanup === 'function') {
        await cleanup({ completed });
      }
    }
  }
}
