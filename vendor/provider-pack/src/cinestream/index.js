'use strict';

/**
 * CineStream Provider for Nuvio
 *
 * The old implementation called a deprecated upstream endpoint. This adapter
 * keeps CineStream usable by aggregating a small set of stable local direct
 * providers.
 */

const path = require('path');

const TAG = '[CineStream]';
const MAX_TOTAL_STREAMS = 12;
const MIN_FAST_STREAMS = 4;
const SOURCE_PROVIDERS = Object.freeze([
  { id: 'moviebox', label: 'MovieBox', timeoutMs: 5000, maxStreams: 4 },
  { id: 'vidlink', label: 'Vidlink', timeoutMs: 6000, maxStreams: 4 },
  { id: 'streamflix', label: 'StreamFlix', timeoutMs: 7000, maxStreams: 4 }
]);

const moduleCache = new Map();

function getProvidersDir() {
  if (path.basename(__dirname) === 'cinestream') {
    return path.resolve(__dirname, '../../providers');
  }

  return __dirname;
}

function loadSourceProvider(source) {
  if (moduleCache.has(source.id)) {
    return moduleCache.get(source.id);
  }

  const modulePath = path.join(getProvidersDir(), `${source.id}.js`);
  const loadedModule = require(modulePath);

  if (!loadedModule || typeof loadedModule.getStreams !== 'function') {
    throw new Error(`${source.id} does not export getStreams`);
  }

  moduleCache.set(source.id, loadedModule);
  return loadedModule;
}

function runWithTimeout(source, promise) {
  let timer = null;

  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => {
        timer = null;
        console.warn(`${TAG} ${source.id} timed out after ${source.timeoutMs}ms`);
        resolve([]);
      }, source.timeoutMs);
      timer.unref?.();
    })
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

async function runSourceProvider(source, tmdbId, mediaType, season, episode) {
  try {
    const providerModule = loadSourceProvider(source);
    const result = await runWithTimeout(
      source,
      Promise.resolve(providerModule.getStreams(tmdbId, mediaType, season, episode))
    );

    if (!Array.isArray(result) || result.length === 0) {
      return [];
    }

    return result
      .map((stream, index) => normalizeStream(source, stream, index))
      .filter(Boolean)
      .sort(compareStreamsByQuality)
      .slice(0, source.maxStreams);
  } catch (error) {
    console.warn(`${TAG} ${source.id} failed: ${error.message}`);
    return [];
  }
}

function normalizeMediaType(mediaType) {
  if (mediaType === 'series') {
    return 'tv';
  }

  return mediaType || 'movie';
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function getQuality(stream) {
  const explicit = normalizeText(stream.quality);
  if (explicit) {
    return explicit;
  }

  const combinedText = `${stream.name || ''} ${stream.title || ''}`;
  const qualityMatch = combinedText.match(/\b(2160p|4k|1440p|1080p|720p|480p|360p)\b/i);
  return qualityMatch ? qualityMatch[1].toUpperCase().replace('P', 'p') : 'Auto';
}

function getQualityScore(stream) {
  const quality = String(stream.quality || '').toLowerCase();

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

function normalizeStream(source, stream, index) {
  if (!stream || typeof stream !== 'object') {
    return null;
  }

  const url = normalizeText(stream.url);
  if (!url || !/^https?:\/\//i.test(url)) {
    return null;
  }

  const quality = getQuality(stream);
  const originalName = normalizeText(stream.name);
  const originalTitle = String(stream.title || '').trim();
  const sourceLabel = normalizeText(stream.sourceProvider || stream.provider || source.label);
  const titleParts = [
    `CineStream via ${source.label}`,
    originalTitle || originalName || `${source.label} stream ${index + 1}`
  ];

  return {
    ...stream,
    name: `CineStream | ${source.label} | ${quality}`,
    title: titleParts.filter(Boolean).join('\n'),
    url,
    quality,
    provider: 'cinestream',
    sourceProvider: source.id,
    sourceSite: sourceLabel,
    behaviorHints: {
      ...(stream.behaviorHints || {}),
      bingeGroup: `cinestream-${source.id}`,
      notWebReady: Boolean(stream.behaviorHints && stream.behaviorHints.notWebReady)
    }
  };
}

function dedupeStreams(streams) {
  const seen = new Set();
  const deduped = [];

  for (const stream of streams) {
    const key = normalizeText(stream.url).toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(stream);
  }

  return deduped;
}

async function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  const normalizedMediaType = normalizeMediaType(mediaType);
  console.log(`${TAG} Aggregating ${normalizedMediaType} ${tmdbId}`);

  const collectedStreams = [];

  for (const source of SOURCE_PROVIDERS) {
    const sourceStreams = await runSourceProvider(source, tmdbId, normalizedMediaType, season, episode);
    collectedStreams.push(...sourceStreams);

    if (dedupeStreams(collectedStreams).length >= MIN_FAST_STREAMS) {
      break;
    }
  }

  const streams = dedupeStreams(collectedStreams)
    .sort(compareStreamsByQuality)
    .slice(0, MAX_TOTAL_STREAMS);

  console.log(`${TAG} Returning ${streams.length} stream(s)`);
  return streams;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = { getStreams };
}
