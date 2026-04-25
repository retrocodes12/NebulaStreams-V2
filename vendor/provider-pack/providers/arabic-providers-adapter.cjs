const PROVIDERS = Object.freeze({
  'arabic-faselhd': {
    upstream: 'faselhd',
    label: 'FaselHD',
    supportedTypes: new Set(['movie', 'tv'])
  },
  'arabic-kirmzi': {
    upstream: 'kirmzi',
    label: 'Kirmzi',
    supportedTypes: new Set(['tv'])
  },
  'arabic-witanime': {
    upstream: 'witanime',
    label: 'WitAnime',
    supportedTypes: new Set(['movie', 'tv'])
  },
  'arabic-animecloud': {
    upstream: 'animecloud',
    label: 'AnimeCloud Arabic',
    supportedTypes: new Set(['movie', 'tv'])
  },
  'arabic-cineby': {
    upstream: 'cineby',
    label: 'Cineby Arabic',
    supportedTypes: new Set(['movie', 'tv'])
  }
});

const moduleCache = new Map();

try {
  require('node:dns').setDefaultResultOrder('ipv4first');
} catch {
  // Older Node builds may not expose this. Providers still work without it.
}

const loadProvider = (upstreamName) => {
  if (moduleCache.has(upstreamName)) {
    return moduleCache.get(upstreamName);
  }

  const loaded = require(`nuvio-providers-arabic/providers/${upstreamName}.js`);

  if (!loaded || typeof loaded.getStreams !== 'function') {
    throw new Error(`Arabic provider ${upstreamName} does not export getStreams`);
  }

  moduleCache.set(upstreamName, loaded);
  return loaded;
};

const normalizeMediaType = (mediaType) => {
  const normalized = String(mediaType || 'movie').trim().toLowerCase();

  if (normalized === 'series') {
    return 'tv';
  }

  return normalized === 'tv' ? 'tv' : 'movie';
};

const getHeaders = (stream) =>
  stream?.headers && typeof stream.headers === 'object'
    ? stream.headers
    : null;

const normalizeStream = (stream, providerId, label) => {
  if (!stream || typeof stream !== 'object') {
    return null;
  }

  const url = String(stream.url || '').trim();

  if (!/^https?:\/\//iu.test(url)) {
    return null;
  }

  return {
    ...stream,
    name: stream.name || label,
    title: stream.title || label,
    url,
    quality: stream.quality || 'Auto',
    headers: getHeaders(stream),
    language: stream.language || 'Arabic',
    provider: providerId
  };
};

const createProvider = (providerId) => {
  const config = PROVIDERS[providerId];

  if (!config) {
    throw new Error(`Unknown Arabic adapter: ${providerId}`);
  }

  return {
    async getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
      const normalizedMediaType = normalizeMediaType(mediaType);

      if (!config.supportedTypes.has(normalizedMediaType)) {
        return [];
      }

      try {
        const provider = loadProvider(config.upstream);
        const effectiveSeason = normalizedMediaType === 'tv'
          ? Number.parseInt(season, 10) || 1
          : null;
        const effectiveEpisode = normalizedMediaType === 'tv'
          ? Number.parseInt(episode, 10) || 1
          : null;
        const streams = await provider.getStreams(
          String(tmdbId),
          normalizedMediaType,
          effectiveSeason,
          effectiveEpisode
        );

        return Array.isArray(streams)
          ? streams.map((stream) => normalizeStream(stream, providerId, config.label)).filter(Boolean)
          : [];
      } catch (error) {
        console.error(`[${providerId}] ${error.message}`);
        return [];
      }
    }
  };
};

module.exports = { createProvider };
