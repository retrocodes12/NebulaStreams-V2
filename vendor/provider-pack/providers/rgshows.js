// RGShows provider adapter
//
// The old RGShows JSON APIs under api.rgshows.ru are returning 404 now.
// The current site routes playback through player/api5 pages, which expose
// a rotating list of upstream embed hosts. This adapter reads that current
// server list and uses the overlapping local providers that are already
// available in this codebase.

'use strict';

const path = require('path');

const TAG = '[RGShows]';
const RGSHOWS_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer': 'https://www.rgshows.ru/',
  'Origin': 'https://www.rgshows.ru'
});
const RGSHOWS_PAGE_URLS = Object.freeze({
  movie: (tmdbId) => `https://www.rgshows.ru/player/movies/api5/index.html?id=${tmdbId}`,
  tv: (tmdbId, season, episode) => `https://www.rgshows.ru/player/series/api5/index.html?id=${tmdbId}&s=${season}&e=${episode}`
});
const SERVER_PROVIDER_MAP = Object.freeze({
  'vidlink.pro': 'vidlink',
  'videasy': 'videasy'
});
const FALLBACK_PROVIDER_ORDER = Object.freeze(['vidlink', 'videasy']);
const SOURCE_TIMEOUTS_MS = Object.freeze({
  vidlink: 7000,
  videasy: 8000
});
const SOURCE_STREAM_LIMIT = Object.freeze({
  vidlink: 6,
  videasy: 6
});
const moduleCache = new Map();

function getProvidersDir() {
  return __dirname;
}

function normalizeMediaType(mediaType) {
  return mediaType === 'tv' ? 'tv' : 'movie';
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function makeRequest(url, options) {
  const requestOptions = options || {};
  const headers = {
    ...RGSHOWS_HEADERS,
    ...(requestOptions.headers && typeof requestOptions.headers === 'object' ? requestOptions.headers : {})
  };

  return fetch(url, {
    method: requestOptions.method || 'GET',
    headers
  }).then((response) => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response;
  });
}

function extractServersObjectLiteral(html) {
  const match = String(html || '').match(/const\s+servers\s*=\s*\{([\s\S]*?)\n\s*\};/i);
  return match ? match[1] : '';
}

function extractServerOrder(html) {
  const objectLiteral = extractServersObjectLiteral(html);

  if (!objectLiteral) {
    return [];
  }

  const orderedServers = [];
  const pattern = /"([^"]+)"\s*:\s*\(/g;
  let match;

  while ((match = pattern.exec(objectLiteral)) !== null) {
    const serverName = normalizeText(match[1]).toLowerCase();

    if (!serverName || orderedServers.includes(serverName)) {
      continue;
    }

    orderedServers.push(serverName);
  }

  return orderedServers;
}

function toProviderOrder(serverNames) {
  const providers = [];

  for (const serverName of serverNames) {
    const providerId = SERVER_PROVIDER_MAP[serverName];

    if (providerId && !providers.includes(providerId)) {
      providers.push(providerId);
    }
  }

  for (const providerId of FALLBACK_PROVIDER_ORDER) {
    if (!providers.includes(providerId)) {
      providers.push(providerId);
    }
  }

  return providers;
}

function loadSourceProvider(providerId) {
  if (moduleCache.has(providerId)) {
    return moduleCache.get(providerId);
  }

  const modulePath = path.join(getProvidersDir(), `${providerId}.js`);
  const loadedModule = require(modulePath);

  if (!loadedModule || typeof loadedModule.getStreams !== 'function') {
    throw new Error(`${providerId} does not export getStreams`);
  }

  moduleCache.set(providerId, loadedModule);
  return loadedModule;
}

function runWithTimeout(providerId, promise) {
  let timer = null;
  const timeoutMs = SOURCE_TIMEOUTS_MS[providerId] || 7000;

  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => {
        timer = null;
        console.warn(`${TAG} ${providerId} timed out after ${timeoutMs}ms`);
        resolve([]);
      }, timeoutMs);
      timer.unref?.();
    })
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function getQualityScore(stream) {
  const quality = String(stream && stream.quality || '').toLowerCase();

  if (quality === '4k' || quality.includes('2160')) {
    return 2160;
  }

  if (quality === 'auto' || quality === 'adaptive') {
    return 850;
  }

  const match = quality.match(/(\d{3,4})/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function compareStreamsByQuality(left, right) {
  return getQualityScore(right) - getQualityScore(left);
}

function dedupeStreams(streams) {
  const seen = new Set();
  const deduped = [];

  for (const stream of streams) {
    const key = normalizeText(stream && stream.url).toLowerCase();

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(stream);
  }

  return deduped;
}

function normalizeSourceStream(providerId, stream) {
  if (!stream || typeof stream !== 'object') {
    return null;
  }

  const url = normalizeText(stream.url);

  if (!url || !/^https?:\/\//i.test(url)) {
    return null;
  }

  const providerLabel = providerId === 'vidlink'
    ? 'Vidlink'
    : providerId === 'videasy'
      ? 'VideoEasy'
      : providerId;
  const quality = normalizeText(stream.quality) || 'Auto';
  const titleLines = String(stream.title || '')
    .split('\n')
    .map((line) => normalizeText(line))
    .filter(Boolean);
  const baseTitle = titleLines[0] || normalizeText(stream.name) || providerLabel;

  return {
    ...stream,
    name: `RGShows | ${providerLabel} | ${quality}`,
    title: [`RGShows via ${providerLabel}`, baseTitle].filter(Boolean).join('\n'),
    quality,
    provider: 'rgshows',
    sourceProvider: providerId,
    sourceSite: `RGShows (${providerLabel})`
  };
}

async function fetchProviderOrder(tmdbId, mediaType, season, episode) {
  const pageUrl = mediaType === 'tv'
    ? RGSHOWS_PAGE_URLS.tv(tmdbId, season, episode)
    : RGSHOWS_PAGE_URLS.movie(tmdbId);

  try {
    const html = await makeRequest(pageUrl).then((response) => response.text());
    const serverNames = extractServerOrder(html);
    const providers = toProviderOrder(serverNames);

    console.log(`${TAG} extracted servers for ${mediaType} ${tmdbId}: ${serverNames.join(', ') || 'none'}`);
    return providers;
  } catch (error) {
    console.warn(`${TAG} failed to fetch api5 server list: ${error.message}`);
    return [...FALLBACK_PROVIDER_ORDER];
  }
}

async function runSourceProvider(providerId, tmdbId, mediaType, season, episode) {
  try {
    const providerModule = loadSourceProvider(providerId);
    const result = await runWithTimeout(
      providerId,
      Promise.resolve(providerModule.getStreams(tmdbId, mediaType, season, episode))
    );

    if (!Array.isArray(result) || result.length === 0) {
      return [];
    }

    return result
      .map((stream) => normalizeSourceStream(providerId, stream))
      .filter(Boolean)
      .sort(compareStreamsByQuality)
      .slice(0, SOURCE_STREAM_LIMIT[providerId] || 6);
  } catch (error) {
    console.warn(`${TAG} ${providerId} failed: ${error.message}`);
    return [];
  }
}

async function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  const normalizedMediaType = normalizeMediaType(mediaType);
  console.log(`${TAG} resolving ${normalizedMediaType} ${tmdbId}`);

  const providerOrder = await fetchProviderOrder(tmdbId, normalizedMediaType, season, episode);
  const collectedStreams = [];

  for (const providerId of providerOrder) {
    const sourceStreams = await runSourceProvider(providerId, tmdbId, normalizedMediaType, season, episode);
    collectedStreams.push(...sourceStreams);

    if (dedupeStreams(collectedStreams).length >= 6) {
      break;
    }
  }

  const streams = dedupeStreams(collectedStreams)
    .sort(compareStreamsByQuality)
    .slice(0, 12);

  console.log(`${TAG} returning ${streams.length} stream(s)`);
  return streams;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = { getStreams };
}
