const PROVIDERS = Object.freeze({
  'it-streamingcommunity': {
    upstream: 'streamingcommunity',
    label: 'StreamingCommunity',
    defaultTypes: new Set(['movie', 'tv'])
  },
  'it-guardahd': {
    upstream: 'guardahd',
    label: 'GuardaHD',
    defaultTypes: new Set(['movie'])
  },
  'it-guardaserie': {
    upstream: 'guardaserie',
    label: 'GuardaSerie',
    defaultTypes: new Set(['tv'])
  },
  'it-guardoserie': {
    upstream: 'guardoserie',
    label: 'GuardoSerie',
    defaultTypes: new Set(['movie', 'tv'])
  },
  'it-cc': {
    upstream: 'cc',
    label: 'CC',
    defaultTypes: new Set(['movie', 'tv'])
  },
  'it-animeunity': {
    upstream: 'animeunity',
    label: 'AnimeUnity',
    defaultTypes: new Set(['movie', 'tv'])
  },
  'it-animeworld': {
    upstream: 'animeworld',
    label: 'AnimeWorld IT',
    defaultTypes: new Set(['movie', 'tv'])
  },
  'it-animesaturn': {
    upstream: 'animesaturn',
    label: 'AnimeSaturn',
    defaultTypes: new Set(['movie', 'tv'])
  }
});

const moduleCache = new Map();

const normalizeBooleanEnv = (value, fallback = true) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
};

const configureEasyStreamsGlobals = () => {
  if (normalizeBooleanEnv(process.env.EASYSTREAMS_DISABLE_MIXDROP, true)) {
    global.DISABLE_MIXDROP = true;
  }

  if (normalizeBooleanEnv(process.env.EASYSTREAMS_DISABLE_UQLOAD, true)) {
    global.DISABLE_UQLOAD = true;
  }

  const proxyUrl = String(process.env.CF_PROXY_URL || '').trim().replace(/\/+$/u, '');

  if (/^https?:\/\//iu.test(proxyUrl)) {
    global.CF_PROXY_URL = proxyUrl;
  }
};

const loadProvider = (upstreamName) => {
  if (moduleCache.has(upstreamName)) {
    return moduleCache.get(upstreamName);
  }

  configureEasyStreamsGlobals();

  const loaded = require(`easystreams/src/${upstreamName}/index.js`);

  if (!loaded || typeof loaded.getStreams !== 'function') {
    throw new Error(`EasyStreams provider ${upstreamName} does not export getStreams`);
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

const getHeaders = (stream) => {
  if (stream?.headers && typeof stream.headers === 'object') {
    return stream.headers;
  }

  const proxyHeaders = stream?.behaviorHints?.proxyHeaders?.request;

  if (proxyHeaders && typeof proxyHeaders === 'object') {
    return proxyHeaders;
  }

  const behaviorHeaders = stream?.behaviorHints?.headers;

  if (behaviorHeaders && typeof behaviorHeaders === 'object') {
    return behaviorHeaders;
  }

  return null;
};

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
    quality: stream.quality || stream.qualityTag || 'Auto',
    headers: getHeaders(stream),
    language: stream.language || 'Italian',
    provider: providerId
  };
};

const createProvider = (providerId) => {
  const config = PROVIDERS[providerId];

  if (!config) {
    throw new Error(`Unknown EasyStreams adapter: ${providerId}`);
  }

  return {
    async getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
      const normalizedMediaType = normalizeMediaType(mediaType);

      if (!config.defaultTypes.has(normalizedMediaType)) {
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
        const context = {
          __requestContext: true,
          idType: 'tmdb-numeric',
          providerId: String(tmdbId),
          tmdbId: String(tmdbId),
          requestedSeason: effectiveSeason,
          seasonProvided: effectiveSeason !== null,
          mappingLanguage: 'it',
          easyCatalogsLangIt: true
        };
        const streams = await provider.getStreams(
          String(tmdbId),
          normalizedMediaType,
          effectiveSeason,
          effectiveEpisode,
          context
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
