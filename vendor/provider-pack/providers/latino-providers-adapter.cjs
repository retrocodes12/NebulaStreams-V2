const PROVIDERS = Object.freeze({
  'latino-lamovie': {
    upstream: 'lamovie',
    label: 'LaMovie',
    supportedTypes: new Set(['movie', 'tv'])
  },
  'latino-cinecalidad': {
    upstream: 'cinecalidad',
    label: 'CineCalidad',
    supportedTypes: new Set(['movie'])
  },
  'latino-embed69': {
    upstream: 'embed69',
    label: 'Embed69 Latino',
    supportedTypes: new Set(['movie', 'tv'])
  },
  'latino-xupalace': {
    upstream: 'xupalace',
    label: 'XuPalace',
    supportedTypes: new Set(['movie', 'tv'])
  },
  'latino-seriesmetro': {
    upstream: 'seriesmetro',
    label: 'SeriesMetro',
    supportedTypes: new Set(['movie', 'tv'])
  }
});

const moduleCache = new Map();
const LATINO_TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const LAMOVIE_BASE_URL = 'https://la.movie';
const LAMOVIE_GENRE_ANIMATION = 16;
const LAMOVIE_ANIME_COUNTRIES = new Set(['JP', 'CN', 'KR']);
const nativeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
const DEFAULT_FETCH_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache'
});
const RETRYABLE_FETCH_HOSTS = new Set([
  'api.themoviedb.org',
  'www.cinecalidad.vg',
  'www.cinecalidad.ec',
  'cinecalidad.am',
  'cinecalidad.ltd',
  'cinecalidad.nexus',
  'goodstream.one',
  'hlswish.com',
  'streamwish.com',
  'streamwish.to',
  'strwish.com',
  'vimeos.net',
  'filemoon.sx',
  'filemoon.to',
  'filemooon.link'
]);
const CLOUDFLARE_PROTECTED_HOSTS = new Set([
  'embed69.org',
  'xupalace.org',
  'www3.seriesmetro.net'
]);
let latinoFetchInstalled = false;

try {
  require('node:dns').setDefaultResultOrder('ipv4first');
} catch {
  // Older Node builds may not expose this. Providers still work without it.
}

const sleep = (delayMs) => new Promise((resolve) => {
  const timer = setTimeout(resolve, delayMs);
  timer.unref?.();
});
const normalizeSlugPart = (value = '') =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

const stripLeadingArticles = (value = '') =>
  String(value || '')
    .replace(/^(the|a|an|el|la|los|las|un|una|unos|unas)\s+/i, '')
    .trim();

const buildSlugCandidates = (title, year) => {
  const candidates = new Set();
  const baseValues = [title, stripLeadingArticles(title)].filter(Boolean);

  for (const value of baseValues) {
    const normalized = normalizeSlugPart(value);
    if (!normalized) {
      continue;
    }

    candidates.add(normalized);

    if (year) {
      candidates.add(`${normalized}-${year}`);
    }
  }

  return [...candidates];
};

const httpGetText = async (url, headers = {}) => {
  const response = await fetch(url, {
    headers: buildFetchHeaders(url, headers),
    redirect: 'follow'
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
};

const httpGetJson = async (url, headers = {}) => {
  const response = await fetch(url, {
    headers: buildFetchHeaders(url, headers),
    redirect: 'follow'
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
};

const shouldRetryError = (error) => {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('fetch failed') ||
    message.includes('econnreset') ||
    message.includes('connect timeout') ||
    message.includes('headers timeout') ||
    message.includes('socket hang up') ||
    message.includes('other side closed') ||
    message.includes('networkerror')
  );
};

const getFetchPolicy = (hostname) => {
  if (hostname === 'api.themoviedb.org') {
    return { attempts: 3, timeoutMs: 12000 };
  }

  if (hostname === 'goodstream.one' || hostname === 'hlswish.com' || hostname === 'streamwish.com' || hostname === 'streamwish.to' || hostname === 'strwish.com') {
    return { attempts: 1, timeoutMs: 6000 };
  }

  if (hostname === 'vimeos.net' || hostname === 'filemoon.sx' || hostname === 'filemoon.to' || hostname === 'filemooon.link') {
    return { attempts: 1, timeoutMs: 7000 };
  }

  if (CLOUDFLARE_PROTECTED_HOSTS.has(hostname)) {
    return { attempts: 2, timeoutMs: 8000 };
  }

  return { attempts: 2, timeoutMs: 10000 };
};

const buildFetchHeaders = (url, headers = {}) => {
  const merged = {
    ...DEFAULT_FETCH_HEADERS,
    ...(headers || {})
  };

  try {
    const target = new URL(url);
    if (!merged.Referer && CLOUDFLARE_PROTECTED_HOSTS.has(target.hostname)) {
      merged.Referer = `${target.origin}/`;
      merged.Origin = target.origin;
      merged['Upgrade-Insecure-Requests'] = '1';
    }
  } catch {
    // Ignore malformed URL handling here and let fetch fail normally.
  }

  return merged;
};

const installLatinoFetchWrapper = () => {
  if (latinoFetchInstalled || !nativeFetch) {
    return;
  }

  globalThis.fetch = async (input, init = {}) => {
    const requestUrl = typeof input === 'string' ? input : input?.url;
    let hostname = '';

    try {
      hostname = requestUrl ? new URL(requestUrl).hostname.toLowerCase() : '';
    } catch {
      hostname = '';
    }

    const shouldWrap = RETRYABLE_FETCH_HOSTS.has(hostname) || CLOUDFLARE_PROTECTED_HOSTS.has(hostname);

    if (!shouldWrap) {
      return nativeFetch(input, init);
    }

    const { attempts, timeoutMs } = getFetchPolicy(hostname);

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(new Error(`Fetch timeout for ${hostname}`)), timeoutMs);
      timeoutId.unref?.();

      try {
        const mergedHeaders = buildFetchHeaders(requestUrl, init?.headers);
        const response = await nativeFetch(input, {
          ...init,
          headers: mergedHeaders,
          signal: init?.signal || controller.signal
        });

        clearTimeout(timeoutId);

        if (response.status === 403 && CLOUDFLARE_PROTECTED_HOSTS.has(hostname) && attempt + 1 < attempts) {
          await sleep((attempt + 1) * 500);
          continue;
        }

        return response;
      } catch (error) {
        clearTimeout(timeoutId);

        if (!shouldRetryError(error) || attempt + 1 >= attempts) {
          throw error;
        }

        await sleep((attempt + 1) * 500);
      }
    }

    return nativeFetch(input, init);
  };

  latinoFetchInstalled = true;
};

installLatinoFetchWrapper();

const extractShortlinkId = (html = '') => {
  const match = String(html).match(/rel=['"]shortlink['"]\s+href=['"][^'"]*\?p=(\d+)['"]/i);
  return match ? match[1] : null;
};

const detectM3u8Quality = async (m3u8Url, headers = {}) => {
  try {
    const playlist = await httpGetText(m3u8Url, {
      'Accept': 'application/vnd.apple.mpegurl,text/plain,*/*',
      ...headers
    });
    const matches = [...playlist.matchAll(/RESOLUTION=\d+x(\d+)/gi)].map((match) => Number.parseInt(match[1], 10));
    const bestHeight = matches.length ? Math.max(...matches.filter((value) => Number.isFinite(value))) : 0;

    if (bestHeight >= 2160) {
      return '2160p';
    }

    if (bestHeight >= 1080) {
      return '1080p';
    }

    if (bestHeight >= 720) {
      return '720p';
    }

    if (bestHeight >= 480) {
      return '480p';
    }

    const fallbackMatch = String(m3u8Url).match(/[_-](\d{3,4})p/i);
    return fallbackMatch ? `${fallbackMatch[1]}p` : '1080p';
  } catch {
    const fallbackMatch = String(m3u8Url).match(/[_-](\d{3,4})p/i);
    return fallbackMatch ? `${fallbackMatch[1]}p` : '1080p';
  }
};

const resolveVimeosEmbed = async (embedUrl) => {
  try {
    const html = await httpGetText(embedUrl, {
      'Referer': 'https://vimeos.net/',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    });
    const packMatch = html.match(/eval\(function\(p,a,c,k,e,[dr]\)\{[\s\S]+?\}\('([\s\S]+?)',(\d+),(\d+),'([\s\S]+?)'\.split\('\|'\)/i);

    if (!packMatch) {
      return null;
    }

    const payload = packMatch[1];
    const radix = Number.parseInt(packMatch[2], 10);
    const symtab = packMatch[4].split('|');
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const unbase = (value) => {
      let result = 0;
      for (const char of value) {
        const index = chars.indexOf(char);
        if (index < 0) {
          return Number.NaN;
        }
        result = (result * radix) + index;
      }
      return result;
    };
    const unpacked = payload.replace(/\b(\w+)\b/g, (match) => {
      const index = unbase(match);
      return Number.isFinite(index) && symtab[index] ? symtab[index] : match;
    });
    const streamMatch = unpacked.match(/["']([^"']+\.m3u8[^"']*)["']/i);

    if (!streamMatch) {
      return null;
    }

    const headers = { 'Referer': 'https://vimeos.net/' };
    return {
      url: streamMatch[1],
      quality: await detectM3u8Quality(streamMatch[1], headers),
      headers
    };
  } catch {
    return null;
  }
};

const resolveGoodstreamEmbed = async (embedUrl) => {
  try {
    const html = await httpGetText(embedUrl, {
      'Referer': 'https://goodstream.one',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    });
    const match = html.match(/file:\s*"([^"]+)"/i);

    if (!match) {
      return null;
    }

    const headers = {
      'Referer': embedUrl,
      'Origin': 'https://goodstream.one'
    };

    return {
      url: match[1],
      quality: await detectM3u8Quality(match[1], headers),
      headers
    };
  } catch {
    return null;
  }
};

const getLaMovieCategories = (mediaType, genres = [], originCountries = []) => {
  if (mediaType === 'movie') {
    return ['peliculas'];
  }

  const isAnimation = Array.isArray(genres) && genres.includes(LAMOVIE_GENRE_ANIMATION);
  const isAnime = Array.isArray(originCountries) && originCountries.some((country) => LAMOVIE_ANIME_COUNTRIES.has(country));

  return isAnimation && isAnime ? ['anime'] : ['series'];
};

const getLatinoTmdbInfo = async (tmdbId, mediaType) => {
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  const languages = ['es-MX', 'en-US'];

  for (const language of languages) {
    try {
      const data = await httpGetJson(`https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${LATINO_TMDB_API_KEY}&language=${language}`);
      const title = type === 'movie' ? data?.title : data?.name;
      const originalTitle = type === 'movie' ? data?.original_title : data?.original_name;

      if (!title && !originalTitle) {
        continue;
      }

      return {
        title: title || originalTitle,
        originalTitle: originalTitle || title || '',
        year: String(data?.release_date || data?.first_air_date || '').slice(0, 4),
        genres: Array.isArray(data?.genres) ? data.genres.map((genre) => genre.id).filter(Number.isFinite) : [],
        originCountries: Array.isArray(data?.origin_country) && data.origin_country.length
          ? data.origin_country
          : Array.isArray(data?.production_countries)
            ? data.production_countries.map((country) => country.iso_3166_1).filter(Boolean)
            : []
      };
    } catch {
      // Try the next language variant.
    }
  }

  return null;
};

const getLaMovieIdBySlug = async (category, slug) => {
  try {
    const html = await httpGetText(`${LAMOVIE_BASE_URL}/${category}/${slug}/`, {
      'Accept-Language': 'es-MX,es;q=0.9'
    });
    const id = extractShortlinkId(html);
    return id ? { id, slug, category } : null;
  } catch {
    return null;
  }
};

const getLaMovieEpisodeId = async (seriesId, season, episode) => {
  try {
    const data = await httpGetJson(`${LAMOVIE_BASE_URL}/wp-api/v1/single/episodes/list?_id=${seriesId}&season=${season}&page=1&postsPerPage=50`, {
      'Accept': 'application/json'
    });
    const posts = Array.isArray(data?.data?.posts) ? data.data.posts : [];
    const match = posts.find((item) => Number(item?.season_number) === season && Number(item?.episode_number) === episode);
    return match?._id ? String(match._id) : null;
  } catch {
    return null;
  }
};

const resolveLaMovieEmbeds = async (embeds = []) => {
  const resolved = [];

  for (const embed of embeds) {
    const embedUrl = String(embed?.url || '').trim();

    if (!/^https?:\/\//i.test(embedUrl)) {
      continue;
    }

    let result = null;

    if (embedUrl.includes('vimeos.net')) {
      result = await resolveVimeosEmbed(embedUrl);
    } else if (embedUrl.includes('goodstream.one')) {
      result = await resolveGoodstreamEmbed(embedUrl);
    }

    if (!result?.url) {
      continue;
    }

    resolved.push({
      name: 'LaMovie',
      title: `${result.quality || 'Auto'} · ${embedUrl.includes('vimeos.net') ? 'Vimeos' : 'GoodStream'}`,
      url: result.url,
      quality: result.quality || 'Auto',
      headers: result.headers || {}
    });
  }

  const deduped = [];
  const seen = new Set();

  for (const stream of resolved) {
    const key = `${stream.url}::${JSON.stringify(stream.headers || {})}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(stream);
  }

  return deduped;
};

const getLaMovieFallbackStreams = async (tmdbId, mediaType, season, episode) => {
  const tmdbInfo = await getLatinoTmdbInfo(tmdbId, mediaType);

  if (!tmdbInfo) {
    return [];
  }

  const categories = getLaMovieCategories(mediaType, tmdbInfo.genres, tmdbInfo.originCountries);
  const slugCandidates = [
    ...buildSlugCandidates(tmdbInfo.title, tmdbInfo.year),
    ...buildSlugCandidates(tmdbInfo.originalTitle, tmdbInfo.year)
  ];
  const orderedSlugCandidates = [...new Set(slugCandidates.filter(Boolean))];
  let match = null;

  for (const slug of orderedSlugCandidates) {
    for (const category of categories) {
      match = await getLaMovieIdBySlug(category, slug);
      if (match) {
        break;
      }
    }

    if (match) {
      break;
    }
  }

  if (!match?.id) {
    return [];
  }

  let targetId = String(match.id);

  if (mediaType === 'tv') {
    const episodeId = await getLaMovieEpisodeId(targetId, season, episode);

    if (!episodeId) {
      return [];
    }

    targetId = episodeId;
  }

  try {
    const playerData = await httpGetJson(`${LAMOVIE_BASE_URL}/wp-api/v1/player?postId=${targetId}&demo=0`, {
      'Accept': 'application/json'
    });
    const embeds = Array.isArray(playerData?.data?.embeds) ? playerData.data.embeds : [];
    return resolveLaMovieEmbeds(embeds);
  } catch {
    return [];
  }
};

const loadProvider = (upstreamName) => {
  if (moduleCache.has(upstreamName)) {
    return moduleCache.get(upstreamName);
  }

  const loaded = require(`nuvio-providers-latino/providers/${upstreamName}.js`);

  if (!loaded || typeof loaded.getStreams !== 'function') {
    throw new Error(`Latino provider ${upstreamName} does not export getStreams`);
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
    language: stream.language || 'Latino',
    provider: providerId
  };
};

const createProvider = (providerId) => {
  const config = PROVIDERS[providerId];

  if (!config) {
    throw new Error(`Unknown Latino adapter: ${providerId}`);
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

        if (config.upstream === 'lamovie' && (!Array.isArray(streams) || streams.length === 0)) {
          const fallbackStreams = await getLaMovieFallbackStreams(
            String(tmdbId),
            normalizedMediaType,
            effectiveSeason,
            effectiveEpisode
          );

          if (fallbackStreams.length > 0) {
            return fallbackStreams
              .map((stream) => normalizeStream(stream, providerId, config.label))
              .filter(Boolean);
          }
        }

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
