import path from 'node:path';

const toPositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);

  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  return fallback;
};

const toNonNegativeInteger = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);

  if (Number.isInteger(parsed) && parsed >= 0) {
    return parsed;
  }

  return fallback;
};

const toPositiveNumber = (value, fallback) => {
  const parsed = Number.parseFloat(value ?? '');

  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return fallback;
};

const toBoundedInteger = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value ?? '', 10);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
};

const toBoundedIntegerAllowZero = (value, fallback, max) => {
  const parsed = Number.parseInt(value ?? '', 10);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, 0), max);
};

const toBoolean = (value, fallback) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
};

const toStringList = (value) => {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .filter((entry, index, values) => values.indexOf(entry) === index);
};

const toProxyRuleList = (value) => {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf(':');

      if (separatorIndex <= 0) {
        return null;
      }

      const pattern = entry.slice(0, separatorIndex).trim().toLowerCase();
      const proxyUrl = entry.slice(separatorIndex + 1).trim();

      if (!pattern || !proxyUrl) {
        return null;
      }

      try {
        const parsedProxyUrl = new URL(proxyUrl);

        if (!['http:', 'https:'].includes(parsedProxyUrl.protocol)) {
          return null;
        }

        return {
          pattern,
          proxyUrl: parsedProxyUrl.toString()
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

const toImdbTmdbOverrideMap = (value) => {
  if (typeof value !== 'string') {
    return Object.freeze({});
  }

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf(':');

      if (separatorIndex <= 0) {
        return null;
      }

      const imdbId = entry.slice(0, separatorIndex).trim();
      const tmdbId = Number.parseInt(entry.slice(separatorIndex + 1).trim(), 10);

      if (!/^tt\d+$/u.test(imdbId) || !Number.isInteger(tmdbId) || tmdbId <= 0) {
        return null;
      }

      return [imdbId, tmdbId];
    })
    .filter(Boolean);

  return Object.freeze(Object.fromEntries(entries));
};

export const config = Object.freeze({
  PORT: toPositiveInteger(process.env.PORT, 3000),
  CACHE_DIR: path.resolve(process.cwd(), process.env.CACHE_DIR || './cache'),
  PUBLIC_BASE_URL: String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/u, ''),
  REVERSE_PROXY_TARGET: String(process.env.REVERSE_PROXY_TARGET || '').trim().replace(/\/+$/u, ''),
  REVERSE_PROXY_TIMEOUT_SECONDS: toPositiveInteger(process.env.REVERSE_PROXY_TIMEOUT_SECONDS, 60),
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'sohil@123',
  SELF_HOST_MODE: toBoolean(process.env.SELF_HOST_MODE, true),
  MAXIMIZE_PROVIDER_COVERAGE: toBoolean(process.env.MAXIMIZE_PROVIDER_COVERAGE, true),
  STREMIO_ADDON_ID: process.env.STREMIO_ADDON_ID || 'community.nebulastreams.v2',
  STREMIO_ADDON_NAME: process.env.STREMIO_ADDON_NAME || 'NebulaStreams V2',
  CONFIGURATION_DESCRIPTION: String(process.env.CONFIGURATION_DESCRIPTION || 'Self-host optimized multi-provider HTTP stream addon for movies and series').trim() || 'Self-host optimized multi-provider HTTP stream addon for movies and series',
  DISABLED_SOURCES: toStringList(process.env.DISABLED_SOURCES || process.env.DISABLED_PROVIDERS || ''),
  PROXY_CONFIG: toProxyRuleList(process.env.PROXY_CONFIG || ''),
  FLARESOLVERR_ENDPOINT: String(process.env.FLARESOLVERR_ENDPOINT || '').trim().replace(/\/+$/u, ''),
  FLARESOLVERR_TIMEOUT_MS: toBoundedInteger(process.env.FLARESOLVERR_TIMEOUT_MS, 45000, 5000, 180000),
  IMDB_TMDB_OVERRIDES: toImdbTmdbOverrideMap(process.env.IMDB_TMDB_OVERRIDES || ''),
  DONATION_PRIMARY_URL: process.env.DONATION_PRIMARY_URL || 'https://ko-fi.com/redx115775',
  DONATION_SECONDARY_URL: process.env.DONATION_SECONDARY_URL || '',
  DONATION_NOWPAYMENTS_WIDGET_URL: process.env.DONATION_NOWPAYMENTS_WIDGET_URL || 'https://nowpayments.io/embeds/donation-widget?api_key=3acd79dd-66e2-48c4-9a7a-8938cb9a7a12',
  DONATION_CRYPTO_LABEL: process.env.DONATION_CRYPTO_LABEL || 'USDT (TRC20)',
  DONATION_CRYPTO_ADDRESS: process.env.DONATION_CRYPTO_ADDRESS || 'TF1WTj7BZVdU64rtMHsKwKrbqVXWtSynoD',
  TMDB_API_KEY: process.env.TMDB_API_KEY || '439c478a771f35c05022f9feabcca01c',
  REDIS_URL: String(process.env.REDIS_URL || '').trim(),
  REDIS_CACHE_PREFIX: String(process.env.REDIS_CACHE_PREFIX || 'nebulastreams-v2').trim() || 'nebulastreams-v2',
  MAX_CACHE_SIZE_GB: toPositiveNumber(process.env.MAX_CACHE_SIZE_GB, 20),
  CACHE_STATS_REFRESH_SECONDS: toBoundedInteger(process.env.CACHE_STATS_REFRESH_SECONDS, 30, 5, 3600),
  MAX_ACTIVE_TORRENTS: toBoundedInteger(process.env.MAX_ACTIVE_TORRENTS, 1, 1, 2),
  TORRENT_CONNECTIONS: toBoundedInteger(process.env.TORRENT_CONNECTIONS, 80, 80, 100),
  TORRENT_METADATA_TIMEOUT_SECONDS: toPositiveInteger(process.env.TORRENT_METADATA_TIMEOUT_SECONDS, 25),
  TORRENT_IDLE_TTL_SECONDS: toPositiveInteger(process.env.TORRENT_IDLE_TTL_SECONDS, 120),
  TORRENT_CLEANUP_INTERVAL_SECONDS: toPositiveInteger(process.env.TORRENT_CLEANUP_INTERVAL_SECONDS, 30),
  HTTP_STREAM_TIMEOUT_SECONDS: toPositiveInteger(process.env.HTTP_STREAM_TIMEOUT_SECONDS, 30),
  HTTP_MAX_SOCKETS: toBoundedInteger(process.env.HTTP_MAX_SOCKETS, 128, 16, 1024),
  HTTP_MAX_FREE_SOCKETS: toBoundedInteger(process.env.HTTP_MAX_FREE_SOCKETS, 32, 4, 256),
  HTTP_KEEP_ALIVE_MILLISECONDS: toPositiveInteger(process.env.HTTP_KEEP_ALIVE_MILLISECONDS, 1000),
  PUBLIC_RATE_LIMIT_WINDOW_SECONDS: toNonNegativeInteger(process.env.PUBLIC_RATE_LIMIT_WINDOW_SECONDS, 0),
  PUBLIC_RATE_LIMIT_MAX_REQUESTS: toNonNegativeInteger(process.env.PUBLIC_RATE_LIMIT_MAX_REQUESTS, 0),
  STREAM_RATE_LIMIT_WINDOW_SECONDS: toNonNegativeInteger(process.env.STREAM_RATE_LIMIT_WINDOW_SECONDS, 0),
  STREAM_RATE_LIMIT_MAX_REQUESTS: toNonNegativeInteger(process.env.STREAM_RATE_LIMIT_MAX_REQUESTS, 0),
  PROVIDER_RATE_LIMIT_WINDOW_SECONDS: toNonNegativeInteger(process.env.PROVIDER_RATE_LIMIT_WINDOW_SECONDS, 0),
  PROVIDER_RATE_LIMIT_MAX_REQUESTS: toNonNegativeInteger(process.env.PROVIDER_RATE_LIMIT_MAX_REQUESTS, 0),
  PROVIDER_TIMEOUT_SECONDS: toPositiveInteger(process.env.PROVIDER_TIMEOUT_SECONDS, 18),
  PROVIDER_CACHE_TTL_SECONDS: toPositiveInteger(process.env.PROVIDER_CACHE_TTL_SECONDS, 3600),
  PROVIDER_EMPTY_CACHE_TTL_SECONDS: toNonNegativeInteger(process.env.PROVIDER_EMPTY_CACHE_TTL_SECONDS, 30),
  PROVIDER_PRIORITY_EMPTY_CACHE_TTL_SECONDS: toPositiveInteger(process.env.PROVIDER_PRIORITY_EMPTY_CACHE_TTL_SECONDS, 60),
  PROVIDER_FAILURE_THRESHOLD: toNonNegativeInteger(process.env.PROVIDER_FAILURE_THRESHOLD, 0),
  PROVIDER_COOLDOWN_SECONDS: toNonNegativeInteger(process.env.PROVIDER_COOLDOWN_SECONDS, 0),
  PROVIDER_HOST_FAILURE_THRESHOLD: toNonNegativeInteger(process.env.PROVIDER_HOST_FAILURE_THRESHOLD, 0),
  PROVIDER_HOST_COOLDOWN_SECONDS: toNonNegativeInteger(process.env.PROVIDER_HOST_COOLDOWN_SECONDS, 0),
  PROVIDER_HOST_MAX_INFLIGHT: toBoundedInteger(process.env.PROVIDER_HOST_MAX_INFLIGHT, 6, 1, 64),
  PROVIDER_MAX_CONCURRENCY: toBoundedInteger(process.env.PROVIDER_MAX_CONCURRENCY, 12, 1, 128),
  PROVIDER_GLOBAL_MAX_INFLIGHT: toBoundedInteger(process.env.PROVIDER_GLOBAL_MAX_INFLIGHT, 48, 1, 512),
  PROVIDER_RESULT_MEMORY_CACHE_MAX_ENTRIES: toBoundedInteger(process.env.PROVIDER_RESULT_MEMORY_CACHE_MAX_ENTRIES, 2000, 50, 20000),
  PROVIDER_RESULT_MEMORY_CACHE_MAX_MB: toBoundedInteger(process.env.PROVIDER_RESULT_MEMORY_CACHE_MAX_MB, 32, 1, 1024),
  TMDB_METADATA_MEMORY_CACHE_MAX_ENTRIES: toBoundedInteger(process.env.TMDB_METADATA_MEMORY_CACHE_MAX_ENTRIES, 5000, 50, 50000),
  MAX_ACTIVE_STREAMS: toBoundedIntegerAllowZero(process.env.MAX_ACTIVE_STREAMS, 0, 10000),
  STREMIO_FAST_PROVIDER_CONCURRENCY: toBoundedInteger(process.env.STREMIO_FAST_PROVIDER_CONCURRENCY, 10, 1, 64),
  STREMIO_FAST_PROVIDER_LIMIT: toBoundedInteger(process.env.STREMIO_FAST_PROVIDER_LIMIT, 12, 1, 128),
  STREMIO_FAST_STREAM_LIMIT: toBoundedInteger(process.env.STREMIO_FAST_STREAM_LIMIT, 120, 8, 500),
  STREMIO_FAST_EARLY_RETURN_STREAMS: toBoundedInteger(process.env.STREMIO_FAST_EARLY_RETURN_STREAMS, 24, 4, 500),
  STREMIO_FAST_MIN_COMPLETED_PROVIDERS: toBoundedInteger(process.env.STREMIO_FAST_MIN_COMPLETED_PROVIDERS, 2, 1, 32),
  STREMIO_FAST_MAX_WAIT_MS: toBoundedInteger(process.env.STREMIO_FAST_MAX_WAIT_MS, 15000, 1000, 120000),
  STREMIO_DEFAULT_DIVERSITY_HOLD_MS: toBoundedInteger(process.env.STREMIO_DEFAULT_DIVERSITY_HOLD_MS, 12000, 1000, 60000),
  STREMIO_RESULT_CACHE_TTL_SECONDS: toPositiveInteger(process.env.STREMIO_RESULT_CACHE_TTL_SECONDS, 3600),
  STREMIO_EMPTY_RESULT_CACHE_TTL_SECONDS: toNonNegativeInteger(process.env.STREMIO_EMPTY_RESULT_CACHE_TTL_SECONDS, 1),
  STREMIO_WEAK_RESULT_CACHE_TTL_SECONDS: toPositiveInteger(process.env.STREMIO_WEAK_RESULT_CACHE_TTL_SECONDS, 300),
  STREMIO_RESULT_STALE_TTL_SECONDS: toBoundedInteger(process.env.STREMIO_RESULT_STALE_TTL_SECONDS, 43200, 300, 86400),
  STREMIO_LAST_GOOD_TTL_SECONDS: toBoundedInteger(process.env.STREMIO_LAST_GOOD_TTL_SECONDS, 259200, 3600, 1209600),
  STREMIO_RESULT_MEMORY_CACHE_MAX_ENTRIES: toBoundedInteger(process.env.STREMIO_RESULT_MEMORY_CACHE_MAX_ENTRIES, 2000, 50, 20000),
  STREMIO_RESULT_MEMORY_CACHE_MAX_MB: toBoundedInteger(process.env.STREMIO_RESULT_MEMORY_CACHE_MAX_MB, 64, 1, 1024),
  STREMIO_MAX_INFLIGHT_SEARCHES: toBoundedIntegerAllowZero(process.env.STREMIO_MAX_INFLIGHT_SEARCHES, 0, 10000),
  STREMIO_INFLIGHT_SLOT_WAIT_MS: toBoundedInteger(process.env.STREMIO_INFLIGHT_SLOT_WAIT_MS, 15000, 0, 120000),
  STREMIO_BACKGROUND_REFRESH_CONCURRENCY: toBoundedIntegerAllowZero(process.env.STREMIO_BACKGROUND_REFRESH_CONCURRENCY, 0, 64),
  STREMIO_BACKGROUND_REFRESH_QUEUE_MAX: toBoundedIntegerAllowZero(process.env.STREMIO_BACKGROUND_REFRESH_QUEUE_MAX, 0, 10000),
  STREMIO_BACKGROUND_REFRESH_MAX_INFLIGHT_SEARCHES: toBoundedInteger(process.env.STREMIO_BACKGROUND_REFRESH_MAX_INFLIGHT_SEARCHES, 64, 1, 2000),
  STREMIO_BACKGROUND_REFRESH_MAX_PROVIDER_EXECUTIONS: toBoundedInteger(process.env.STREMIO_BACKGROUND_REFRESH_MAX_PROVIDER_EXECUTIONS, 8, 1, 512),
  POPULAR_STREAM_PREWARM_ENABLED: toBoolean(process.env.POPULAR_STREAM_PREWARM_ENABLED, false),
  POPULAR_STREAM_PREWARM_INTERVAL_SECONDS: toBoundedInteger(process.env.POPULAR_STREAM_PREWARM_INTERVAL_SECONDS, 900, 60, 86400),
  POPULAR_STREAM_PREWARM_LIMIT: toBoundedInteger(process.env.POPULAR_STREAM_PREWARM_LIMIT, 20, 1, 100),
  POPULAR_STREAM_PREWARM_MAX_AGE_HOURS: toBoundedInteger(process.env.POPULAR_STREAM_PREWARM_MAX_AGE_HOURS, 72, 1, 720),
  POPULAR_STREAM_PREWARM_MAX_INFLIGHT_SEARCHES: toBoundedInteger(process.env.POPULAR_STREAM_PREWARM_MAX_INFLIGHT_SEARCHES, 32, 1, 2000),
  POPULAR_STREAM_PREWARM_MAX_PROVIDER_EXECUTIONS: toBoundedInteger(process.env.POPULAR_STREAM_PREWARM_MAX_PROVIDER_EXECUTIONS, 8, 1, 512),
  POPULAR_STREAM_SEARCH_MAX_ENTRIES: toBoundedInteger(process.env.POPULAR_STREAM_SEARCH_MAX_ENTRIES, 500, 50, 5000),
  POPULAR_STREAM_SEARCH_MAX_USERS_PER_ENTRY: toBoundedInteger(process.env.POPULAR_STREAM_SEARCH_MAX_USERS_PER_ENTRY, 200, 10, 2000),
  STREAM_RESULT_EXTERNAL_CACHE_ENABLED: toBoolean(process.env.STREAM_RESULT_EXTERNAL_CACHE_ENABLED, Boolean(String(process.env.REDIS_URL || '').trim())),
  HUBCLOUD_MEMORY_CACHE_MAX_ENTRIES: toBoundedInteger(process.env.HUBCLOUD_MEMORY_CACHE_MAX_ENTRIES, 300, 20, 3000),
  HUBCLOUD_MEMORY_CACHE_MAX_MB: toBoundedInteger(process.env.HUBCLOUD_MEMORY_CACHE_MAX_MB, 2, 1, 128),
  IMDB_RESOLVER_MEMORY_CACHE_MAX_ENTRIES: toBoundedInteger(process.env.IMDB_RESOLVER_MEMORY_CACHE_MAX_ENTRIES, 1000, 50, 5000),
  USER_TRACKER_MAX_ENTRIES: toBoundedInteger(process.env.USER_TRACKER_MAX_ENTRIES, 100000, 1000, 500000),
  USER_TRACKER_BASELINE_JSON: String(process.env.USER_TRACKER_BASELINE_JSON || '').trim(),
  SOURCE_REGISTRY_MAX_ENTRIES: toBoundedInteger(process.env.SOURCE_REGISTRY_MAX_ENTRIES, 5000, 100, 50000),
  RATE_LIMIT_MAX_BUCKETS: toBoundedInteger(process.env.RATE_LIMIT_MAX_BUCKETS, 100000, 1000, 1000000),
  MEMORY_GUARD_ENABLED: toBoolean(process.env.MEMORY_GUARD_ENABLED, false),
  MEMORY_GUARD_INTERVAL_SECONDS: toBoundedInteger(process.env.MEMORY_GUARD_INTERVAL_SECONDS, 15, 5, 300),
  MEMORY_GUARD_PRESSURE_PERCENT: toBoundedInteger(process.env.MEMORY_GUARD_PRESSURE_PERCENT, 75, 50, 98),
  MEMORY_GUARD_CRITICAL_PERCENT: toBoundedInteger(process.env.MEMORY_GUARD_CRITICAL_PERCENT, 88, 60, 99),
  MEMORY_GUARD_RESTART_PERCENT: toBoundedInteger(process.env.MEMORY_GUARD_RESTART_PERCENT, 94, 70, 99),
  MEMORY_GUARD_RESTART_AFTER_CRITICAL: toBoundedInteger(process.env.MEMORY_GUARD_RESTART_AFTER_CRITICAL, 3, 1, 10),
  MEMORY_GUARD_MIN_AVAILABLE_MB: toBoundedInteger(process.env.MEMORY_GUARD_MIN_AVAILABLE_MB, 128, 32, 1024),
  MEMORY_GUARD_SHED_SECONDS: toBoundedInteger(process.env.MEMORY_GUARD_SHED_SECONDS, 180, 10, 600),
  BOT_PROTECTION_ENABLED: toBoolean(process.env.BOT_PROTECTION_ENABLED, false),
  BOT_PROTECTION_WINDOW_SECONDS: toBoundedInteger(process.env.BOT_PROTECTION_WINDOW_SECONDS, 60, 10, 600),
  BOT_PROTECTION_EXPENSIVE_REQUEST_LIMIT: toBoundedInteger(process.env.BOT_PROTECTION_EXPENSIVE_REQUEST_LIMIT, 12, 4, 300),
  BOT_PROTECTION_SUSPICIOUS_REQUEST_LIMIT: toBoundedInteger(process.env.BOT_PROTECTION_SUSPICIOUS_REQUEST_LIMIT, 2, 1, 100),
  BOT_PROTECTION_BLOCK_SECONDS: toBoundedInteger(process.env.BOT_PROTECTION_BLOCK_SECONDS, 1800, 60, 86400),
  BOT_PROTECTION_MAX_TRACKED_CLIENTS: toBoundedInteger(process.env.BOT_PROTECTION_MAX_TRACKED_CLIENTS, 50000, 1000, 500000)
});

export const cacheConfig = Object.freeze({
  HTTP_CACHE_DIR: path.join(config.CACHE_DIR, 'http'),
  PROVIDER_CACHE_DIR: path.join(config.CACHE_DIR, 'provider-results'),
  STREMIO_RESULT_CACHE_DIR: path.join(config.CACHE_DIR, 'stremio-results'),
  TORRENT_CACHE_DIR: path.join(config.CACHE_DIR, 'torrents'),
  MAX_CACHE_SIZE_BYTES: Math.floor(config.MAX_CACHE_SIZE_GB * 1024 * 1024 * 1024),
  STATS_TTL_MS: config.CACHE_STATS_REFRESH_SECONDS * 1000
});
