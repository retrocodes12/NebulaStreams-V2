const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const M3U_SOURCES = {
  movie: 'https://raw.githubusercontent.com/mooncrown04/nuviotr/refs/heads/main/providers/M3U/Liste/film.m3u',
  tv: 'https://raw.githubusercontent.com/mooncrown04/nuviotr/refs/heads/main/providers/M3U/Liste/dizi.m3u'
};
const FETCH_TIMEOUT_MS = 8000;
const M3U_CACHE_TTL_MS = 5 * 60 * 1000;
const STREAM_HEADERS = {
  'User-Agent': 'VLC/3.0.18'
};

const m3uCache = new Map();

const fetchWithTimeout = async (url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
};

const normalizeTitle = (value) => String(value || '')
  .toLowerCase()
  .replace(/\u0131/gu, 'i')
  .replace(/\u011f/gu, 'g')
  .replace(/\u00fc/gu, 'u')
  .replace(/\u015f/gu, 's')
  .replace(/\u00f6/gu, 'o')
  .replace(/\u00e7/gu, 'c')
  .replace(/\([^)]*\)|\[[^\]]*\]/gu, '')
  .replace(/[^a-z0-9]/gu, '')
  .trim();

const getAttribute = (line, name) => {
  const match = line.match(new RegExp(`${name}="([^"]*)"`, 'iu'));
  return match ? match[1].trim() : '';
};

const getDisplayName = (line) => {
  const tvgName = getAttribute(line, 'tvg-name');

  if (tvgName) {
    return tvgName;
  }

  const commaIndex = line.lastIndexOf(',');
  return commaIndex >= 0 ? line.slice(commaIndex + 1).trim() : line.trim();
};

const getQuality = (line, url) => {
  const explicit = getAttribute(line, 'tvg-quality') || getAttribute(line, 'group-author');

  if (explicit) {
    return explicit;
  }

  const text = `${line} ${url}`.toLowerCase();

  if (text.includes('2160') || text.includes('4k')) return '4K';
  if (text.includes('1080')) return '1080p';
  if (text.includes('720')) return '720p';
  if (text.includes('480')) return '480p';
  return 'Auto';
};

const getLanguageLabel = (line) => {
  const explicit = getAttribute(line, 'tvg-language');

  if (explicit) {
    return explicit;
  }

  const text = line.toLowerCase();

  if (text.includes('dublaj')) return 'Turkish Dub';
  if (text.includes('altyazi') || text.includes('altyaz')) return 'Turkish Sub';
  return 'Turkish';
};

const findNextUrl = (lines, index) => {
  for (let offset = 1; offset <= 4; offset += 1) {
    const candidate = String(lines[index + offset] || '').trim();

    if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
      return candidate;
    }
  }

  return null;
};

const getTmdbDetails = async (tmdbId, mediaType) => {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const response = await fetchWithTimeout(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&language=tr-TR&append_to_response=external_ids`);

  if (!response.ok) {
    throw new Error(`TMDB HTTP ${response.status}`);
  }

  const data = await response.json();

  return {
    title: data.title || data.name || '',
    originalTitle: data.original_title || data.original_name || '',
    year: String(data.release_date || data.first_air_date || '').slice(0, 4),
    imdbId: data.external_ids?.imdb_id || null
  };
};

const getM3U = async (mediaType) => {
  const sourceUrl = mediaType === 'tv' ? M3U_SOURCES.tv : M3U_SOURCES.movie;
  const cached = m3uCache.get(sourceUrl);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const response = await fetchWithTimeout(sourceUrl);

  if (!response.ok) {
    throw new Error(`M3U HTTP ${response.status}`);
  }

  const value = (await response.text()).replace(/\r/gu, '').replace(/^\uFEFF/u, '');
  m3uCache.set(sourceUrl, {
    value,
    expiresAt: Date.now() + M3U_CACHE_TTL_MS
  });
  return value;
};

const isMovieMatch = ({ line, url, displayName, details }) => {
  const normalizedDisplay = normalizeTitle(displayName);
  const normalizedLine = normalizeTitle(line);
  const targetTitles = [details.title, details.originalTitle].map(normalizeTitle).filter(Boolean);
  const hasTitleMatch = targetTitles.some((title) => normalizedDisplay === title || normalizedLine.includes(title));
  const hasYearMismatch = details.year && /\b(19|20)\d{2}\b/u.test(line) && !line.includes(details.year);

  if (details.imdbId && (`${line} ${url}`).includes(details.imdbId)) {
    return true;
  }

  return hasTitleMatch && !hasYearMismatch;
};

const isEpisodeMatch = ({ line, details, season, episode }) => {
  const normalizedLine = normalizeTitle(line);
  const targetTitles = [details.title, details.originalTitle].map(normalizeTitle).filter(Boolean);
  const seasonNumber = Number.parseInt(season, 10);
  const episodeNumber = Number.parseInt(episode, 10);

  if (!Number.isInteger(seasonNumber) || !Number.isInteger(episodeNumber)) {
    return false;
  }

  const seasonPadded = String(seasonNumber).padStart(2, '0');
  const episodePadded = String(episodeNumber).padStart(2, '0');
  const episodeTags = [
    `s${seasonPadded}e${episodePadded}`,
    `s${seasonNumber}e${episodeNumber}`,
    `${seasonNumber}x${episodePadded}`,
    `${seasonNumber}x${episodeNumber}`,
    `${seasonNumber}sezon${episodeNumber}bolum`
  ];

  return targetTitles.some((title) => normalizedLine.includes(title))
    && episodeTags.some((tag) => normalizedLine.includes(tag));
};

async function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  const normalizedMediaType = mediaType === 'tv' ? 'tv' : 'movie';

  try {
    const details = await getTmdbDetails(tmdbId, normalizedMediaType);

    if (!details.title && !details.originalTitle) {
      return [];
    }

    const m3u = await getM3U(normalizedMediaType);
    const lines = m3u.split('\n');
    const streams = [];
    const seen = new Set();

    for (let index = 0; index < lines.length; index += 1) {
      const line = String(lines[index] || '').trim();

      if (!line.startsWith('#EXTINF')) {
        continue;
      }

      const url = findNextUrl(lines, index);

      if (!url || seen.has(url)) {
        continue;
      }

      const displayName = getDisplayName(line);
      const matched = normalizedMediaType === 'tv'
        ? isEpisodeMatch({ line, details, season, episode })
        : isMovieMatch({ line, url, displayName, details });

      if (!matched) {
        continue;
      }

      seen.add(url);
      const quality = getQuality(line, url);
      const language = getLanguageLabel(line);
      streams.push({
        name: `Turkish M3U ${quality}`,
        title: `${displayName}\nLanguage: ${language}`,
        url,
        quality,
        headers: STREAM_HEADERS,
        provider: 'turkish-m3u'
      });

      if (streams.length >= 12) {
        break;
      }
    }

    return streams;
  } catch (error) {
    console.error(`[TurkishM3U] ${error.message}`);
    return [];
  }
}

module.exports = { getStreams };
