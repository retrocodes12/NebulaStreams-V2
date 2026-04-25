const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const BASE_URL = 'https://a.prectv67.lol';
const SW_KEY = '4F5A9C3D9A86FA54EACEDDD635185/c3c5bd17-e37b-4b94-a944-8a3688a30452';
const FETCH_TIMEOUT_MS = 8000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Referer': 'https://twitter.com/',
  'Accept': 'application/json'
};

const STREAM_HEADERS = {
  'User-Agent': 'googleusercontent',
  'Referer': 'https://twitter.com/',
  'Accept-Encoding': 'identity'
};

let cachedToken = null;
let cachedTokenExpiresAt = 0;

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
  .replace(/[^a-z0-9]/gu, '')
  .trim();

const getJson = async (url, options = {}) => {
  const response = await fetchWithTimeout(url, options);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
};

const getAuthToken = async () => {
  if (cachedToken && cachedTokenExpiresAt > Date.now()) {
    return cachedToken;
  }

  const response = await fetchWithTimeout(`${BASE_URL}/api/attest/nonce`, { headers: HEADERS });
  const text = await response.text();

  try {
    const data = JSON.parse(text);
    cachedToken = data.accessToken || text.trim();
  } catch {
    cachedToken = text.trim();
  }

  cachedTokenExpiresAt = Date.now() + (30 * 60 * 1000);
  return cachedToken;
};

const getTmdbDetails = async (tmdbId, mediaType) => {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const response = await fetchWithTimeout(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}?language=tr-TR&api_key=${TMDB_API_KEY}`);

  if (!response.ok) {
    throw new Error(`TMDB HTTP ${response.status}`);
  }

  const data = await response.json();

  return {
    title: data.title || data.name || '',
    originalTitle: data.original_title || data.original_name || '',
    year: String(data.release_date || data.first_air_date || '').slice(0, 4)
  };
};

const isTitleMatch = (item, details) => {
  const itemTitle = normalizeTitle(item.title);
  const titles = [details.title, details.originalTitle].map(normalizeTitle).filter(Boolean);

  return titles.some((title) =>
    itemTitle === title
    || itemTitle === `${title}${details.year}`
    || (details.year && itemTitle.startsWith(title) && String(item.title || '').includes(details.year)));
};

const streamLanguageLabel = (url, label, index) => {
  const text = `${url || ''} ${label || ''}`.toLowerCase();

  if (text.includes('dublaj')) {
    return 'Turkish Dub';
  }

  if (text.includes('altyaz')) {
    return 'Turkish Sub';
  }

  return index === 0 ? 'Turkish' : 'Turkish Alt';
};

const toStreams = (sources, label) => Array.isArray(sources)
  ? sources
    .filter((source) => source?.url)
    .map((source, index) => ({
      name: `RecTV TR ${streamLanguageLabel(source.url, label, index)}`,
      title: label || 'RecTV TR',
      url: source.url,
      quality: 'Auto',
      headers: STREAM_HEADERS,
      provider: 'rectv-tr'
    }))
  : [];

async function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  const normalizedMediaType = mediaType === 'tv' ? 'tv' : 'movie';

  try {
    const details = await getTmdbDetails(tmdbId, normalizedMediaType);

    if (!details.title && !details.originalTitle) {
      return [];
    }

    const token = await getAuthToken();
    const searchHeaders = {
      ...HEADERS,
      'Authorization': `Bearer ${token}`
    };
    const searchData = await getJson(`${BASE_URL}/api/search/${encodeURIComponent(details.title)}/${SW_KEY}/`, { headers: searchHeaders });
    const items = [...(searchData.series || []), ...(searchData.posters || [])]
      .filter((item) => item && isTitleMatch(item, details));

    const streams = [];

    for (const item of items) {
      const itemType = String(item.type || '').toLowerCase();

      if (normalizedMediaType === 'tv' || itemType === 'serie') {
        const seasons = await getJson(`${BASE_URL}/api/season/by/serie/${item.id}/${SW_KEY}/`, { headers: searchHeaders });
        const targetSeason = Array.isArray(seasons)
          ? seasons.find((entry) => Number.parseInt(String(entry.title || '').match(/\d+/)?.[0] || '', 10) === Number.parseInt(season, 10))
          : null;
        const targetEpisode = targetSeason?.episodes?.find((entry) =>
          Number.parseInt(String(entry.title || '').match(/\d+/)?.[0] || '', 10) === Number.parseInt(episode, 10));

        streams.push(...toStreams(targetEpisode?.sources, targetEpisode?.label || targetSeason?.title || item.label || item.title));
      } else if (normalizedMediaType === 'movie') {
        let sources = item.sources || [];

        if (sources.length === 0) {
          const movieDetails = await getJson(`${BASE_URL}/api/movie/${item.id}/${SW_KEY}/`, { headers: searchHeaders });
          sources = movieDetails.sources || [];
        }

        streams.push(...toStreams(sources, item.label || item.title));
      }

      if (streams.length >= 12) {
        break;
      }
    }

    const seenUrls = new Set();
    return streams.filter((stream) => {
      if (seenUrls.has(stream.url)) {
        return false;
      }

      seenUrls.add(stream.url);
      return true;
    });
  } catch (error) {
    console.error(`[RecTVTR] ${error.message}`);
    return [];
  }
}

module.exports = { getStreams };
