const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const FETCH_TIMEOUT_MS = 6000;

const HEADERS = {
  'Referer': 'https://vidmody.com/',
  'User-Agent': 'Mozilla/5.0'
};

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

const getTmdbDetails = async (tmdbId, mediaType) => {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const response = await fetchWithTimeout(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&language=tr-TR&append_to_response=external_ids`);

  if (!response.ok) {
    throw new Error(`TMDB HTTP ${response.status}`);
  }

  const data = await response.json();

  return {
    title: data.title || data.name || 'Vidmody',
    year: String(data.release_date || data.first_air_date || '').slice(0, 4),
    imdbId: data.external_ids?.imdb_id || null
  };
};

const buildVidmodyUrl = ({ imdbId, mediaType, season, episode }) => {
  if (mediaType === 'movie') {
    return `https://vidmody.com/vs/${imdbId}`;
  }

  const seasonNumber = Number.parseInt(season, 10);
  const episodeNumber = Number.parseInt(episode, 10);

  if (!Number.isInteger(seasonNumber) || !Number.isInteger(episodeNumber)) {
    return null;
  }

  return `https://vidmody.com/vs/${imdbId}/s${seasonNumber}/e${String(episodeNumber).padStart(2, '0')}`;
};

const linkExists = async (url) => {
  try {
    const response = await fetchWithTimeout(url, { method: 'HEAD', headers: HEADERS });
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  }
};

async function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  const normalizedMediaType = mediaType === 'tv' ? 'tv' : 'movie';

  try {
    const details = await getTmdbDetails(tmdbId, normalizedMediaType);

    if (!details.imdbId || !details.imdbId.startsWith('tt')) {
      return [];
    }

    const url = buildVidmodyUrl({
      imdbId: details.imdbId,
      mediaType: normalizedMediaType,
      season,
      episode
    });

    if (!url || !await linkExists(url)) {
      return [];
    }

    const episodeLabel = normalizedMediaType === 'tv'
      ? ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
      : '';

    return [{
      name: 'Vidmody TR',
      title: `${details.title}${details.year ? ` (${details.year})` : ''}${episodeLabel}`,
      url,
      quality: 'Auto',
      headers: HEADERS,
      provider: 'vidmody-tr'
    }];
  } catch (error) {
    console.error(`[VidmodyTR] ${error.message}`);
    return [];
  }
}

module.exports = { getStreams };
