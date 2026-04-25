const cheerio = require('cheerio-without-node-native');

const TMDB_API_KEY = process.env.TMDB_API_KEY || '1b3113663c9004682ed61086cf967c44';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const MAIN_URL = 'https://tamilian.io/';
const EMBEDOJO_HOST = 'https://embedojo.net';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  Referer: `${MAIN_URL}/`
};
const PREFERRED_LANGUAGES = new Set(['ta', 'te', 'hi', 'ml', 'kn']);
const TMDB_CANDIDATE_LIMIT = 6;

async function fetchWithTimeout(url, options = {}, timeout = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

function unpack(p, a, c, k) {
  const intToBase = (number, radix) => {
    if (radix <= 36) {
      return number.toString(radix);
    }

    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let output = '';
    let value = number;

    do {
      output = chars[value % radix] + output;
      value = Math.floor(value / radix);
    } while (value > 0);

    return output;
  };

  let code = p;
  let count = c;

  while (count--) {
    if (k[count]) {
      const placeholder = intToBase(count, a);
      code = code.replace(new RegExp(`\\b${placeholder}\\b`, 'g'), k[count]);
    }
  }

  return code;
}

function formatStreamTitle(mediaInfo, stream) {
  const yearPart = mediaInfo.year ? ` (${mediaInfo.year})` : '';

  return `Tamilian (Direct) (${stream.quality})
📼: ${mediaInfo.title}${yearPart}
🚜: tamilian | 🌐: MULTI`;
}

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]/g, '');
}

function getTitleVariants(title) {
  const raw = String(title || '').trim();
  const compact = raw.replace(/\s+/g, ' ').trim();
  const squashed = compact.replace(/\s+/g, '');

  return [...new Set([raw, compact, squashed, normalizeTitle(raw)].filter(Boolean))];
}

function scoreTmdbCandidate(query, candidate) {
  const candidateTitle = candidate.title || candidate.name || '';
  const queryVariants = getTitleVariants(query);
  const candidateVariants = getTitleVariants(candidateTitle);
  let score = 0;

  for (const queryVariant of queryVariants) {
    for (const candidateVariant of candidateVariants) {
      if (!queryVariant || !candidateVariant) {
        continue;
      }

      if (queryVariant === candidateVariant) {
        score = Math.max(score, 100);
      } else if (candidateVariant.includes(queryVariant) || queryVariant.includes(candidateVariant)) {
        score = Math.max(score, 80);
      }
    }
  }

  const queryNormalized = normalizeTitle(query);
  const candidateNormalized = normalizeTitle(candidateTitle);

  if (queryNormalized && candidateNormalized && score < 100) {
    const queryTokens = queryNormalized.match(/[a-z0-9]+/g) || [];
    const candidateTokens = candidateNormalized.match(/[a-z0-9]+/g) || [];
    const tokenHits = queryTokens.filter((token) => candidateTokens.includes(token)).length;

    score += tokenHits * 8;
    if (queryTokens.length > 0 && tokenHits === queryTokens.length) {
      score += 12;
    }
  }

  if (PREFERRED_LANGUAGES.has(candidate.original_language)) {
    score += 25;
  }

  const releaseDate = candidate.release_date || candidate.first_air_date || '';
  const releaseYear = Number.parseInt(String(releaseDate).slice(0, 4), 10);

  if (Number.isInteger(releaseYear)) {
    score += Math.max(0, releaseYear - 2000) * 0.6;
  }

  if (typeof candidate.popularity === 'number') {
    score += Math.min(candidate.popularity, 20) * 0.2;
  }

  return score;
}

async function extractFromEmbedojoDirect(tmdbId) {
  const categories = ['tamil', 'english', 'hindi', 'telugu', 'malayalam', 'kannada', 'dubbed'];

  const results = await Promise.all(categories.map(async (category) => {
    try {
      const pageUrl = `${EMBEDOJO_HOST}/${category}/tmdb/${tmdbId}`;
      const response = await fetchWithTimeout(pageUrl, { headers: HEADERS }, 6000);

      if (!response.ok) {
        return null;
      }

      const html = await response.text();
      const $ = cheerio.load(html);
      let packedScript = null;

      $('script').each((index, element) => {
        const content = $(element).html();

        if (content && content.includes('function(p,a,c,k,e,d)')) {
          packedScript = content;
          return false;
        }

        return undefined;
      });

      if (!packedScript) {
        return null;
      }

      const packerMatch = packedScript.match(/return p\}\('(.*)',\s*(\d+),\s*(\d+),\s*'(.*?)'\.split\(/s);

      if (!packerMatch) {
        return null;
      }

      const unpacked = unpack(
        packerMatch[1],
        Number.parseInt(packerMatch[2], 10),
        Number.parseInt(packerMatch[3], 10),
        packerMatch[4].split('|')
      );
      const tokenMatch = unpacked.match(/FirePlayer\s*\(\s*["']([^"']+)["']/);

      if (!tokenMatch) {
        return null;
      }

      const postResponse = await fetchWithTimeout(`${EMBEDOJO_HOST}/player/index.php?data=${tokenMatch[1]}&do=getVideo`, {
        method: 'POST',
        headers: {
          ...HEADERS,
          Origin: EMBEDOJO_HOST,
          'X-Requested-With': 'XMLHttpRequest'
        }
      }, 6000);

      if (!postResponse.ok) {
        return null;
      }

      const videoData = await postResponse.json();
      const finalUrl = videoData?.securedLink || videoData?.videoSource;

      if (!finalUrl) {
        return null;
      }

      return {
        url: finalUrl,
        quality: '1080p',
        label: `Embedojo ${category}`
      };
    } catch {
      return null;
    }
  }));

  return results.find(Boolean) || null;
}

async function getTMDBDetails(tmdbId, mediaType) {
  const type = mediaType === 'movie' ? 'movie' : 'tv';
  const response = await fetchWithTimeout(`${TMDB_BASE_URL}/${type}/${tmdbId}?api_key=${TMDB_API_KEY}`, {}, 8000);

  if (!response.ok) {
    throw new Error(`TMDB error: ${response.status}`);
  }

  const data = await response.json();

  if (!data.id) {
    throw new Error('Invalid TMDB ID');
  }

  return {
    title: data.title || data.name,
    year: String(data.release_date || data.first_air_date || '').split('-')[0] || null,
    tmdbId: data.id,
    originalLanguage: data.original_language || null
  };
}

async function searchTMDB(query, mediaType) {
  const type = mediaType === 'movie' ? 'movie' : 'tv';
  const url = `${TMDB_BASE_URL}/search/${type}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`;

  try {
    const response = await fetchWithTimeout(url, {}, 8000);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const candidates = Array.isArray(data?.results) ? data.results : [];

    return candidates
      .filter((candidate) => candidate?.id && (candidate.title || candidate.name))
      .map((candidate) => ({
        title: candidate.title || candidate.name,
        year: String(candidate.release_date || candidate.first_air_date || '').split('-')[0] || null,
        tmdbId: candidate.id,
        originalLanguage: candidate.original_language || null,
        score: scoreTmdbCandidate(query, candidate)
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, TMDB_CANDIDATE_LIMIT);
  } catch {
    return [];
  }
}

async function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  if (mediaType !== 'movie') {
    return [];
  }

  try {
    let mediaInfo;
    const isNumericId = /^\d+$/.test(String(tmdbId || ''));
    let cleanName = String(tmdbId || '').trim();

    if (!isNumericId) {
      cleanName = cleanName.replace(/\b(19|20)\d{2}\b/g, '').trim();
    }

    if (isNumericId) {
      mediaInfo = await getTMDBDetails(tmdbId, mediaType);
    } else {
      const candidates = await searchTMDB(cleanName, mediaType);

      for (const candidate of candidates) {
        const directStream = await extractFromEmbedojoDirect(candidate.tmdbId);

        if (!directStream?.url) {
          continue;
        }

        return [{
          name: 'Tamilian',
          title: formatStreamTitle(candidate, directStream),
          url: directStream.url,
          quality: directStream.quality || 'Unknown',
          headers: {
            Referer: MAIN_URL,
            Origin: EMBEDOJO_HOST,
            'User-Agent': HEADERS['User-Agent']
          },
          provider: 'tamilian'
        }];
      }

      return [];
    }

    if (!mediaInfo?.tmdbId) {
      return [];
    }

    const directStream = await extractFromEmbedojoDirect(mediaInfo.tmdbId);

    if (!directStream?.url) {
      return [];
    }

    return [{
      name: 'Tamilian',
      title: formatStreamTitle(mediaInfo, directStream),
      url: directStream.url,
      quality: directStream.quality || 'Unknown',
      headers: {
        Referer: MAIN_URL,
        Origin: EMBEDOJO_HOST,
        'User-Agent': HEADERS['User-Agent']
      },
      provider: 'tamilian'
    }];
  } catch {
    return [];
  }
}

module.exports = { getStreams };
