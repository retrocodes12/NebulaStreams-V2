import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setMaxListeners } from 'node:events';
import { createRequire } from 'node:module';
import { promises as fsPromises } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { createHttpError } from './streamManager.js';

const require = createRequire(import.meta.url);
const { mkdir, readFile, readdir, rm, writeFile } = fsPromises;
const execFileAsync = promisify(execFile);
const providerAbortSignalStorage = new AsyncLocalStorage();
const providerFetchContextStorage = new AsyncLocalStorage();
const nativeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
const providerFetchHostInflight = new Map();
const PROVIDER_FETCH_MAX_RETRIES = 2;
const PROVIDER_FETCH_HOST_MAX_INFLIGHT = 2;
const PROVIDER_FETCH_HOST_MAX_INFLIGHT_OVERRIDES = Object.freeze({
  'enc-dec.app': 1,
  'api.videasy.net': 2,
  'api2.videasy.net': 2,
  'cloudnestra.com': 2,
  'vixsrc.to': 2,
  'vsembed.ru': 2,
  'vidsrc-embed.ru': 2
});
const getPrivateProviderSettingsKey = (providerId, privateProviderSettings = null) => {
  if (providerId !== 'showbox') {
    return '';
  }

  const uiToken = String(privateProviderSettings?.febboxUiCookie || '').trim();

  if (!uiToken) {
    return '';
  }

  return crypto.createHash('sha1').update(uiToken).digest('hex');
};
const getProviderCacheVersion = (providerId) => {
  if (providerId === '4khdhub' || providerId === '4khdhub_tv') {
    return '36';
  }

  if (providerId === 'rgshows') {
    return '24';
  }

  if (providerId === 'moviesmod') {
    return '25';
  }

  if (providerId === 'vixsrc') {
    return '28';
  }

  if (providerId === 'vidsrc') {
    return '25';
  }

  if (providerId === 'hdhub4u') {
    return '31';
  }

  if (providerId === 'hdmovie2') {
    return '25';
  }

  if (providerId === 'kisskh') {
    return '31';
  }

  if (providerId === 'showbox') {
    return '46';
  }

  if (providerId === 'latino-lamovie') {
    return '32';
  }

  if (providerId === 'latino-cinecalidad') {
    return '31';
  }

  if (providerId === 'uhdmovies') {
    return '34';
  }

  if (providerId === 'allyoucanwatch') {
    return '41';
  }

  if (providerId === 'netmirror') {
    return '40';
  }

  if (providerId === 'castle') {
    return '24';
  }

  return '23';
};
const prioritizePrivateTokenProviders = (providers, privateProviderSettings = null) => {
  const ordered = Array.isArray(providers) ? [...providers] : [];
  const hasFebboxUiCookie = Boolean(String(privateProviderSettings?.febboxUiCookie || '').trim());

  if (hasFebboxUiCookie && ordered.includes('showbox')) {
    ordered.splice(ordered.indexOf('showbox'), 1);
    ordered.unshift('showbox');
  }

  return ordered;
};

const getPrivateProviderPriorityBoost = (providerId, privateProviderSettings = null) => {
  const normalizedProviderId = String(providerId || '').trim().toLowerCase();

  if (
    normalizedProviderId === 'showbox' &&
    String(privateProviderSettings?.febboxUiCookie || '').trim()
  ) {
    return 180;
  }

  return 0;
};

const normalizeFetchUrl = (input) => {
  try {
    if (typeof input === 'string') {
      return new URL(input);
    }

    if (input instanceof URL) {
      return input;
    }

    if (input && typeof input.url === 'string') {
      return new URL(input.url);
    }
  } catch {
    return null;
  }

  return null;
};

const getFetchHostKey = (url) => {
  const hostname = String(url?.hostname || '').trim().toLowerCase();

  if (!hostname) {
    return 'default';
  }

  if (hostname.endsWith('.cloudnestra.com')) {
    return 'cloudnestra.com';
  }

  return hostname;
};

const getProviderFetchHostMaxInflight = (hostKey) =>
  PROVIDER_FETCH_HOST_MAX_INFLIGHT_OVERRIDES[hostKey] || PROVIDER_FETCH_HOST_MAX_INFLIGHT;

const withProviderFetchHostSlot = async (hostKey, fn, signal = null) => {
  const normalizedHostKey = String(hostKey || '').trim().toLowerCase() || 'default';
  const maxInflight = getProviderFetchHostMaxInflight(normalizedHostKey);

  while ((providerFetchHostInflight.get(normalizedHostKey) || 0) >= maxInflight) {
    await waitForProviderSlot(50, signal);
  }

  if (signal?.aborted) {
    throw getAbortReason(signal, 'Provider fetch aborted');
  }

  providerFetchHostInflight.set(
    normalizedHostKey,
    (providerFetchHostInflight.get(normalizedHostKey) || 0) + 1
  );

  try {
    return await fn();
  } finally {
    const remaining = Math.max((providerFetchHostInflight.get(normalizedHostKey) || 1) - 1, 0);

    if (remaining === 0) {
      providerFetchHostInflight.delete(normalizedHostKey);
    } else {
      providerFetchHostInflight.set(normalizedHostKey, remaining);
    }
  }
};

const parseRetryAfterMs = (headers, attempt) => {
  const retryAfter = headers && typeof headers.get === 'function'
    ? headers.get('retry-after')
    : '';
  const retryAfterSeconds = Number.parseInt(String(retryAfter || '').trim(), 10);

  if (Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, 5000);
  }

  return 250 * attempt;
};

const shouldRetryProviderFetch = (error, statusCode) => {
  if (statusCode === 429 || statusCode >= 500) {
    return true;
  }

  if (!error) {
    return false;
  }

  return /fetch failed|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|aborted|Connection reset/i
    .test(String(error.message || error));
};

const isRetryableProviderFetchMethod = (method, init = {}) => {
  const normalizedMethod = String(method || init?.method || 'GET').trim().toUpperCase();

  if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD') {
    return true;
  }

  if (normalizedMethod === 'POST') {
    return typeof init?.body === 'string' || init?.body === undefined || init?.body === null;
  }

  return false;
};

if (nativeFetch && !globalThis.fetch.__nebulaProviderAbortWrapped) {
  const fetchWithProviderAbort = (input, init = {}) => {
    const providerSignal = providerAbortSignalStorage.getStore();
    const providerFetchContext = providerFetchContextStorage.getStore();
    const requestUrl = normalizeFetchUrl(input);

    if (!providerSignal && !providerFetchContext) {
      return nativeFetch(input, init);
    }

    const nextInit = init && typeof init === 'object' ? { ...init } : {};

    const executeFetch = (requestInit) => {
      if (!providerFetchContext || !requestUrl || !['http:', 'https:'].includes(requestUrl.protocol)) {
        return nativeFetch(input, requestInit);
      }

      const hostKey = getFetchHostKey(requestUrl);
      const method = String(requestInit.method || 'GET').trim().toUpperCase();
      const canRetry = isRetryableProviderFetchMethod(method, requestInit);
      let attempt = 0;

      const run = async () => withProviderFetchHostSlot(hostKey, async () => {
        try {
          const response = await nativeFetch(input, requestInit);

          if (canRetry && attempt < PROVIDER_FETCH_MAX_RETRIES && shouldRetryProviderFetch(null, response.status)) {
            attempt += 1;
            await waitForProviderSlot(parseRetryAfterMs(response.headers, attempt), requestInit.signal);
            return run();
          }

          return response;
        } catch (error) {
          if (canRetry && attempt < PROVIDER_FETCH_MAX_RETRIES && shouldRetryProviderFetch(error, 0)) {
            attempt += 1;
            await waitForProviderSlot(200 * attempt, requestInit.signal);
            return run();
          }

          throw error;
        }
      }, requestInit.signal);

      return run();
    };

    if (!nextInit.signal || !providerSignal) {
      if (!nextInit.signal && providerSignal) {
        nextInit.signal = providerSignal;
      }

      return executeFetch(nextInit);
    }

    return withCombinedAbortSignal(
      [nextInit.signal, providerSignal],
      (combinedSignal) => executeFetch({
        ...nextInit,
        signal: combinedSignal
      }),
      'Provider request cancelled'
    );
  };

  Object.defineProperty(fetchWithProviderAbort, '__nebulaProviderAbortWrapped', {
    value: true
  });
  globalThis.fetch = fetchWithProviderAbort;
}

const PROVIDERS_DIR = path.resolve(process.cwd(), 'vendor/provider-pack/providers');
const LOCAL_PROVIDERS = Object.freeze({
  tamilian: {
    id: 'tamilian',
    label: 'Tamilian',
    modulePath: path.resolve(process.cwd(), 'providers/tamilian.cjs')
  },
  'torrent-scraper': {
    id: 'torrent-scraper',
    label: 'Torrent Scraper',
    modulePath: path.resolve(process.cwd(), 'providers/torrent-scraper.cjs'),
    runnerPath: path.resolve(process.cwd(), 'providers/torrent-scraper-runner.cjs'),
    invocation: 'subprocess'
  }
});
const IGNORED_PROVIDER_IDS = new Set(['test', 'test2']);
const DISABLED_PROVIDER_IDS = new Set(config.DISABLED_SOURCES || []);
const NO_EMPTY_CACHE_PROVIDERS = new Set([
  'allyoucanwatch',
  '4khdhub',
  '4khdhub_tv',
  'anime-sama',
  'animekai',
  'animesalt',
  'brazucaplay',
  'cinestream',
  'castle',
  'fmovies',
  'hdmovie2',
  'kisskh',
  'moviesmod',
  'showbox',
  'torrent-scraper',
  'vidsrc',
  'vixsrc'
]);
const PRIORITY_EMPTY_CACHE_PROVIDERS = new Set([
  '4khdhub',
  '4khdhub_tv',
  'allyoucanwatch',
  'hdhub4u',
  'uhdmovies',
  'flixindia',
  'tamilian',
  'streamflix',
  'moviebox',
  'vidlink'
]);
const PRIORITY_COOLDOWN_HOSTS = new Set(['4khdhub', 'hdhub4u']);
const PROVIDER_HOST_MAX_INFLIGHT_OVERRIDES = Object.freeze({
  allyoucanwatch: 2,
  '4khdhub': 4,
  hdhub4u: 4,
  showbox: 4,
  castle: 3,
  vidsrc: 4,
  vixsrc: 4
});
const EXPLICIT_PROVIDER_GLOBAL_LANE_BONUS = 4;
const EXPLICIT_PROVIDER_HOST_LANE_BONUS = 2;
const PROVIDER_TIMEOUT_OVERRIDES_SECONDS = Object.freeze({
  '4khdhub': 25,
  '4khdhub_tv': 25,
  allyoucanwatch: 30,
  brazucaplay: 20,
  cinestream: 20,
  fmovies: 20,
  hdhub4u: 25,
  uhdmovies: 25,
  castle: 25,
  moviebox: 20,
  moviesmod: 40,
  rgshows: 20,
  streamflix: 20,
  vidsrc: 20,
  vidlink: 20,
  videasy: 20,
  animekai: 25,
  'latino-lamovie': 25,
  'latino-cinecalidad': 25,
  'latino-embed69': 20,
  'latino-xupalace': 20,
  'latino-seriesmetro': 20,
  'arabic-faselhd': 30,
  'arabic-kirmzi': 25,
  'arabic-witanime': 30,
  'arabic-animecloud': 30,
  'arabic-cineby': 25
});
const PROVIDER_FAST_TIMEOUT_OVERRIDES_SECONDS = Object.freeze({
  '4khdhub': 6,
  '4khdhub_tv': 6,
  hdhub4u: 8,
  uhdmovies: 8,
  showbox: 8
});
const getProviderTimeoutSeconds = (providerId, params = null) => {
  if (params?.enforceFastTimeout) {
    const defaultFastTimeout = Math.min(config.PROVIDER_TIMEOUT_SECONDS, 5);
    return PROVIDER_FAST_TIMEOUT_OVERRIDES_SECONDS[providerId] || defaultFastTimeout;
  }

  if (
    providerId === 'showbox' &&
    String(params?.privateProviderSettings?.febboxUiCookie || '').trim()
  ) {
    return 25;
  }

  return PROVIDER_TIMEOUT_OVERRIDES_SECONDS[providerId] || config.PROVIDER_TIMEOUT_SECONDS;
};
const PROVIDER_PRIORITY = [
  '4khdhub',
  '4khdhub_tv',
  'uhdmovies',
  'hdhub4u',
  'vidlink',
  'cinestream',
  'castle',
  'moviebox',
  'allyoucanwatch',
  'kisskh',
  'onlykdrama',
  'rgshows',
  'streamflix',
  'netmirror',
  'videasy',
  'vidsrc',
  'fmovies',
  'tamilian',
  'streamflix_eng',
  'moviesmod',
  'hdmovie2',
  'movix',
  'flixindia',
  'isaidub',
  'allwish',
  'allmovieland',
  'vidmody-tr',
  'turkish-m3u',
  'rectv-tr',
  'diziyou',
  'it-streamingcommunity',
  'it-guardahd',
  'it-guardaserie',
  'it-guardoserie',
  'it-cc',
  'it-animeunity',
  'it-animeworld',
  'it-animesaturn',
  'latino-lamovie',
  'latino-embed69',
  'latino-cinecalidad',
  'latino-xupalace',
  'latino-seriesmetro',
  'arabic-faselhd',
  'arabic-cineby',
  'arabic-witanime',
  'arabic-animecloud',
  'arabic-kirmzi',
  'torrent-scraper'
];
const STREMIO_ALWAYS_EXCLUDED_PROVIDERS = new Set(['torrent-scraper']);
const STREMIO_DEFAULT_ONLY_EXCLUDED_PROVIDERS = new Set(['allyoucanwatch']);
const WEB_READY_FALLBACK_PROVIDERS = Object.freeze(['moviebox', 'streamflix', 'videasy', 'fmovies', 'vidlink', 'cinestream', 'vidsrc', 'vixsrc']);
const DEFAULT_DIVERSITY_FALLBACK_PROVIDERS = Object.freeze(['moviebox', 'streamflix', 'videasy', 'fmovies', 'rgshows', 'vidsrc', 'vixsrc']);
const CATALOG_MOVIE_FALLBACK_PROVIDERS = Object.freeze(['vidsrc', 'vixsrc', 'moviebox', 'vidlink', 'cinestream', 'streamflix', 'videasy', 'fmovies']);
const OLD_TITLE_FALLBACK_PROVIDERS = Object.freeze(['vidsrc', 'vixsrc', 'castle', 'moviebox', 'vidlink', 'cinestream']);
const OLD_TITLE_PRIORITY_PROVIDERS = Object.freeze(['4khdhub', '4khdhub_tv', 'uhdmovies', 'hdhub4u', 'vidsrc', 'vixsrc', 'castle', 'cinestream', 'vidlink', 'moviebox']);
const OLD_TITLE_PRIMARY_PROVIDERS = Object.freeze(['4khdhub', '4khdhub_tv', 'hdhub4u', 'uhdmovies']);
const UNKNOWN_TV_PROFILE_FALLBACK_PROVIDERS = Object.freeze(['animeworld', 'animesalt', 'moviebox']);
const PRIMARY_FAST_PROVIDER_IDS = new Set(['4khdhub', '4khdhub_tv', 'uhdmovies', 'hdhub4u', 'flixindia', 'tamilian']);
const BROKEN_ANIME_FAST_PROVIDERS = new Set(['anime-sama', 'animekai']);
const SIGNAL_INCOMPATIBLE_PROVIDERS = new Set(['fmovies', 'vidsrc']);
const STALE_IF_ERROR_PROVIDERS = new Set(['fmovies', 'brazucaplay', 'showbox', 'vidsrc']);
const ANIME_SPECIALIST_PROVIDERS = new Set([
  'animesalt',
  'animeworld',
  'it-animeunity',
  'it-animeworld',
  'it-animesaturn',
  'arabic-witanime',
  'arabic-animecloud',
  'kisskh'
]);
const TMDB_METADATA_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TMDB_METADATA_RETRY_DELAYS_MS = Object.freeze([250, 750]);
const CONTENT_PROVIDER_BOOSTS = Object.freeze({
  anime: Object.freeze({
    animeworld: 190,
    animesalt: 180,
    moviebox: 172,
    '4khdhub_tv': 168,
    '4khdhub': 166,
    hdhub4u: 150,
    'it-animeunity': 120,
    'it-animeworld': 115,
    'it-animesaturn': 110,
    'arabic-witanime': 105,
    'arabic-animecloud': 100,
    'arabic-cineby': 95,
    kisskh: 92,
    'anime-sama': 40,
    animekai: 35
  }),
  asian_drama: Object.freeze({
    kisskh: 205,
    onlykdrama: 70,
    showbox: 45
  }),
  kdrama: Object.freeze({
    kisskh: 190,
    onlykdrama: 180,
    showbox: 40
  }),
  indian: Object.freeze({
    '4khdhub': 230,
    '4khdhub_tv': 225,
    uhdmovies: 223,
    hdhub4u: 220,
    flixindia: 205,
    tamilian: 165,
    isaidub: 155,
    hindmoviez: 145,
    streamflix: 110,
    streamflix_eng: 105,
    moviesmod: 100,
    allwish: 80,
    allmovieland: 70
  }),
  turkish: Object.freeze({
    'vidmody-tr': 195,
    'turkish-m3u': 190,
    'rectv-tr': 185,
    diziyou: 180,
    sinemacx: 170,
    cinemacity: 120
  }),
  italian: Object.freeze({
    'it-streamingcommunity': 195,
    'it-guardahd': 185,
    'it-guardaserie': 180,
    'it-guardoserie': 175,
    'it-cc': 155,
    'it-animeunity': 140,
    'it-animeworld': 135,
    'it-animesaturn': 130
  }),
  portuguese: Object.freeze({
    brazucaplay: 180
  }),
  spanish: Object.freeze({
    'latino-lamovie': 195,
    'latino-cinecalidad': 190,
    'latino-embed69': 45,
    'latino-xupalace': 40,
    'latino-seriesmetro': 35,
    lamovie: 170,
    purstream: 130
  }),
  arabic: Object.freeze({
    'arabic-faselhd': 195,
    'arabic-cineby': 185,
    'arabic-witanime': 175,
    'arabic-animecloud': 170,
    'arabic-kirmzi': 150
  })
});
const PROVIDER_RELIABILITY_SCORES = Object.freeze({
  '4khdhub': 165,
  '4khdhub_tv': 160,
  hdhub4u: 150,
  uhdmovies: 145,
  vidlink: 120,
  cinestream: 118,
  castle: 116,
  videasy: 115,
  tamilian: 104,
  'torrent-scraper': 80,
  streamflix: 105,
  netmirror: 100,
  moviebox: 98,
  movix: 96,
  dooflix: 94,
  vixsrc: 92,
  hdmovie2: 90,
  lamovie: 88,
  purstream: 86,
  'vidmody-tr': 104,
  'turkish-m3u': 102,
  'rectv-tr': 100,
  diziyou: 98,
  'it-streamingcommunity': 106,
  'it-guardahd': 102,
  'it-guardaserie': 100,
  'it-guardoserie': 98,
  'it-cc': 94,
  'it-animeunity': 96,
  'it-animeworld': 94,
  'it-animesaturn': 92,
  'latino-lamovie': 106,
  'latino-embed69': 104,
  'latino-cinecalidad': 102,
  'latino-xupalace': 100,
  'latino-seriesmetro': 98,
  'arabic-faselhd': 106,
  'arabic-cineby': 104,
  'arabic-witanime': 100,
  'arabic-animecloud': 98,
  'arabic-kirmzi': 94
});
const INDIAN_LANGUAGES = new Set(['ta', 'te', 'hi', 'ml', 'kn']);
const ASIAN_DRAMA_LANGUAGES = new Set(['ko', 'ja', 'zh', 'th']);
const ASIAN_DRAMA_COUNTRIES = new Set(['KR', 'JP', 'CN', 'TW', 'TH', 'HK']);
const ARABIC_COUNTRIES = new Set(['AE', 'BH', 'DZ', 'EG', 'IQ', 'JO', 'KW', 'LB', 'MA', 'OM', 'PS', 'QA', 'SA', 'SY', 'TN', 'YE']);
const PROVIDER_LABEL_OVERRIDES = Object.freeze({
  'it-streamingcommunity': 'StreamingCommunity IT',
  'it-guardahd': 'GuardaHD',
  'it-guardaserie': 'GuardaSerie',
  'it-guardoserie': 'GuardoSerie',
  'it-cc': 'CC IT',
  'it-animeunity': 'AnimeUnity IT',
  'it-animeworld': 'AnimeWorld IT',
  'it-animesaturn': 'AnimeSaturn',
  'latino-lamovie': 'LaMovie Latino',
  'latino-cinecalidad': 'CineCalidad',
  'latino-embed69': 'Embed69 Latino',
  'latino-xupalace': 'XuPalace',
  'latino-seriesmetro': 'SeriesMetro',
  'arabic-faselhd': 'FaselHD',
  'arabic-kirmzi': 'Kirmzi',
  'arabic-witanime': 'WitAnime',
  'arabic-animecloud': 'AnimeCloud Arabic',
  'arabic-cineby': 'Cineby Arabic'
});

const toLabel = (providerId) =>
  PROVIDER_LABEL_OVERRIDES[providerId]
  || providerId
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());

const discoverProviders = () => {
  const discovered = new Map();

  if (!fs.existsSync(PROVIDERS_DIR)) {
    return discovered;
  }

  const providerFiles = fs.readdirSync(PROVIDERS_DIR)
    .filter((fileName) => fileName.endsWith('.js'))
    .sort();

  for (const fileName of providerFiles) {
    const providerId = path.basename(fileName, '.js').toLowerCase();

    if (IGNORED_PROVIDER_IDS.has(providerId) || DISABLED_PROVIDER_IDS.has(providerId)) {
      continue;
    }

    discovered.set(providerId, {
      id: providerId,
      label: toLabel(providerId),
      modulePath: path.join(PROVIDERS_DIR, fileName)
    });
  }

  for (const provider of Object.values(LOCAL_PROVIDERS)) {
    if (DISABLED_PROVIDER_IDS.has(provider.id)) {
      continue;
    }

    discovered.set(provider.id, provider);
  }

  return discovered;
};

const toOptionalInteger = (value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
};

const mapConcurrent = async (items, concurrency, iteratee) => {
  const results = new Array(items.length);
  let currentIndex = 0;

  const worker = async () => {
    while (true) {
      const index = currentIndex;
      currentIndex += 1;

      if (index >= items.length) {
        return;
      }

      results[index] = await iteratee(items[index], index);
    }
  };

  const workers = Array.from({
    length: Math.min(concurrency, items.length)
  }, () => worker());

  await Promise.all(workers);
  return results;
};

const copyStreams = (streams) => streams.map((stream) => ({ ...stream }));
const copyFastSearchResult = (result) => ({
  reason: result?.reason || 'all-complete',
  providers: Array.isArray(result?.providers) ? [...result.providers] : [],
  tried: Array.isArray(result?.tried)
    ? result.tried.map((entry) => ({
      provider: entry.provider,
      count: Number.isFinite(entry.count) ? entry.count : 0
    }))
    : [],
  streams: copyStreams(Array.isArray(result?.streams) ? result.streams : [])
});
const serializeStreams = (streams) => JSON.stringify(Array.isArray(streams) ? streams : []);
const deserializeStreams = (payload) => {
  if (typeof payload !== 'string' || !payload) {
    return [];
  }

  try {
    const parsed = JSON.parse(payload);
    return Array.isArray(parsed) ? copyStreams(parsed) : [];
  } catch {
    return [];
  }
};
const getSerializedApproxBytes = (payload) => Buffer.byteLength(String(payload || ''), 'utf8');
const isVerifiedEmptyCacheEntry = (payload, hydratedStreams) =>
  Array.isArray(hydratedStreams)
  && hydratedStreams.length === 0
  && payload?.verifiedEmpty === true;

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

const getAbortReason = (signal, fallbackMessage = 'Provider query aborted') => {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }

  return createHttpError(504, fallbackMessage);
};

const ensureAbortSignalListenerCapacity = (signal, minListeners = 64) => {
  if (!signal) {
    return;
  }

  try {
    setMaxListeners(minListeners, signal);
  } catch {
    // Ignore unsupported EventTarget implementations.
  }
};

const createCombinedAbortSignal = (signals, fallbackMessage = 'Provider query aborted') => {
  const activeSignals = signals.filter(Boolean);

  if (activeSignals.length === 0) {
    return {
      signal: null,
      cleanup: () => {}
    };
  }

  if (activeSignals.length === 1) {
    return {
      signal: activeSignals[0],
      cleanup: () => {}
    };
  }

  const controller = new AbortController();
  const listeners = [];
  let cleaned = false;

  ensureAbortSignalListenerCapacity(controller.signal);

  const cleanup = () => {
    if (cleaned) {
      return;
    }

    cleaned = true;

    for (const [signal, listener] of listeners) {
      signal.removeEventListener('abort', listener);
    }
  };

  const abortFromSignal = (sourceSignal) => {
    if (controller.signal.aborted) {
      return;
    }

    controller.abort(sourceSignal?.reason ?? getAbortReason(sourceSignal, fallbackMessage));
  };

  for (const sourceSignal of activeSignals) {
    ensureAbortSignalListenerCapacity(sourceSignal);

    if (sourceSignal.aborted) {
      abortFromSignal(sourceSignal);
      cleanup();
      return {
        signal: controller.signal,
        cleanup
      };
    }

    const onAbort = () => abortFromSignal(sourceSignal);
    sourceSignal.addEventListener('abort', onAbort, { once: true });
    listeners.push([sourceSignal, onAbort]);
  }

  return {
    signal: controller.signal,
    cleanup
  };
};

const withCombinedAbortSignal = async (signals, callback, fallbackMessage = 'Provider query aborted') => {
  const { signal, cleanup } = createCombinedAbortSignal(signals, fallbackMessage);

  try {
    return await callback(signal);
  } finally {
    cleanup();
  }
};

const waitForProviderSlot = (delayMs, signal) => {
  if (signal?.aborted) {
    return Promise.reject(getAbortReason(signal));
  }

  return new Promise((resolve, reject) => {
    let timeoutId;

    const cleanup = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(getAbortReason(signal));
    };

    timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    timeoutId.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

const getProviderFailureThreshold = (providerId) =>
  config.PROVIDER_FAILURE_THRESHOLD <= 0
    ? 0
    :
  PRIORITY_EMPTY_CACHE_PROVIDERS.has(providerId)
    ? config.PROVIDER_FAILURE_THRESHOLD * 4
    : config.PROVIDER_FAILURE_THRESHOLD;

const getProviderCooldownMs = (providerId) =>
  config.PROVIDER_COOLDOWN_SECONDS <= 0
    ? 0
    :
  (PRIORITY_EMPTY_CACHE_PROVIDERS.has(providerId) ? 30 : config.PROVIDER_COOLDOWN_SECONDS) * 1000;

const getProviderHostFailureThreshold = (hostKey) =>
  config.PROVIDER_HOST_FAILURE_THRESHOLD <= 0
    ? 0
    :
  PRIORITY_COOLDOWN_HOSTS.has(hostKey)
    ? config.PROVIDER_HOST_FAILURE_THRESHOLD * 4
    : config.PROVIDER_HOST_FAILURE_THRESHOLD;

const getProviderHostCooldownMs = (hostKey) =>
  config.PROVIDER_HOST_COOLDOWN_SECONDS <= 0
    ? 0
    :
  (PRIORITY_COOLDOWN_HOSTS.has(hostKey) ? 30 : config.PROVIDER_HOST_COOLDOWN_SECONDS) * 1000;

const sanitizeHeaders = (headers) => {
  if (!headers || typeof headers !== 'object') {
    return null;
  }

  const sanitized = {};

  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (typeof headerName !== 'string' || typeof headerValue !== 'string') {
      continue;
    }

    const normalizedName = headerName.trim();
    const normalizedValue = headerValue.trim();

    if (!normalizedName || !normalizedValue) {
      continue;
    }

    sanitized[normalizedName] = normalizedValue;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null;
};

const sanitizeProviderStream = (stream) => {
  if (!stream || typeof stream !== 'object') {
    return null;
  }

  const normalizedMagnet = typeof stream.magnet === 'string'
    ? String(stream.magnet).trim()
    : typeof stream.torrent === 'string'
      ? String(stream.torrent).trim()
      : '';

  if (normalizedMagnet && !normalizedMagnet.startsWith('magnet:?')) {
    return null;
  }

  const normalizedUrl = String(stream.url || '').trim();
  let parsedUrl = null;

  if (normalizedUrl) {
    try {
      parsedUrl = new URL(normalizedUrl);
    } catch {
      parsedUrl = null;
    }
  }

  if (parsedUrl && !['http:', 'https:'].includes(parsedUrl.protocol)) {
    parsedUrl = null;
  }

  if (!normalizedMagnet && !parsedUrl) {
    return null;
  }

  const {
    headers: _headers,
    magnet: _magnet,
    torrent: _torrent,
    url: _url,
    ...rest
  } = stream;

  return {
    ...rest,
    ...(parsedUrl ? { url: parsedUrl.toString() } : {}),
    ...(normalizedMagnet ? { magnet: normalizedMagnet } : {}),
    headers: sanitizeHeaders(stream.headers)
  };
};

const toQualityScore = (quality) => {
  const normalized = String(quality || '').trim().toLowerCase();

  if (!normalized) {
    return 0;
  }

  if (normalized === '4k') {
    return 2160;
  }

  if (normalized === 'auto' || normalized === 'adaptive') {
    return 850;
  }

  const match = normalized.match(/(\d{3,4})/);

  if (match?.[1]) {
    return Number.parseInt(match[1], 10);
  }

  return 0;
};

const toTransportScore = (url) => {
  const normalized = String(url || '').toLowerCase();

  if (normalized.includes('.mp4') || normalized.includes('.mkv') || normalized.includes('.avi') || normalized.includes('.webm')) {
    return 40;
  }

  if (normalized.includes('.m3u8')) {
    return 32;
  }

  if (normalized.includes('pixeldrain') || normalized.includes('vidlink') || normalized.includes('videasy')) {
    return 24;
  }

  return 10;
};

const toHeaderScore = (headers) => {
  if (!headers || typeof headers !== 'object') {
    return 0;
  }

  const headerNames = Object.keys(headers).map((headerName) => headerName.toLowerCase());
  let score = 0;

  if (headerNames.includes('referer')) {
    score += 2;
  }

  if (headerNames.includes('user-agent')) {
    score += 1;
  }

  return score;
};

const toSeederScore = (stream) => {
  const seeders = Number.parseInt(
    stream?.seeders ?? stream?.seeds ?? stream?.seed ?? '',
    10
  );

  if (!Number.isInteger(seeders) || seeders <= 0) {
    return 0;
  }

  return Math.min(seeders, 500);
};

const getProviderContentBoost = (providerId, contentProfile) => {
  if (!contentProfile || !Array.isArray(contentProfile.tags)) {
    return 0;
  }

  return contentProfile.tags.reduce((total, tag) => {
    const tagBoosts = CONTENT_PROVIDER_BOOSTS[tag];

    if (!tagBoosts || !Object.hasOwn(tagBoosts, providerId)) {
      return total;
    }

    return total + tagBoosts[providerId];
  }, 0);
};

const toProviderScore = (providerId, providerOrder, contentProfile = null, privateProviderSettings = null) => {
  const baseReliability = Object.hasOwn(PROVIDER_RELIABILITY_SCORES, providerId)
    ? PROVIDER_RELIABILITY_SCORES[providerId]
    : 0;
  const contentBoost = getProviderContentBoost(providerId, contentProfile);
  const privatePriorityBoost = getPrivateProviderPriorityBoost(providerId, privateProviderSettings);
  const index = providerOrder.indexOf(providerId);

  if (index === -1) {
    return baseReliability + contentBoost + privatePriorityBoost;
  }

  return baseReliability + contentBoost + privatePriorityBoost + Math.max(providerOrder.length - index, 1);
};

const getProviderFamilyId = (providerId) => {
  const normalized = String(providerId || '').trim().toLowerCase();

  if (normalized === '4khdhub_tv') {
    return '4khdhub';
  }

  return normalized || 'unknown';
};

const getDistinctProviderFamilyCount = (streams = []) => (
  new Set(
    streams
      .map((stream) => getProviderFamilyId(stream?.provider))
      .filter(Boolean)
  ).size
);

const rankStream = (stream, providerOrder, contentProfile = null, privateProviderSettings = null) => {
  const providerId = String(stream.provider || '').toLowerCase();
  const qualityScore = toQualityScore(stream.quality);
  const transportScore = stream.url ? toTransportScore(stream.url) : stream.magnet ? 6 : 10;
  const headerScore = toHeaderScore(stream.headers);
  const seederScore = toSeederScore(stream);
  const providerScore = toProviderScore(providerId, providerOrder, contentProfile, privateProviderSettings);

  return (providerScore * 1000000) + (qualityScore * 1000) + (seederScore * 10) + (transportScore * 10) + headerScore;
};

const mergeAndRankProviderStreams = (
  settledResults,
  providerOrder,
  contentProfile = null,
  limit = Infinity,
  privateProviderSettings = null
) => {
  const mergedStreams = [];
  const seenSources = new Set();

  for (const result of settledResults) {
    if (!result) {
      continue;
    }

    for (const stream of result.streams) {
      const normalizedUrl = String(stream.url || '').trim();
      const normalizedMagnet = String(stream.magnet || stream.torrent || '').trim();
      const dedupeKey = JSON.stringify({
        url: normalizedUrl || null,
        magnet: normalizedMagnet || null
      });

      if ((!normalizedUrl && !normalizedMagnet) || seenSources.has(dedupeKey)) {
        continue;
      }

      seenSources.add(dedupeKey);
      mergedStreams.push({
        ...stream,
        provider: stream.provider || result.provider
      });
    }
  }

  mergedStreams.sort((left, right) => {
    const scoreDelta = rankStream(right, providerOrder, contentProfile, privateProviderSettings)
      - rankStream(left, providerOrder, contentProfile, privateProviderSettings);

    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    return String(left.name || left.title || left.url).localeCompare(
      String(right.name || right.title || right.url)
    );
  });

  return Number.isFinite(limit)
    ? mergedStreams.slice(0, limit)
    : mergedStreams;
};

const applyPerProviderSoftLimit = (streams, limit, perProviderSoftLimit = Infinity) => {
  if (!Number.isFinite(limit)) {
    return streams;
  }

  if (!Number.isFinite(perProviderSoftLimit) || perProviderSoftLimit < 1) {
    return streams.slice(0, limit);
  }

  const selected = [];
  const deferred = [];
  const providerCounts = new Map();

  for (const stream of streams) {
    const providerId = String(stream.provider || '').trim().toLowerCase() || 'unknown';
    const count = providerCounts.get(providerId) || 0;

    if (count < perProviderSoftLimit) {
      providerCounts.set(providerId, count + 1);
      selected.push(stream);
    } else {
      deferred.push(stream);
    }

    if (selected.length >= limit) {
      return selected;
    }
  }

  for (const stream of deferred) {
    selected.push(stream);
    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
};

const applyPreferredProviderDiversity = (streams, limit, preferredProviders = []) => {
  if (!Number.isFinite(limit) || limit < 1 || !Array.isArray(preferredProviders) || preferredProviders.length === 0) {
    return Number.isFinite(limit) ? streams.slice(0, limit) : streams;
  }

  const normalizedPreferredProviders = preferredProviders
    .map((providerId) => String(providerId || '').trim().toLowerCase())
    .filter(Boolean);

  if (normalizedPreferredProviders.length === 0) {
    return streams.slice(0, limit);
  }

  const selected = streams
    .slice(0, limit)
    .map((stream, index) => ({ stream, originalIndex: index }));
  const indexedStreams = streams.map((stream, index) => ({ stream, originalIndex: index }));

  for (const preferredProvider of normalizedPreferredProviders) {
    const selectedProviderSet = new Set(
      selected.map(({ stream }) => String(stream.provider || '').trim().toLowerCase())
    );

    if (selectedProviderSet.has(preferredProvider)) {
      continue;
    }

    const candidate = indexedStreams.find(({ stream, originalIndex }) =>
      originalIndex >= limit
      && String(stream.provider || '').trim().toLowerCase() === preferredProvider
    );

    if (!candidate) {
      continue;
    }

    const providerCounts = new Map();

    for (const { stream } of selected) {
      const providerId = String(stream.provider || '').trim().toLowerCase();
      providerCounts.set(providerId, (providerCounts.get(providerId) || 0) + 1);
    }

    let replaceAt = -1;

    for (let index = selected.length - 1; index >= 0; index -= 1) {
      const providerId = String(selected[index]?.stream?.provider || '').trim().toLowerCase();

      if (normalizedPreferredProviders.includes(providerId)) {
        continue;
      }

      if ((providerCounts.get(providerId) || 0) > 1) {
        replaceAt = index;
        break;
      }
    }

    if (replaceAt === -1) {
      continue;
    }

    selected[replaceAt] = candidate;
  }

  return selected
    .map(({ stream }) => stream)
    .slice(0, limit);
};

const reprioritizeProviders = (providers, preferredProviders = []) => {
  if (!Array.isArray(providers) || providers.length === 0 || !Array.isArray(preferredProviders) || preferredProviders.length === 0) {
    return Array.isArray(providers) ? [...providers] : [];
  }

  const preferredSet = new Set(preferredProviders);

  return [
    ...preferredProviders.filter((providerId) => providers.includes(providerId)),
    ...providers.filter((providerId) => !preferredSet.has(providerId))
  ];
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FAST_PROVIDER_STAGGER_DELAYS_MS = Object.freeze([100, 200, 300]);
const getFastProviderStaggerDelayMs = (launchIndex) => {
  if (!Number.isInteger(launchIndex) || launchIndex <= 0) {
    return 0;
  }

  return FAST_PROVIDER_STAGGER_DELAYS_MS[(launchIndex - 1) % FAST_PROVIDER_STAGGER_DELAYS_MS.length];
};
const getFastPhaseMinStreams = () => {
  return 3;
};
const isProviderCancellationError = (error) =>
  Number(error?.statusCode) === 499
  || /provider request cancelled/i.test(String(error?.message || ''));
const FAST_RESULT_LAST_GOOD_TTL_MS = Math.max(
  config.STREMIO_LAST_GOOD_TTL_SECONDS * 1000,
  config.PROVIDER_CACHE_TTL_SECONDS * 12 * 1000
);

export class ProviderService {
  constructor() {
    this.providers = discoverProviders();
    this.providerCacheDir = path.join(config.CACHE_DIR, 'provider-results');
    this.fastResultCacheDir = path.join(config.CACHE_DIR, 'fast-last-good');
    this.moduleCache = new Map();
    this.resultCache = new Map();
    this.inFlight = new Map();
    this.providerHealth = new Map();
    this.providerHostHealth = new Map();
    this.providerHostInflight = new Map();
    this.providerRuntime = new Map();
    this.providerGlobalInflight = 0;
    this.tmdbMetadataCache = new Map();
    this.tmdbMetadataInFlight = new Map();
    this.fastSearchInFlight = new Map();
  }

  async initialize() {
    await Promise.all([
      mkdir(this.providerCacheDir, { recursive: true }),
      mkdir(this.fastResultCacheDir, { recursive: true })
    ]);
    setTimeout(() => {
      this.removeExpiredDiskEntries().catch((error) => {
        logger.warn('provider cache cleanup after startup failed', { error });
      });
    }, 0).unref?.();
  }

  listProviders() {
    return this.getProviderOrder().map((providerId) => {
      const provider = this.providers.get(providerId);

      return {
        id: provider.id,
        label: provider.label
      };
    });
  }

  getStats() {
    const now = Date.now();
    let coolingDownProviders = 0;
    let coolingDownHosts = 0;
    const providerStatuses = this.getProviderStatusSnapshot(now);

    for (const state of this.providerHealth.values()) {
      if ((state.cooldownUntil || 0) > now) {
        coolingDownProviders += 1;
      }
    }

    for (const state of this.providerHostHealth.values()) {
      if ((state.cooldownUntil || 0) > now) {
        coolingDownHosts += 1;
      }
    }

    return {
      discoveredProviders: this.providers.size,
      inMemoryCacheEntries: this.resultCache.size,
      inFlightRequests: this.inFlight.size,
      activeProviderExecutions: this.providerGlobalInflight,
      providerCacheDir: this.providerCacheDir,
      fastResultCacheDir: this.fastResultCacheDir,
      coolingDownProviders,
      coolingDownHosts,
      providers: providerStatuses
    };
  }

  getLiveLoad() {
    return {
      inFlightRequests: this.inFlight.size,
      activeProviderExecutions: this.providerGlobalInflight
    };
  }

  updateProviderRuntime(providerId, patch) {
    const current = this.providerRuntime.get(providerId) || {
      totalRequests: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      consecutiveFailures: 0,
      lastResultCount: null,
      lastDurationMs: null,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastCacheHitAt: null,
      lastError: null,
      running: false,
      averageDurationMs: null
    };

    this.providerRuntime.set(providerId, {
      ...current,
      ...patch
    });
  }

  getProviderStatusSnapshot(now = Date.now()) {
    return this.getProviderOrder().map((providerId) => {
      const provider = this.providers.get(providerId);
      const hostKey = this.getProviderHostKey(providerId);
      const runtime = this.providerRuntime.get(providerId) || {};
      const health = this.providerHealth.get(providerId) || {};
      const hostHealth = this.providerHostHealth.get(hostKey) || {};
      const providerCooldownUntil = health.cooldownUntil || 0;
      const hostCooldownUntil = hostHealth.cooldownUntil || 0;
      const cooldownUntil = Math.max(providerCooldownUntil, hostCooldownUntil);
      const activeRequests = this.providerHostInflight.get(hostKey) || 0;
      let status = 'idle';

      if (runtime.running) {
        status = 'running';
      } else if (cooldownUntil > now) {
        status = 'cooldown';
      } else if ((runtime.consecutiveFailures || 0) > 0) {
        status = 'failing';
      } else if (runtime.lastResultCount === 0 && (runtime.totalSuccesses || 0) > 0) {
        status = 'intermittent';
      } else if (runtime.lastResultCount === 0) {
        status = 'empty';
      } else if (Number.isFinite(runtime.lastResultCount)) {
        status = 'ok';
      } else if (runtime.lastCacheHitAt) {
        status = 'cache-hit';
      }

      return {
        id: providerId,
        label: provider?.label || toLabel(providerId),
        hostKey,
        status,
        activeRequests,
        failures: health.failures || 0,
        hostFailures: hostHealth.failures || 0,
        cooldownUntil: cooldownUntil > now ? cooldownUntil : 0,
        lastStartedAt: runtime.lastStartedAt || null,
        lastFinishedAt: runtime.lastFinishedAt || null,
        lastCacheHitAt: runtime.lastCacheHitAt || null,
        lastResultCount: Number.isFinite(runtime.lastResultCount) ? runtime.lastResultCount : null,
        lastDurationMs: Number.isFinite(runtime.lastDurationMs) ? runtime.lastDurationMs : null,
        lastError: runtime.lastError || null,
        totalRequests: runtime.totalRequests || 0,
        totalSuccesses: runtime.totalSuccesses || 0,
        totalFailures: runtime.totalFailures || 0,
        consecutiveFailures: runtime.consecutiveFailures || 0,
        averageDurationMs: Number.isFinite(runtime.averageDurationMs) ? runtime.averageDurationMs : null
      };
    });
  }

  handleMemoryPressure({ critical = false } = {}) {
    if (critical) {
      this.resultCache.clear();
      this.tmdbMetadataCache.clear();
      return;
    }

    pruneMapByMaxEntries(this.resultCache, Math.max(50, Math.floor(config.PROVIDER_RESULT_MEMORY_CACHE_MAX_ENTRIES / 4)));
    pruneMapByApproxBytes(this.resultCache, Math.max(512 * 1024, Math.floor((config.PROVIDER_RESULT_MEMORY_CACHE_MAX_MB * 1024 * 1024) / 4)));
    pruneMapByMaxEntries(this.tmdbMetadataCache, Math.max(50, Math.floor(config.TMDB_METADATA_MEMORY_CACHE_MAX_ENTRIES / 4)));
  }

  getStremioProviderOrder(requestedProviders = null, contentProfile = null) {
    const candidates = this.getProviderOrder(contentProfile, requestedProviders && requestedProviders.length > 0 ? requestedProviders : null);
    const hasExplicitProviders = Array.isArray(requestedProviders) && requestedProviders.length > 0;

    return candidates.filter((providerId) => {
      if (STREMIO_ALWAYS_EXCLUDED_PROVIDERS.has(providerId)) {
        return false;
      }

      if (!hasExplicitProviders && STREMIO_DEFAULT_ONLY_EXCLUDED_PROVIDERS.has(providerId)) {
        return false;
      }

      return true;
    });
  }

  buildFastSearchRequestKey({
    providers = null,
    tmdbId,
    mediaType = 'movie',
    season = null,
    episode = null,
    streamOptions = null,
    privateProviderSettings = null
  }) {
    return JSON.stringify({
      version: 'two-phase-v1',
      providers: Array.isArray(providers) ? providers.map((providerId) => String(providerId || '').trim().toLowerCase()) : null,
      tmdbId: toOptionalInteger(tmdbId),
      mediaType: String(mediaType || 'movie').trim().toLowerCase(),
      season: toOptionalInteger(season),
      episode: toOptionalInteger(episode),
      webReadyOnly: Boolean(streamOptions?.webReadyOnly),
      privateProviderSettingsKey: getPrivateProviderSettingsKey('showbox', privateProviderSettings)
    });
  }

  getFastResultCacheFilePath(requestKey) {
    return path.join(this.fastResultCacheDir, `${this.hashCacheKey(requestKey)}.json`);
  }

  async getFastLastGoodResult(requestKey) {
    const cachePath = this.getFastResultCacheFilePath(requestKey);

    try {
      const payload = JSON.parse(await readFile(cachePath, 'utf8'));
      const streams = Array.isArray(payload?.streams) ? copyStreams(payload.streams) : [];

      if (!payload || payload.expiresAt <= Date.now() || streams.length === 0) {
        await rm(cachePath, { force: true });
        return null;
      }

      return {
        reason: 'last-good-fallback',
        providers: Array.isArray(payload.providers) ? [...payload.providers] : [],
        tried: Array.isArray(payload.tried)
          ? payload.tried.map((entry) => ({
            provider: entry.provider,
            count: Number.isFinite(entry.count) ? entry.count : 0
          }))
          : [],
        streams
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn('fast result last-good cache read failed', {
          cacheKey: this.hashCacheKey(requestKey),
          error
        });
      }

      return null;
    }
  }

  async setFastLastGoodResult(requestKey, result) {
    const streams = Array.isArray(result?.streams) ? result.streams : [];

    if (streams.length === 0) {
      return;
    }

    try {
      await writeFile(this.getFastResultCacheFilePath(requestKey), JSON.stringify({
        expiresAt: Date.now() + FAST_RESULT_LAST_GOOD_TTL_MS,
        providers: Array.isArray(result?.providers) ? result.providers : [],
        tried: Array.isArray(result?.tried) ? result.tried : [],
        streams
      }));
    } catch (error) {
      logger.warn('fast result last-good cache write failed', {
        cacheKey: this.hashCacheKey(requestKey),
        error
      });
    }
  }

  getAdaptiveMinStreams() {
    const baseTarget = getFastPhaseMinStreams();

    if (config.MAXIMIZE_PROVIDER_COVERAGE) {
      return Math.max(baseTarget, 2);
    }

    const globalCapacity = Math.max(config.PROVIDER_GLOBAL_MAX_INFLIGHT, 1);
    const globalPressure = this.providerGlobalInflight / globalCapacity;

    if (globalPressure >= 0.85) {
      return 2;
    }

    return baseTarget;
  }

  getFastPhaseOneLimit(providers, hasExplicitProviders = false) {
    if (!Array.isArray(providers) || providers.length === 0) {
      return 0;
    }

    if (config.MAXIMIZE_PROVIDER_COVERAGE) {
      return Math.min(
        providers.length,
        Math.max(
          config.STREMIO_FAST_PROVIDER_LIMIT,
          config.STREMIO_FAST_PROVIDER_CONCURRENCY * 2
        )
      );
    }

    if (hasExplicitProviders) {
      return Math.min(providers.length, Math.max(config.STREMIO_FAST_PROVIDER_LIMIT, 12));
    }

    return Math.min(providers.length, config.STREMIO_FAST_PROVIDER_LIMIT);
  }

  getAdaptiveFallbackProviderLimit(providerIds, { hasExplicitProviders = false, contentProfile = null, mediaType = 'movie' } = {}) {
    if (!Array.isArray(providerIds) || providerIds.length === 0) {
      return 0;
    }

    if (config.MAXIMIZE_PROVIDER_COVERAGE || hasExplicitProviders) {
      return providerIds.length;
    }

    const isCatalogMovieRequest = mediaType === 'movie'
      && Number.isInteger(contentProfile?.releaseYear)
      && contentProfile.releaseYear <= 2015;

    const globalCapacity = Math.max(config.PROVIDER_GLOBAL_MAX_INFLIGHT, 1);
    const globalPressure = this.providerGlobalInflight / globalCapacity;
    const hostPressureDetected = Array.from(this.providerHostInflight.values())
      .some((count) => count >= Math.max(config.PROVIDER_HOST_MAX_INFLIGHT, 1));

    const stableLimit = Math.max(
      config.STREMIO_FAST_PROVIDER_LIMIT,
      config.STREMIO_FAST_PROVIDER_CONCURRENCY * 3
    );

    const underPressureFloor = isCatalogMovieRequest
      ? 7
      : mediaType === 'movie'
        ? 5
        : 4;
    const moderatePressureFloor = isCatalogMovieRequest
      ? 8
      : mediaType === 'movie'
        ? 6
        : 5;

    if (globalPressure >= 1 || hostPressureDetected) {
      return Math.min(
        providerIds.length,
        Math.max(
          underPressureFloor,
          config.STREMIO_FAST_PROVIDER_CONCURRENCY
        )
      );
    }

    if (globalPressure >= 0.75) {
      return Math.min(
        providerIds.length,
        Math.max(
          moderatePressureFloor,
          config.STREMIO_FAST_PROVIDER_CONCURRENCY * 2,
          Math.ceil(Math.min(providerIds.length, stableLimit) / 2)
        )
      );
    }

    return Math.min(providerIds.length, stableLimit);
  }

  getProviderDynamicScore(providerId, contentProfile = null, privateProviderSettings = null) {
    const runtime = this.providerRuntime.get(providerId) || {};
    const totalRequests = Math.max(runtime.totalRequests || 0, 0);
    const totalSuccesses = Math.max(runtime.totalSuccesses || 0, 0);
    const totalFailures = Math.max(runtime.totalFailures || 0, 0);
    const successRate = totalRequests > 0 ? totalSuccesses / totalRequests : 0.5;
    const failurePenalty = Math.min(totalFailures, 20) * 4;
    const durationBonus = Number.isFinite(runtime.averageDurationMs)
      ? Math.max(0, 30 - Math.min(runtime.averageDurationMs / 250, 30))
      : 0;
    const baseOrder = this.getProviderOrderBase();

    return toProviderScore(
      providerId,
      baseOrder,
      contentProfile,
      privateProviderSettings
    ) + Math.round(successRate * 40) + durationBonus - failurePenalty;
  }

  buildFastPhaseProviders({ orderedProviders, hasExplicitProviders = false, contentProfile = null, streamOptions = null, mediaType = 'movie' }) {
    const baseProviders = Array.isArray(orderedProviders) ? [...orderedProviders] : [];
    const isOldTitleRequest = !hasExplicitProviders
      && Number.isInteger(contentProfile?.releaseYear)
      && contentProfile.releaseYear <= 2005;
    const isCatalogMovieRequest = !hasExplicitProviders
      && mediaType === 'movie'
      && Number.isInteger(contentProfile?.releaseYear)
      && contentProfile.releaseYear <= 2015;
    const phaseOnePriorityProviders = isOldTitleRequest ? OLD_TITLE_PRIMARY_PROVIDERS : [];
    const phaseOneOrderedProviders = phaseOnePriorityProviders.length > 0
      ? reprioritizeProviders(baseProviders, phaseOnePriorityProviders)
      : baseProviders;
    const phaseOneLimit = this.getFastPhaseOneLimit(phaseOneOrderedProviders, hasExplicitProviders);
    const phaseOneProviders = phaseOneOrderedProviders.slice(0, phaseOneLimit);
    const remainingProviders = phaseOneOrderedProviders.filter((providerId) => !phaseOneProviders.includes(providerId));
    let phaseTwoPriorityProviders = [];

    if (!hasExplicitProviders) {
      if (streamOptions?.webReadyOnly) {
        phaseTwoPriorityProviders = WEB_READY_FALLBACK_PROVIDERS;
      } else if (isOldTitleRequest) {
        phaseTwoPriorityProviders = OLD_TITLE_FALLBACK_PROVIDERS;
      } else if (isCatalogMovieRequest) {
        phaseTwoPriorityProviders = CATALOG_MOVIE_FALLBACK_PROVIDERS;
      } else if (!contentProfile && mediaType === 'tv') {
        phaseTwoPriorityProviders = UNKNOWN_TV_PROFILE_FALLBACK_PROVIDERS;
      } else {
        phaseTwoPriorityProviders = DEFAULT_DIVERSITY_FALLBACK_PROVIDERS;
      }
    }

    const phaseTwoProviders = phaseTwoPriorityProviders.length > 0
      ? reprioritizeProviders(remainingProviders, phaseTwoPriorityProviders)
      : remainingProviders;

    return {
      phaseOneProviders,
      phaseTwoProviders,
      isOldTitleRequest
    };
  }

  getMergedFastPhaseStreams(settledResults, providerOrder, contentProfile = null, streamOptions = null, privateProviderSettings = null) {
    const rankedStreams = mergeAndRankProviderStreams(
      settledResults,
      providerOrder,
      contentProfile,
      Infinity,
      privateProviderSettings
    );
    const perProviderSoftLimit = Number.isInteger(contentProfile?.releaseYear) && contentProfile.releaseYear <= 2005
      ? 4
      : config.MAXIMIZE_PROVIDER_COVERAGE
        ? 12
        : 4;

    if (streamOptions?.webReadyOnly) {
      return rankedStreams.slice(0, config.STREMIO_FAST_STREAM_LIMIT);
    }

    return applyPerProviderSoftLimit(rankedStreams, config.STREMIO_FAST_STREAM_LIMIT, perProviderSoftLimit);
  }

  async executeFastProviderPhase({
    phase,
    providerIds,
    contentProfile,
    hasExplicitProviders = false,
    minStreams = 3,
    stopOnMinStreams = false,
    enforceFastTimeout = true,
    seedSettledResults = [],
    requestParams
  }) {
    if (!Array.isArray(providerIds) || providerIds.length === 0) {
      return {
        reason: 'all-complete',
        providers: [],
        tried: [],
        streams: [],
        settledResults: []
      };
    }

    const results = new Array(providerIds.length);
    const settledResults = [];
    const activeControllers = new Map();
    const activeTasks = new Set();
    const concurrency = Math.max(1, Math.min(config.STREMIO_FAST_PROVIDER_CONCURRENCY, providerIds.length));
    const providerOrder = providerIds;
    let nextIndex = 0;
    let running = 0;
    let launchCount = 0;
    let resolved = false;

    const getMergedStreams = () =>
      this.getMergedFastPhaseStreams(
        [...seedSettledResults, ...settledResults],
        providerOrder,
        contentProfile,
        requestParams.streamOptions,
        requestParams.privateProviderSettings
      );

    return await new Promise((resolve) => {
      const finalize = (reason) => {
        if (resolved) {
          return;
        }

        resolved = true;
        resolve({
          reason,
          providers: providerIds,
          tried: providerIds.map((providerId, index) => ({
            provider: providerId,
            count: Array.isArray(results[index]?.streams) ? results[index].streams.length : 0
          })),
          streams: getMergedStreams(),
          settledResults: [...settledResults]
        });
      };

      const maybeFinalize = () => {
        if (resolved) {
          return;
        }

        const streams = getMergedStreams();
        const allComplete = nextIndex >= providerIds.length && running === 0;

        if (stopOnMinStreams && streams.length >= minStreams) {
          for (const controller of activeControllers.values()) {
            controller.abort(createHttpError(499, 'Provider request cancelled'));
          }
          finalize(`${phase}-early-success`);
          return;
        }

        if (allComplete) {
          finalize('all-complete');
        }
      };

      const launchNext = () => {
        if (resolved) {
          return;
        }

        while (running < concurrency && nextIndex < providerIds.length) {
          const index = nextIndex;
          const providerId = providerIds[index];
          const staggerMs = getFastProviderStaggerDelayMs(launchCount);
          const controller = new AbortController();
          const requestSignal = requestParams.signal || null;

          nextIndex += 1;
          launchCount += 1;
          running += 1;
          activeControllers.set(index, controller);

          const task = withCombinedAbortSignal(
            [requestSignal, controller.signal],
            async (combinedSignal) => {
              if (staggerMs > 0) {
                await waitForProviderSlot(staggerMs, combinedSignal);
              }

              const streams = await this.getStreams({
                provider: providerId,
                ...requestParams,
                signal: combinedSignal,
                priorityRequest: hasExplicitProviders || phase === 'phase1',
                enforceFastTimeout
              });

              return Array.isArray(streams) ? streams : [];
            },
            'Provider request cancelled'
          )
            .then((streams) => {
              const result = {
                provider: providerId,
                streams
              };

              results[index] = result;
              settledResults.push(result);
            })
            .catch((error) => {
              if (!isProviderCancellationError(error)) {
                logger.warn('two-phase provider worker failed', {
                  phase,
                  provider: providerId,
                  tmdbId: requestParams.tmdbId,
                  mediaType: requestParams.mediaType,
                  error
                });
              }

              const result = {
                provider: providerId,
                streams: []
              };

              results[index] = result;
              settledResults.push(result);
            })
            .finally(() => {
              running = Math.max(running - 1, 0);
              activeControllers.delete(index);
              activeTasks.delete(task);
              maybeFinalize();
              launchNext();
            });

          activeTasks.add(task);
        }

        maybeFinalize();
      };

      launchNext();
    });
  }

  buildRelaxedRetryProviderList({
    phaseOneProviders,
    phaseTwoProviders,
    phaseOneResult,
    phaseTwoResult,
    contentProfile = null,
    privateProviderSettings = null,
    hasExplicitProviders = false
  }) {
    const alreadyTried = new Map();

    for (const entry of [...(phaseOneResult?.tried || []), ...(phaseTwoResult?.tried || [])]) {
      alreadyTried.set(entry.provider, Number.isFinite(entry.count) ? entry.count : 0);
    }

    const retryCandidates = [...new Set([...phaseOneProviders, ...phaseTwoProviders])]
      .filter((providerId) => (alreadyTried.get(providerId) || 0) === 0)
      .sort((left, right) =>
        this.getProviderDynamicScore(right, contentProfile, privateProviderSettings)
        - this.getProviderDynamicScore(left, contentProfile, privateProviderSettings)
      );

    const retryLimit = hasExplicitProviders ? retryCandidates.length : Math.min(retryCandidates.length, 4);
    return retryCandidates.slice(0, retryLimit);
  }

  async getContentProfile({ tmdbId, mediaType }) {
    try {
      const metadata = await this.getTmdbMetadata({ tmdbId, mediaType });
      return this.buildContentProfile(metadata, mediaType);
    } catch (error) {
      logger.warn('content profile detection failed', {
        tmdbId,
        mediaType,
        error
      });
      return null;
    }
  }

  async getAggregateStreams({ providers = null, ...rest }) {
    const contentProfile = rest.contentProfile || await this.getContentProfile(rest);
    const normalizedProviders = this.getProviderOrder(contentProfile, providers);

    if (normalizedProviders.length === 0) {
      throw createHttpError(400, 'No valid providers were supplied for aggregate search');
    }

      const settledResults = await mapConcurrent(normalizedProviders, config.PROVIDER_MAX_CONCURRENCY, async (provider) => {
        const streams = await this.getStreams({
          provider,
          ...rest,
          priorityRequest: Array.isArray(providers) && providers.length > 0
        });

      return {
        provider,
        streams
      };
    });

    const tried = settledResults.map((result) => ({
      provider: result.provider,
      count: result.streams.length
    }));
    return {
      providers: normalizedProviders,
      tried,
      streams: mergeAndRankProviderStreams(
        settledResults,
        normalizedProviders,
        contentProfile,
        Infinity,
        rest.privateProviderSettings
      )
    };
  }

  async getFastStreams({ providers = null, ...rest }) {
    const requestKey = this.buildFastSearchRequestKey({
      providers,
      tmdbId: rest.tmdbId,
      mediaType: rest.mediaType,
      season: rest.season,
      episode: rest.episode,
      streamOptions: rest.streamOptions,
      privateProviderSettings: rest.privateProviderSettings
    });
    const existingRequest = this.fastSearchInFlight.get(requestKey);

    if (existingRequest) {
      return existingRequest.then((result) => copyFastSearchResult(result));
    }

    const request = (async () => {
      const contentProfile = rest.contentProfile || await this.getContentProfile(rest);
      const hasExplicitProviders = Array.isArray(providers) && providers.length > 0;
      const orderedProviders = this.getStremioProviderOrder(
        hasExplicitProviders ? providers : null,
        contentProfile
      );
      const prioritizedProviders = prioritizePrivateTokenProviders(orderedProviders, rest.privateProviderSettings);
      const baseProviders = !hasExplicitProviders && Array.isArray(contentProfile?.tags) && contentProfile.tags.includes('anime')
        ? [
          ...prioritizedProviders.filter((providerId) => !BROKEN_ANIME_FAST_PROVIDERS.has(providerId)),
          ...prioritizedProviders.filter((providerId) => BROKEN_ANIME_FAST_PROVIDERS.has(providerId))
        ]
        : prioritizedProviders;

      if (baseProviders.length === 0) {
        throw createHttpError(400, 'No valid providers were supplied for fast search');
      }

      const { phaseOneProviders, phaseTwoProviders } = this.buildFastPhaseProviders({
        orderedProviders: baseProviders,
        hasExplicitProviders,
        contentProfile,
        streamOptions: rest.streamOptions,
        mediaType: rest.mediaType
      });
      const minStreams = this.getAdaptiveMinStreams();
      const preferCompleteCoverage = config.MAXIMIZE_PROVIDER_COVERAGE;
      const startedAt = Date.now();

      const phaseOneResult = await this.executeFastProviderPhase({
        phase: 'phase1',
        providerIds: phaseOneProviders,
        contentProfile,
        hasExplicitProviders,
        minStreams,
        stopOnMinStreams: !preferCompleteCoverage,
        enforceFastTimeout: true,
        requestParams: rest
      });
      const phaseOneProviderFamilyCount = getDistinctProviderFamilyCount(phaseOneResult.streams);
      const canReturnPhaseOneEarly = !preferCompleteCoverage
        && phaseOneResult.streams.length >= minStreams
        && (
          hasExplicitProviders
          || phaseOneProviderFamilyCount >= 2
        );

      if (canReturnPhaseOneEarly) {
        logger.info('fast provider search returned after phase 1 success', {
          completedProviders: phaseOneResult.tried.filter((entry) => entry.count >= 0).length,
          totalProviders: phaseOneProviders.length,
          streamCount: phaseOneResult.streams.length,
          providerFamilies: phaseOneProviderFamilyCount,
          elapsedMs: Date.now() - startedAt,
          tmdbId: rest.tmdbId,
          mediaType: rest.mediaType
        });

        const finalResult = {
          reason: 'phase1-early-success',
          providers: phaseOneResult.providers,
          tried: phaseOneResult.tried,
          streams: phaseOneResult.streams
        };
        await this.setFastLastGoodResult(requestKey, finalResult);
        return finalResult;
      }

      if (phaseOneResult.streams.length >= minStreams && !hasExplicitProviders) {
        logger.info('fast provider search continuing to fallback for provider diversity', {
          completedProviders: phaseOneResult.tried.filter((entry) => entry.count >= 0).length,
          totalProviders: phaseOneProviders.length,
          streamCount: phaseOneResult.streams.length,
          providerFamilies: phaseOneProviderFamilyCount,
          elapsedMs: Date.now() - startedAt,
          tmdbId: rest.tmdbId,
          mediaType: rest.mediaType
        });
      }

      const adaptiveFallbackLimit = this.getAdaptiveFallbackProviderLimit(phaseTwoProviders, {
        hasExplicitProviders,
        contentProfile,
        mediaType: rest.mediaType
      });
      const limitedPhaseTwoProviders = phaseTwoProviders.slice(0, adaptiveFallbackLimit);

      if (limitedPhaseTwoProviders.length < phaseTwoProviders.length) {
        logger.info('fast provider search reduced fallback phase under load', {
          originalFallbackProviders: phaseTwoProviders.length,
          limitedFallbackProviders: limitedPhaseTwoProviders.length,
          providerGlobalInflight: this.providerGlobalInflight,
          tmdbId: rest.tmdbId,
          mediaType: rest.mediaType
        });
      }

      if (limitedPhaseTwoProviders.length === 0) {
        const finalResult = {
          reason: 'all-complete',
          providers: phaseOneResult.providers,
          tried: phaseOneResult.tried,
          streams: phaseOneResult.streams
        };
        if (finalResult.streams.length > 0) {
          await this.setFastLastGoodResult(requestKey, finalResult);
        }
        return finalResult;
      }

      const phaseTwoResult = await this.executeFastProviderPhase({
        phase: 'phase2',
        providerIds: limitedPhaseTwoProviders,
        contentProfile,
        hasExplicitProviders,
        minStreams,
        stopOnMinStreams: !preferCompleteCoverage,
        enforceFastTimeout: true,
        seedSettledResults: phaseOneResult.settledResults,
        requestParams: rest
      });
      const combinedProviders = [...phaseOneResult.providers, ...phaseTwoResult.providers];
      const combinedSettledResults = [...phaseOneResult.settledResults, ...phaseTwoResult.settledResults];
      const combinedTried = [...phaseOneResult.tried, ...phaseTwoResult.tried];
      let combinedStreams = this.getMergedFastPhaseStreams(
        combinedSettledResults,
        combinedProviders,
        contentProfile,
        rest.streamOptions,
        rest.privateProviderSettings
      );
      let combinedProviderFamilyCount = getDistinctProviderFamilyCount(combinedStreams);

      if (
        combinedStreams.length > 0
        && !hasExplicitProviders
        && combinedProviderFamilyCount < 2
      ) {
        const diversityRetryProviders = this.buildRelaxedRetryProviderList({
          phaseOneProviders,
          phaseTwoProviders: limitedPhaseTwoProviders,
          phaseOneResult,
          phaseTwoResult,
          contentProfile,
          privateProviderSettings: rest.privateProviderSettings,
          hasExplicitProviders
        }).slice(0, 3);

        if (diversityRetryProviders.length > 0) {
          logger.info('fast provider search retrying for provider diversity', {
            retryProviders: diversityRetryProviders,
            streamCount: combinedStreams.length,
            providerFamilies: combinedProviderFamilyCount,
            tmdbId: rest.tmdbId,
            mediaType: rest.mediaType
          });

          const diversityRetryResult = await this.executeFastProviderPhase({
            phase: 'diversity-retry',
            providerIds: diversityRetryProviders,
            contentProfile,
            hasExplicitProviders,
            minStreams: 1,
            stopOnMinStreams: false,
            enforceFastTimeout: false,
            requestParams: rest
          });

          combinedProviders.push(...diversityRetryResult.providers);
          combinedSettledResults.push(...diversityRetryResult.settledResults);
          combinedTried.push(...diversityRetryResult.tried);
          combinedStreams = this.getMergedFastPhaseStreams(
            combinedSettledResults,
            combinedProviders,
            contentProfile,
            rest.streamOptions,
            rest.privateProviderSettings
          );
          combinedProviderFamilyCount = getDistinctProviderFamilyCount(combinedStreams);
        }
      }

      if (combinedStreams.length === 0) {
        const retryProviders = this.buildRelaxedRetryProviderList({
          phaseOneProviders,
          phaseTwoProviders: limitedPhaseTwoProviders,
          phaseOneResult,
          phaseTwoResult,
          contentProfile,
          privateProviderSettings: rest.privateProviderSettings,
          hasExplicitProviders
        });

        if (retryProviders.length > 0) {
          const retryResult = await this.executeFastProviderPhase({
            phase: 'retry',
            providerIds: retryProviders,
            contentProfile,
            hasExplicitProviders,
            minStreams: 1,
            stopOnMinStreams: true,
            enforceFastTimeout: false,
            seedSettledResults: combinedSettledResults,
            requestParams: rest
          });

          combinedProviders.push(...retryResult.providers);
          combinedSettledResults.push(...retryResult.settledResults);
          combinedTried.push(...retryResult.tried);
          combinedStreams = this.getMergedFastPhaseStreams(
            combinedSettledResults,
            combinedProviders,
            contentProfile,
            rest.streamOptions,
            rest.privateProviderSettings
          );
        }
      }

      if (
        combinedStreams.length === 0 &&
        !hasExplicitProviders &&
        !rest.streamOptions?.webReadyOnly &&
        this.providers.has('torrent-scraper')
      ) {
        const torrentResult = await this.executeFastProviderPhase({
          phase: 'torrent-fallback',
          providerIds: ['torrent-scraper'],
          contentProfile,
          hasExplicitProviders: true,
          minStreams: 1,
          stopOnMinStreams: false,
          enforceFastTimeout: false,
          requestParams: rest
        });

        combinedProviders.push(...torrentResult.providers);
        combinedSettledResults.push(...torrentResult.settledResults);
        combinedTried.push(...torrentResult.tried);
        combinedStreams = this.getMergedFastPhaseStreams(
          combinedSettledResults,
          combinedProviders,
          contentProfile,
          rest.streamOptions,
          rest.privateProviderSettings
        );
      }

      logger.info('fast provider search completed after fallback phase', {
        phaseOneProviders: phaseOneProviders.length,
        phaseTwoProviders: limitedPhaseTwoProviders.length,
        streamCount: combinedStreams.length,
        elapsedMs: Date.now() - startedAt,
        tmdbId: rest.tmdbId,
        mediaType: rest.mediaType
      });

      const finalResult = {
        reason: 'all-complete',
        providers: combinedProviders,
        tried: combinedTried,
        streams: combinedStreams
      };

      if (finalResult.streams.length > 0) {
        await this.setFastLastGoodResult(requestKey, finalResult);
        return finalResult;
      }

      const lastGoodResult = await this.getFastLastGoodResult(requestKey);

      if (lastGoodResult?.streams?.length) {
        logger.warn('serving fast search last-good fallback after empty provider result', {
          tmdbId: rest.tmdbId,
          mediaType: rest.mediaType,
          resultCount: lastGoodResult.streams.length
        });
        return lastGoodResult;
      }

      return finalResult;
    })();

    this.fastSearchInFlight.set(requestKey, request);

    try {
      const result = await request;
      return copyFastSearchResult(result);
    } finally {
      this.fastSearchInFlight.delete(requestKey);
    }
  }

  async getStreams({
    provider,
    tmdbId,
    mediaType = 'movie',
    season = null,
    episode = null,
    privateProviderSettings = null,
    priorityRequest = false,
    signal = null,
    enforceFastTimeout = false
  }) {
    const providerId = String(provider || '').trim().toLowerCase();
    const providerConfig = this.providers.get(providerId);

    if (!providerConfig) {
      throw createHttpError(404, `Unknown provider: ${provider}`);
    }
    const providerHostKey = this.getProviderHostKey(providerId);

    const normalizedTmdbId = toOptionalInteger(tmdbId);

    if (!normalizedTmdbId) {
      throw createHttpError(400, 'tmdbId must be a positive integer');
    }

    const normalizedMediaType = String(mediaType || 'movie').trim().toLowerCase();

    if (normalizedMediaType !== 'movie' && normalizedMediaType !== 'tv') {
      throw createHttpError(400, 'mediaType must be movie or tv');
    }

    const normalizedSeason = toOptionalInteger(season);
    const normalizedEpisode = toOptionalInteger(episode);
    const cacheKey = JSON.stringify({
      version: getProviderCacheVersion(providerId),
      provider: providerId,
      tmdbId: normalizedTmdbId,
      mediaType: normalizedMediaType,
      season: normalizedSeason,
      episode: normalizedEpisode,
      privateProviderSettingsKey: getPrivateProviderSettingsKey(providerId, privateProviderSettings)
    });

    const cached = await this.getCachedResult(cacheKey);

    if (cached) {
      this.updateProviderRuntime(providerId, {
        lastCacheHitAt: Date.now()
      });
      logger.info('provider cache hit', {
        provider: providerId,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType,
        resultCount: cached.length
      });
      return cached;
    }

    const cooldownState = this.providerHealth.get(providerId);

    if (cooldownState?.cooldownUntil && cooldownState.cooldownUntil > Date.now()) {
      const staleFallback = await this.getStaleFallbackResult(cacheKey, providerId);

      if (staleFallback?.length) {
        logger.warn('provider served stale fallback during cooldown', {
          provider: providerId,
          tmdbId: normalizedTmdbId,
          mediaType: normalizedMediaType,
          resultCount: staleFallback.length
        });
        this.updateProviderRuntime(providerId, {
          lastCacheHitAt: Date.now(),
          lastResultCount: staleFallback.length,
          lastError: 'Served stale fallback during cooldown'
        });
        return staleFallback;
      }

      logger.warn('provider skipped due to cooldown', {
        provider: providerId,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType,
        cooldownUntil: new Date(cooldownState.cooldownUntil).toISOString()
      });
      return [];
    }

    const hostCooldownState = this.providerHostHealth.get(providerHostKey);

    if (hostCooldownState?.cooldownUntil && hostCooldownState.cooldownUntil > Date.now()) {
      const staleFallback = await this.getStaleFallbackResult(cacheKey, providerId);

      if (staleFallback?.length) {
        logger.warn('provider served stale fallback during host cooldown', {
          provider: providerId,
          hostKey: providerHostKey,
          tmdbId: normalizedTmdbId,
          mediaType: normalizedMediaType,
          resultCount: staleFallback.length
        });
        this.updateProviderRuntime(providerId, {
          lastCacheHitAt: Date.now(),
          lastResultCount: staleFallback.length,
          lastError: 'Served stale fallback during host cooldown'
        });
        return staleFallback;
      }

      logger.warn('provider skipped due to host cooldown', {
        provider: providerId,
        hostKey: providerHostKey,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType,
        cooldownUntil: new Date(hostCooldownState.cooldownUntil).toISOString()
      });
      return [];
    }

    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey);
    }

    const execution = this.executeProviderQuery({
      cacheKey,
      providerId,
      providerConfig,
      providerHostKey,
      normalizedTmdbId,
      normalizedMediaType,
      normalizedSeason,
      normalizedEpisode,
      privateProviderSettings,
      priorityRequest,
      signal,
      enforceFastTimeout
    });

    this.inFlight.set(cacheKey, execution);

    try {
      return await execution;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  async executeProviderQuery({
    cacheKey,
    providerId,
    providerConfig,
    providerHostKey,
    normalizedTmdbId,
    normalizedMediaType,
    normalizedSeason,
    normalizedEpisode,
    privateProviderSettings,
    priorityRequest = false,
    signal = null,
    enforceFastTimeout = false
  }) {
    if (signal?.aborted) {
      return [];
    }

    const startedAt = Date.now();
    const existingRuntime = this.providerRuntime.get(providerId) || {};
    this.updateProviderRuntime(providerId, {
      running: true,
      lastStartedAt: startedAt,
      lastError: null,
      totalRequests: (existingRuntime.totalRequests || 0) + 1
    });

    try {
      logger.info('provider scrape started', {
        provider: providerId,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType
      });

      const providerPromise = this.withProviderGlobalSlot(
        () => this.withProviderHostSlot(
          providerHostKey,
          () => this.invokeProviderWithTimeout(providerConfig, providerId, {
            tmdbId: normalizedTmdbId,
            mediaType: normalizedMediaType,
            season: normalizedSeason,
            episode: normalizedEpisode,
            privateProviderSettings,
            enforceFastTimeout
          }, signal),
          signal,
          priorityRequest
        ),
        signal,
        priorityRequest
      );

      const streams = await providerPromise;

      if (!Array.isArray(streams)) {
        throw createHttpError(502, `Provider ${providerId} returned an invalid stream payload`);
      }

      const normalizedStreams = streams
        .map((stream) => sanitizeProviderStream(stream))
        .filter(Boolean);

      if (normalizedStreams.length !== streams.length) {
        logger.warn('provider returned invalid streams', {
          provider: providerId,
          tmdbId: normalizedTmdbId,
          mediaType: normalizedMediaType,
          droppedCount: streams.length - normalizedStreams.length
        });
      }

      await this.setCachedResult(cacheKey, normalizedStreams, providerId);

      if (normalizedStreams.length === 0 && STALE_IF_ERROR_PROVIDERS.has(providerId)) {
        const staleFallback = await this.getStaleFallbackResult(cacheKey, providerId);

        if (staleFallback?.length) {
          const staleRuntime = this.providerRuntime.get(providerId) || {};
          this.updateProviderRuntime(providerId, {
            running: false,
            lastFinishedAt: Date.now(),
            lastDurationMs: Date.now() - startedAt,
            lastResultCount: staleFallback.length,
            lastError: 'Served stale fallback after empty result',
            totalSuccesses: (staleRuntime.totalSuccesses || 0) + 1,
            consecutiveFailures: 0
          });
          logger.warn('provider served stale fallback after empty result', {
            provider: providerId,
            hostKey: providerHostKey,
            tmdbId: normalizedTmdbId,
            mediaType: normalizedMediaType,
            resultCount: staleFallback.length
          });
          return staleFallback;
        }
      }

      this.providerHealth.delete(providerId);
      this.providerHostHealth.delete(providerHostKey);
      const successRuntime = this.providerRuntime.get(providerId) || {};
      const durationMs = Date.now() - startedAt;
      const averageDurationMs = Number.isFinite(successRuntime.averageDurationMs)
        ? ((successRuntime.averageDurationMs * Math.max((successRuntime.totalSuccesses || 0), 0)) + durationMs)
          / (Math.max((successRuntime.totalSuccesses || 0), 0) + 1)
        : durationMs;
      this.updateProviderRuntime(providerId, {
        running: false,
        lastFinishedAt: Date.now(),
        lastDurationMs: durationMs,
        lastResultCount: normalizedStreams.length,
        lastError: null,
        totalSuccesses: (successRuntime.totalSuccesses || 0) + 1,
        consecutiveFailures: 0,
        averageDurationMs
      });
      logger.info('provider scrape finished', {
        provider: providerId,
        hostKey: providerHostKey,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType,
        resultCount: normalizedStreams.length
      });

      return normalizedStreams;
    } catch (error) {
      if (isProviderCancellationError(error)) {
        this.updateProviderRuntime(providerId, {
          running: false,
          lastFinishedAt: Date.now(),
          lastDurationMs: Date.now() - startedAt,
          lastResultCount: 0,
          lastError: 'Provider request cancelled'
        });
        return [];
      }

      if (error?.statusCode === 504) {
        if (enforceFastTimeout) {
          const staleFallback = await this.getStaleFallbackResult(cacheKey, providerId);
          const fastTimeoutRuntime = this.providerRuntime.get(providerId) || {};
          const durationMs = Date.now() - startedAt;
          const averageDurationMs = Number.isFinite(fastTimeoutRuntime.averageDurationMs)
            ? ((fastTimeoutRuntime.averageDurationMs * Math.max((fastTimeoutRuntime.totalSuccesses || 0), 0)) + durationMs)
              / (Math.max((fastTimeoutRuntime.totalSuccesses || 0), 0) + 1)
            : durationMs;

          this.updateProviderRuntime(providerId, {
            running: false,
            lastFinishedAt: Date.now(),
            lastDurationMs: durationMs,
            averageDurationMs,
            lastError: 'Fast phase timeout'
          });
          logger.info('provider fast phase timed out', {
            provider: providerId,
            hostKey: providerHostKey,
            tmdbId: normalizedTmdbId,
            mediaType: normalizedMediaType
          });

          if (staleFallback?.length) {
            logger.info('provider served stale fallback after fast phase timeout', {
              provider: providerId,
              hostKey: providerHostKey,
              tmdbId: normalizedTmdbId,
              mediaType: normalizedMediaType,
              resultCount: staleFallback.length
            });
            this.updateProviderRuntime(providerId, {
              lastResultCount: staleFallback.length,
              lastError: 'Served stale fallback after fast phase timeout'
            });
            await this.deleteCachedResult(cacheKey);
            return staleFallback;
          }

          await this.deleteCachedResult(cacheKey);
          return [];
        }

        this.recordProviderFailure(providerId);
        this.recordProviderHostFailure(providerHostKey);
        const timeoutRuntime = this.providerRuntime.get(providerId) || {};
        const durationMs = Date.now() - startedAt;
        const averageDurationMs = Number.isFinite(timeoutRuntime.averageDurationMs)
          ? ((timeoutRuntime.averageDurationMs * Math.max((timeoutRuntime.totalSuccesses || 0), 0)) + durationMs)
            / (Math.max((timeoutRuntime.totalSuccesses || 0), 0) + 1)
          : durationMs;
        this.updateProviderRuntime(providerId, {
          running: false,
          lastFinishedAt: Date.now(),
          lastDurationMs: durationMs,
          lastResultCount: 0,
          lastError: error.message || 'Provider timed out',
          totalFailures: (timeoutRuntime.totalFailures || 0) + 1,
          consecutiveFailures: (timeoutRuntime.consecutiveFailures || 0) + 1,
          averageDurationMs
        });
        logger.warn('provider scrape timed out', {
          provider: providerId,
          hostKey: providerHostKey,
          tmdbId: normalizedTmdbId,
          mediaType: normalizedMediaType
        });

        const staleFallback = await this.getStaleFallbackResult(cacheKey, providerId);

        if (staleFallback?.length) {
          logger.warn('provider served stale fallback after timeout', {
            provider: providerId,
            hostKey: providerHostKey,
            tmdbId: normalizedTmdbId,
            mediaType: normalizedMediaType,
            resultCount: staleFallback.length
          });
          this.updateProviderRuntime(providerId, {
            running: false,
            lastFinishedAt: Date.now(),
            lastDurationMs: Date.now() - startedAt,
            lastResultCount: staleFallback.length,
            lastError: 'Served stale fallback after timeout'
          });
          await this.deleteCachedResult(cacheKey);
          return staleFallback;
        }

        await this.deleteCachedResult(cacheKey);
        return [];
      }

      this.recordProviderFailure(providerId);
      this.recordProviderHostFailure(providerHostKey);
      const failureRuntime = this.providerRuntime.get(providerId) || {};
      const durationMs = Date.now() - startedAt;
      const averageDurationMs = Number.isFinite(failureRuntime.averageDurationMs)
        ? ((failureRuntime.averageDurationMs * Math.max((failureRuntime.totalSuccesses || 0), 0)) + durationMs)
          / (Math.max((failureRuntime.totalSuccesses || 0), 0) + 1)
        : durationMs;
      this.updateProviderRuntime(providerId, {
        running: false,
        lastFinishedAt: Date.now(),
        lastDurationMs: durationMs,
        lastResultCount: 0,
        lastError: error?.message || 'Provider scrape failed',
        totalFailures: (failureRuntime.totalFailures || 0) + 1,
        consecutiveFailures: (failureRuntime.consecutiveFailures || 0) + 1,
        averageDurationMs
      });
      logger.error('provider scrape failed', {
        provider: providerId,
        hostKey: providerHostKey,
        tmdbId: normalizedTmdbId,
        mediaType: normalizedMediaType,
        error
      });

      const staleFallback = await this.getStaleFallbackResult(cacheKey, providerId);

      if (staleFallback?.length) {
        logger.warn('provider served stale fallback after failure', {
          provider: providerId,
          hostKey: providerHostKey,
          tmdbId: normalizedTmdbId,
          mediaType: normalizedMediaType,
          resultCount: staleFallback.length
        });
        this.updateProviderRuntime(providerId, {
          running: false,
          lastFinishedAt: Date.now(),
          lastDurationMs: Date.now() - startedAt,
          lastResultCount: staleFallback.length,
          lastError: 'Served stale fallback after failure'
        });
        await this.deleteCachedResult(cacheKey);
        return staleFallback;
      }

      await this.deleteCachedResult(cacheKey);
      return [];
    }
  }

  async invokeProviderWithTimeout(providerConfig, providerId, params, signal = null) {
    let timeoutId;
    let abortHandler;
    const abortController = new AbortController();
    const requiresExplicitCancellationRace = Boolean(signal) && SIGNAL_INCOMPATIBLE_PROVIDERS.has(providerId);
    const timeoutSeconds = getProviderTimeoutSeconds(providerId, params);
    const timeoutError = createHttpError(504, `Provider ${providerId} timed out`);
    const cancelledError = createHttpError(499, 'Provider request cancelled');
    ensureAbortSignalListenerCapacity(abortController.signal);
    if (signal) {
      ensureAbortSignalListenerCapacity(signal);
    }
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        abortController.abort(timeoutError);
        reject(timeoutError);
      }, timeoutSeconds * 1000);
      timeoutId.unref?.();
    });
    const cancellationPromise = requiresExplicitCancellationRace
      ? new Promise((_, reject) => {
        if (signal.aborted) {
          reject(cancelledError);
          return;
        }

        abortHandler = () => {
          abortController.abort(cancelledError);
          reject(cancelledError);
        };

        signal.addEventListener('abort', abortHandler, { once: true });
      })
      : null;

    const runProvider = () => providerFetchContextStorage.run(
      {
        providerId
      },
      () => this.invokeProvider(providerConfig, providerId, params)
    );

    const providerPromise = withCombinedAbortSignal(
      [abortController.signal, signal],
      (combinedSignal) => {
        if (requiresExplicitCancellationRace) {
          return runProvider();
        }

        return providerAbortSignalStorage.run(
          combinedSignal,
          () => runProvider()
        );
      },
      `Provider ${providerId} timed out`
    );

    const pending = [
      providerPromise,
      timeoutPromise
    ];

    if (cancellationPromise) {
      pending.push(cancellationPromise);
    }

    return Promise.race(pending).finally(() => {
      clearTimeout(timeoutId);
      if (abortHandler && signal) {
        signal.removeEventListener('abort', abortHandler);
      }
    });
  }

  async withProviderGlobalSlot(fn, signal = null, priorityRequest = false) {
    const maxInflight = config.PROVIDER_GLOBAL_MAX_INFLIGHT + (priorityRequest ? EXPLICIT_PROVIDER_GLOBAL_LANE_BONUS : 0);

    while (this.providerGlobalInflight >= maxInflight) {
      await waitForProviderSlot(50, signal);
    }

    if (signal?.aborted) {
      throw getAbortReason(signal);
    }

    this.providerGlobalInflight += 1;

    try {
      return await fn();
    } finally {
      this.providerGlobalInflight = Math.max(this.providerGlobalInflight - 1, 0);
    }
  }

  getProviderHostKey(providerId) {
    return String(providerId || '')
      .trim()
      .toLowerCase()
      .replace(/(?:_tv|-tv)$/u, '');
  }

  async withProviderHostSlot(hostKey, fn, signal = null, priorityRequest = false) {
    const normalizedHostKey = String(hostKey || '').trim().toLowerCase() || 'default';
    const baseMaxInflight = PROVIDER_HOST_MAX_INFLIGHT_OVERRIDES[normalizedHostKey] || config.PROVIDER_HOST_MAX_INFLIGHT;
    const maxInflight = baseMaxInflight + (priorityRequest ? EXPLICIT_PROVIDER_HOST_LANE_BONUS : 0);

    while ((this.providerHostInflight.get(normalizedHostKey) || 0) >= maxInflight) {
      await waitForProviderSlot(100, signal);
    }

    if (signal?.aborted) {
      throw getAbortReason(signal);
    }

    this.providerHostInflight.set(
      normalizedHostKey,
      (this.providerHostInflight.get(normalizedHostKey) || 0) + 1
    );

    try {
      return await fn();
    } finally {
      const remaining = Math.max((this.providerHostInflight.get(normalizedHostKey) || 1) - 1, 0);

      if (remaining === 0) {
        this.providerHostInflight.delete(normalizedHostKey);
      } else {
        this.providerHostInflight.set(normalizedHostKey, remaining);
      }
    }
  }

  recordProviderFailure(providerId) {
    const failureThreshold = getProviderFailureThreshold(providerId);

    if (failureThreshold <= 0 || getProviderCooldownMs(providerId) <= 0) {
      return;
    }

    const now = Date.now();
    const current = this.providerHealth.get(providerId) || { failures: 0, cooldownUntil: 0 };
    const failures = current.cooldownUntil && current.cooldownUntil <= now
      ? 1
      : current.failures + 1;
    const nextState = {
      failures,
      cooldownUntil: failures >= failureThreshold
        ? now + getProviderCooldownMs(providerId)
        : 0
    };

    this.providerHealth.set(providerId, nextState);

    if (nextState.cooldownUntil > now) {
      logger.warn('provider entered cooldown', {
        provider: providerId,
        failures,
        failureThreshold,
        cooldownUntil: new Date(nextState.cooldownUntil).toISOString()
      });
    }
  }

  recordProviderHostFailure(hostKey) {
    const normalizedHostKey = String(hostKey || '').trim().toLowerCase() || 'default';
    const failureThreshold = getProviderHostFailureThreshold(normalizedHostKey);

    if (failureThreshold <= 0 || getProviderHostCooldownMs(normalizedHostKey) <= 0) {
      return;
    }

    const now = Date.now();
    const current = this.providerHostHealth.get(normalizedHostKey) || { failures: 0, cooldownUntil: 0 };
    const failures = current.cooldownUntil && current.cooldownUntil <= now
      ? 1
      : current.failures + 1;
    const nextState = {
      failures,
      cooldownUntil: failures >= failureThreshold
        ? now + getProviderHostCooldownMs(normalizedHostKey)
        : 0
    };

    this.providerHostHealth.set(normalizedHostKey, nextState);

    if (nextState.cooldownUntil > now) {
      logger.warn('provider host entered cooldown', {
        hostKey: normalizedHostKey,
        failures,
        failureThreshold,
        cooldownUntil: new Date(nextState.cooldownUntil).toISOString()
      });
    }
  }

  async getCachedResult(cacheKey) {
    const entry = this.resultCache.get(cacheKey);

    if (!entry) {
      return this.getDiskCachedResult(cacheKey);
    }

    if (entry.expiresAt <= Date.now()) {
      this.resultCache.delete(cacheKey);
      return this.getDiskCachedResult(cacheKey);
    }

    const hydratedStreams = deserializeStreams(entry.serializedStreams);

    if (hydratedStreams.length === 0 && entry.verifiedEmpty !== true) {
      this.resultCache.delete(cacheKey);
      await this.deleteCachedResult(cacheKey);
      return null;
    }

    touchMapEntry(this.resultCache, cacheKey, entry);
    return hydratedStreams;
  }

  async getDiskCachedResult(cacheKey) {
    const cachePath = this.getCacheFilePath(cacheKey);

    try {
      const payload = JSON.parse(await readFile(cachePath, 'utf8'));
      const serializedStreams = typeof payload?.serializedStreams === 'string'
        ? payload.serializedStreams
        : Array.isArray(payload?.streams)
          ? serializeStreams(payload.streams)
          : '';
      const hydratedStreams = deserializeStreams(serializedStreams);

      if (!payload || payload.expiresAt <= Date.now() || hydratedStreams.length === 0 && !serializedStreams) {
        await rm(cachePath, { force: true });
        return null;
      }

      if (hydratedStreams.length === 0 && !isVerifiedEmptyCacheEntry(payload, hydratedStreams)) {
        await rm(cachePath, { force: true });
        return null;
      }

      const entry = {
        serializedStreams,
        approxBytes: getSerializedApproxBytes(serializedStreams),
        expiresAt: payload.expiresAt,
        verifiedEmpty: payload.verifiedEmpty === true
      };

      touchMapEntry(this.resultCache, cacheKey, entry);
      pruneMapByMaxEntries(this.resultCache, config.PROVIDER_RESULT_MEMORY_CACHE_MAX_ENTRIES);
      pruneMapByApproxBytes(this.resultCache, config.PROVIDER_RESULT_MEMORY_CACHE_MAX_MB * 1024 * 1024);
      logger.info('provider disk cache hit', {
        cacheKey: this.hashCacheKey(cacheKey),
        resultCount: hydratedStreams.length
      });
      return hydratedStreams;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn('provider disk cache read failed', {
          cacheKey: this.hashCacheKey(cacheKey),
          error
        });
      }

      return null;
    }
  }

  async getStaleFallbackResult(cacheKey, providerId = null) {
    if (!providerId || !STALE_IF_ERROR_PROVIDERS.has(providerId)) {
      return null;
    }

    const cachePath = this.getStaleFallbackCacheFilePath(cacheKey);

    try {
      const payload = JSON.parse(await readFile(cachePath, 'utf8'));
      const serializedStreams = typeof payload?.serializedStreams === 'string'
        ? payload.serializedStreams
        : Array.isArray(payload?.streams)
          ? serializeStreams(payload.streams)
          : '';
      const hydratedStreams = deserializeStreams(serializedStreams);

      if (!payload || payload.expiresAt <= Date.now() || hydratedStreams.length === 0) {
        await rm(cachePath, { force: true });
        return null;
      }

      logger.info('provider stale fallback cache hit', {
        provider: providerId,
        cacheKey: this.hashCacheKey(cacheKey),
        resultCount: hydratedStreams.length
      });
      return hydratedStreams;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn('provider stale fallback cache read failed', {
          provider: providerId,
          cacheKey: this.hashCacheKey(cacheKey),
          error
        });
      }

      return null;
    }
  }

  async setCachedResult(cacheKey, streams, providerId = null) {
    if (streams.length === 0 && providerId && NO_EMPTY_CACHE_PROVIDERS.has(providerId)) {
      this.resultCache.delete(cacheKey);
      try {
        await rm(this.getCacheFilePath(cacheKey), { force: true });
      } catch {}
      return;
    }

    if (streams.length === 0) {
      const emptyTtlSeconds = PRIORITY_EMPTY_CACHE_PROVIDERS.has(providerId)
        ? config.PROVIDER_PRIORITY_EMPTY_CACHE_TTL_SECONDS
        : config.PROVIDER_EMPTY_CACHE_TTL_SECONDS;

      if (emptyTtlSeconds <= 0) {
        this.resultCache.delete(cacheKey);
        try {
          await rm(this.getCacheFilePath(cacheKey), { force: true });
        } catch {}
        return;
      }
    }

    const serializedStreams = serializeStreams(streams);
    const entry = {
      serializedStreams,
      approxBytes: getSerializedApproxBytes(serializedStreams),
      verifiedEmpty: streams.length === 0,
      expiresAt: Date.now() + (streams.length === 0
        ? PRIORITY_EMPTY_CACHE_PROVIDERS.has(providerId)
          ? config.PROVIDER_PRIORITY_EMPTY_CACHE_TTL_SECONDS
          : config.PROVIDER_EMPTY_CACHE_TTL_SECONDS
        : config.PROVIDER_CACHE_TTL_SECONDS) * 1000
    };

    touchMapEntry(this.resultCache, cacheKey, entry);
    pruneMapByMaxEntries(this.resultCache, config.PROVIDER_RESULT_MEMORY_CACHE_MAX_ENTRIES);
    pruneMapByApproxBytes(this.resultCache, config.PROVIDER_RESULT_MEMORY_CACHE_MAX_MB * 1024 * 1024);

    try {
      await writeFile(this.getCacheFilePath(cacheKey), JSON.stringify({
        expiresAt: entry.expiresAt,
        verifiedEmpty: entry.verifiedEmpty,
        serializedStreams
      }));
    } catch (error) {
      logger.warn('provider disk cache write failed', {
        cacheKey: this.hashCacheKey(cacheKey),
        error
      });
    }

    if (providerId && STALE_IF_ERROR_PROVIDERS.has(providerId) && streams.length > 0) {
      try {
        await writeFile(this.getStaleFallbackCacheFilePath(cacheKey), JSON.stringify({
          expiresAt: Date.now() + (config.PROVIDER_CACHE_TTL_SECONDS * 4 * 1000),
          serializedStreams
        }));
      } catch (error) {
        logger.warn('provider stale fallback cache write failed', {
          provider: providerId,
          cacheKey: this.hashCacheKey(cacheKey),
          error
        });
      }
    }
  }

  async deleteCachedResult(cacheKey) {
    this.resultCache.delete(cacheKey);

    try {
      await rm(this.getCacheFilePath(cacheKey), { force: true });
    } catch {}
  }

  normalizeProviders(providers) {
    const requestedProviders = Array.isArray(providers) ? providers : this.getProviderOrder();

    return requestedProviders
      .map((provider) => String(provider || '').trim().toLowerCase())
      .filter(Boolean)
      .filter((provider, index, list) => list.indexOf(provider) === index)
      .filter((provider) => this.providers.has(provider));
  }

  getProviderOrderBase() {
    const discoveredIds = Array.from(this.providers.keys()).sort();
    const ordered = [];

    for (const providerId of PROVIDER_PRIORITY) {
      if (this.providers.has(providerId)) {
        ordered.push(providerId);
      }
    }

    for (const providerId of discoveredIds) {
      if (!ordered.includes(providerId)) {
        ordered.push(providerId);
      }
    }

    return ordered;
  }

  getProviderOrder(contentProfile = null, requestedProviders = null) {
    const baseOrder = this.getProviderOrderBase();
    const baseIndex = new Map(baseOrder.map((providerId, index) => [providerId, index]));
    const candidates = Array.isArray(requestedProviders)
      ? requestedProviders
        .map((provider) => String(provider || '').trim().toLowerCase())
        .filter(Boolean)
        .filter((provider, index, list) => list.indexOf(provider) === index)
        .filter((provider) => this.providers.has(provider))
      : baseOrder;

    if (!contentProfile || !Array.isArray(contentProfile.tags) || contentProfile.tags.length === 0) {
      return [...candidates].sort((left, right) => {
        const dynamicDelta = this.getProviderDynamicScore(right, contentProfile) - this.getProviderDynamicScore(left, contentProfile);

        if (dynamicDelta !== 0) {
          return dynamicDelta;
        }

        return (baseIndex.get(left) ?? Number.MAX_SAFE_INTEGER) - (baseIndex.get(right) ?? Number.MAX_SAFE_INTEGER);
      });
    }

    return [...candidates].sort((left, right) => {
      const dynamicDelta = this.getProviderDynamicScore(right, contentProfile) - this.getProviderDynamicScore(left, contentProfile);

      if (dynamicDelta !== 0) {
        return dynamicDelta;
      }

      return (baseIndex.get(left) ?? Number.MAX_SAFE_INTEGER) - (baseIndex.get(right) ?? Number.MAX_SAFE_INTEGER);
    });
  }

  async getTmdbMetadata({ tmdbId, mediaType }) {
    const normalizedTmdbId = toOptionalInteger(tmdbId);
    const normalizedMediaType = String(mediaType || 'movie').trim().toLowerCase() === 'tv' ? 'tv' : 'movie';

    if (!normalizedTmdbId) {
      return null;
    }

    const cacheKey = `${normalizedMediaType}:${normalizedTmdbId}`;
    const cached = this.tmdbMetadataCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      touchMapEntry(this.tmdbMetadataCache, cacheKey, cached);
      return cached.value;
    }

    if (this.tmdbMetadataInFlight.has(cacheKey)) {
      return this.tmdbMetadataInFlight.get(cacheKey);
    }

    const request = (async () => {
      let lastError = null;

      for (let attempt = 0; attempt <= TMDB_METADATA_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          const response = await fetch(`https://api.themoviedb.org/3/${normalizedMediaType}/${normalizedTmdbId}?api_key=${config.TMDB_API_KEY}`);

          if (!response.ok) {
            throw new Error(`TMDB metadata HTTP ${response.status}`);
          }

          const metadata = await response.json();

          this.tmdbMetadataCache.set(cacheKey, {
            value: metadata,
            expiresAt: Date.now() + TMDB_METADATA_CACHE_TTL_MS
          });
          pruneMapByMaxEntries(this.tmdbMetadataCache, config.TMDB_METADATA_MEMORY_CACHE_MAX_ENTRIES);

          return metadata;
        } catch (error) {
          lastError = error;

          if (attempt < TMDB_METADATA_RETRY_DELAYS_MS.length) {
            await delay(TMDB_METADATA_RETRY_DELAYS_MS[attempt]);
          }
        }
      }

      if (cached?.value) {
        logger.warn('using stale tmdb metadata after fetch failure', {
          tmdbId: normalizedTmdbId,
          mediaType: normalizedMediaType,
          error: lastError
        });
        return cached.value;
      }

      throw lastError;
    })();

    this.tmdbMetadataInFlight.set(cacheKey, request);

    try {
      return await request;
    } finally {
      this.tmdbMetadataInFlight.delete(cacheKey);
    }
  }

  buildContentProfile(metadata, mediaType) {
    if (!metadata || typeof metadata !== 'object') {
      return null;
    }

    const originalLanguage = String(metadata.original_language || '').toLowerCase();
    const genreNames = new Set(
      Array.isArray(metadata.genres)
        ? metadata.genres.map((genre) => String(genre?.name || '').toLowerCase()).filter(Boolean)
        : []
    );
    const originCountries = new Set(
      [
        ...(Array.isArray(metadata.origin_country) ? metadata.origin_country : []),
        ...(Array.isArray(metadata.production_countries)
          ? metadata.production_countries.map((country) => country?.iso_3166_1)
          : [])
      ]
        .map((country) => String(country || '').toUpperCase())
        .filter(Boolean)
    );
    const tags = [];
    const isAnimation = genreNames.has('animation');
    const isAnime = isAnimation && (originalLanguage === 'ja' || originCountries.has('JP'));

    if (isAnime) {
      tags.push('anime');
    }

    if (
      mediaType === 'tv' &&
      !isAnime &&
      (originalLanguage === 'ko' || originCountries.has('KR'))
    ) {
      tags.push('kdrama');
    }

    if (
      mediaType === 'tv' &&
      !isAnime &&
      (
        ASIAN_DRAMA_LANGUAGES.has(originalLanguage) ||
        [...originCountries].some((country) => ASIAN_DRAMA_COUNTRIES.has(country))
      )
    ) {
      tags.push('asian_drama');
    }

    if (INDIAN_LANGUAGES.has(originalLanguage) || originCountries.has('IN')) {
      tags.push('indian');
    }

    if (originalLanguage === 'tr' || originCountries.has('TR')) {
      tags.push('turkish');
    }

    if (originalLanguage === 'it' || originCountries.has('IT')) {
      tags.push('italian');
    }

    if (originalLanguage === 'pt' || originCountries.has('BR') || originCountries.has('PT')) {
      tags.push('portuguese');
    }

    if (originalLanguage === 'es') {
      tags.push('spanish');
    }

    if (originalLanguage === 'ar' || [...originCountries].some((country) => ARABIC_COUNTRIES.has(country))) {
      tags.push('arabic');
    }

    const dateValue = mediaType === 'tv'
      ? metadata.first_air_date
      : metadata.release_date;
    const releaseYear = Number.parseInt(String(dateValue || '').slice(0, 4), 10);

    return {
      mediaType,
      originalLanguage,
      originCountries: [...originCountries],
      genreNames: [...genreNames],
      releaseYear: Number.isInteger(releaseYear) ? releaseYear : null,
      tags
    };
  }

  loadProviderModule(providerConfig, providerId = providerConfig.id) {
    if (this.moduleCache.has(providerConfig.modulePath)) {
      return this.moduleCache.get(providerConfig.modulePath);
    }

    let loadedModule;

    try {
      loadedModule = require(providerConfig.modulePath);
    } catch (error) {
      logger.error('provider module load failed', {
        provider: providerId,
        modulePath: providerConfig.modulePath,
        error
      });
      throw createHttpError(500, `Provider ${providerId} could not be loaded`);
    }

    if (!loadedModule || typeof loadedModule.getStreams !== 'function') {
      throw createHttpError(500, `Provider ${providerId} does not export getStreams`);
    }

    this.moduleCache.set(providerConfig.modulePath, loadedModule);
    return loadedModule;
  }

  async invokeProvider(providerConfig, providerId, params) {
    if (providerConfig.invocation === 'subprocess') {
      return this.invokeProviderSubprocess(providerConfig, providerId, params);
    }

    const providerModule = this.loadProviderModule(providerConfig, providerId);

    if (providerId === 'showbox') {
      return Promise.resolve().then(() => providerModule.getStreams(
        params.tmdbId,
        params.mediaType,
        params.season,
        params.episode,
        {
          uiToken: String(params.privateProviderSettings?.febboxUiCookie || '').trim(),
          ossGroup: String(params.privateProviderSettings?.showboxOssGroup || '').trim()
        }
      ));
    }

    return Promise.resolve().then(() => providerModule.getStreams(
      params.tmdbId,
      params.mediaType,
      params.season,
      params.episode
    ));
  }

  async invokeProviderSubprocess(providerConfig, providerId, params) {
    const { stdout } = await execFileAsync(process.execPath, [
      providerConfig.runnerPath,
      String(params.tmdbId),
      String(params.mediaType),
      params.season === null ? '' : String(params.season),
      params.episode === null ? '' : String(params.episode)
    ], {
      cwd: process.cwd(),
      timeout: (config.PROVIDER_TIMEOUT_SECONDS * 1000) + 2000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env
    });

    try {
      return JSON.parse(stdout || '[]');
    } catch (error) {
      logger.warn('provider subprocess returned invalid JSON', {
        provider: providerId,
        error
      });
      return [];
    }
  }

  getCacheFilePath(cacheKey) {
    return path.join(this.providerCacheDir, `${this.hashCacheKey(cacheKey)}.json`);
  }

  getStaleFallbackCacheFilePath(cacheKey) {
    return path.join(this.providerCacheDir, `${this.hashCacheKey(cacheKey)}.stale.json`);
  }

  hashCacheKey(cacheKey) {
    return crypto.createHash('sha256').update(cacheKey).digest('hex');
  }

  async removeExpiredDiskEntries() {
    let entries = [];

    try {
      entries = await readdir(this.providerCacheDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      return;
    }

    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const filePath = path.join(this.providerCacheDir, entry.name);

        try {
          const payload = JSON.parse(await readFile(filePath, 'utf8'));

          if (!payload || payload.expiresAt <= Date.now()) {
            await rm(filePath, { force: true });
          }
        } catch {
          await rm(filePath, { force: true });
        }
      }));
  }
}
