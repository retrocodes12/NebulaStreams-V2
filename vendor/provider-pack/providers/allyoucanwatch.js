'use strict';

const BASE_URLS = Object.freeze([
  'https://allyoucanwatch.net',
  'https://allyoucanwatch.xyz'
]);

const DEFAULT_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Accept': 'text/event-stream,application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9'
});

const TAG = '[AllYouCanWatch]';
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_TITLE_CACHE = new Map();

function normalizeMediaType(mediaType) {
  const normalized = String(mediaType || '').trim().toLowerCase();
  return normalized === 'tv' || normalized === 'series' ? 'series' : 'movie';
}

function normalizeValue(value) {
  return String(value || '').trim();
}

function toAbsoluteUrl(baseUrl, value) {
  const normalized = normalizeValue(value);
  if (!normalized) {
    return '';
  }

  try {
    return new URL(normalized, baseUrl).toString();
  } catch (_) {
    return normalized;
  }
}

function buildPlayerUrl(baseUrl, tmdbId, mediaType, season, episode) {
  if (mediaType === 'series') {
    return `${baseUrl}/player/new_player.html?tmdb=${tmdbId}&type=series&s=${season || 1}&e=${episode || 1}&prefServer=auto&prefQuality=auto`;
  }

  return `${baseUrl}/player/new_player.html?tmdb=${tmdbId}&prefServer=auto&prefQuality=auto`;
}

function buildSseUrl(baseUrl, tmdbId, mediaType, season, episode) {
  if (mediaType === 'series') {
    return `${baseUrl}/api/sources/stream?tmdb=${tmdbId}&s=${season || 1}&e=${episode || 1}`;
  }

  return `${baseUrl}/api/sources/stream?tmdb=${tmdbId}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 18000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function parseSsePayloads(rawText) {
  const payloads = [];
  const chunks = String(rawText || '').split(/\n\n+/);

  for (const chunk of chunks) {
    const dataLines = chunk
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);

    if (dataLines.length === 0) {
      continue;
    }

    try {
      payloads.push(JSON.parse(dataLines.join('\n')));
    } catch (error) {
      console.warn(`${TAG} failed to parse SSE payload: ${error.message}`);
    }
  }

  return payloads;
}

function parseSubtitleLanguages(captions) {
  const languages = [];

  for (const caption of Array.isArray(captions) ? captions : []) {
    const language = normalizeValue(caption && caption.language)
      .replace(/\s*-\s*.*/g, '')
      .trim();

    if (language && !languages.includes(language)) {
      languages.push(language);
    }
  }

  return languages;
}

function normalizeComparableTitle(value) {
  return normalizeValue(value)
    .replace(/\bS\d{1,2}E\d{1,3}\b/gi, ' ')
    .replace(/\bSeason\s+\d+\b/gi, ' ')
    .replace(/\bEpisode\s+\d+\b/gi, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function decodeHtmlEntities(value) {
  return normalizeValue(value)
    .replace(/&#(\d+);/g, (_, code) => {
      const num = parseInt(code, 10);
      return Number.isFinite(num) ? String.fromCharCode(num) : '';
    })
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function titleMatchesExpected(value, expectedTitles) {
  const normalized = normalizeComparableTitle(value);
  if (!normalized) {
    return false;
  }

  return expectedTitles.some((expected) =>
    normalized === expected
    || normalized.startsWith(`${expected} `)
    || expected.startsWith(`${normalized} `)
  );
}

async function getExpectedTitles(tmdbId, mediaType) {
  const cacheKey = `${mediaType}:${tmdbId}`;
  const cached = TMDB_TITLE_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.titles;
  }

  const endpoint = mediaType === 'series' ? 'tv' : 'movie';
  const url = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;

  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': DEFAULT_HEADERS['User-Agent'],
        'Accept': 'application/json'
      }
    }, 8000);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const titles = [
      normalizeComparableTitle(mediaType === 'series' ? data && data.name : data && data.title),
      normalizeComparableTitle(mediaType === 'series' ? data && data.original_name : data && data.original_title)
    ].filter(Boolean);

    const uniqueTitles = Array.from(new Set(titles));
    TMDB_TITLE_CACHE.set(cacheKey, {
      titles: uniqueTitles,
      expiresAt: Date.now() + (6 * 60 * 60 * 1000)
    });
    return uniqueTitles;
  } catch (error) {
    console.warn(`${TAG} TMDB title lookup failed for ${mediaType} ${tmdbId}: ${error.message}`);
  }

  try {
    const endpoint = mediaType === 'series' ? 'tv' : 'movie';
    const pageUrl = `https://www.themoviedb.org/${endpoint}/${tmdbId}`;
    const response = await fetchWithTimeout(pageUrl, {
      headers: {
        'User-Agent': DEFAULT_HEADERS['User-Agent'],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://www.themoviedb.org/'
      }
    }, 8000);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const titles = [];
    const scriptMatches = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi) || [];
    for (const scriptTag of scriptMatches) {
      const match = scriptTag.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
      if (!match || !match[1]) {
        continue;
      }
      try {
        const parsed = JSON.parse(decodeHtmlEntities(match[1]));
        const parsedType = normalizeValue(parsed && parsed['@type']);
        if (parsedType && parsedType !== 'TVSeries' && parsedType !== 'Movie') {
          continue;
        }
        const title = normalizeComparableTitle(parsed && parsed.name);
        const alt = normalizeComparableTitle(parsed && parsed.alternateName);
        if (title) {
          titles.push(title);
        }
        if (alt) {
          titles.push(alt);
        }
      } catch (_) {}
    }

    if (titles.length === 0) {
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      if (titleMatch && titleMatch[1]) {
        titles.push(normalizeComparableTitle(
          decodeHtmlEntities(titleMatch[1])
            .replace(/\s+—\s+The Movie Database.*$/i, '')
            .replace(/\s+\((?:TV Series|Movie)[^)]+\)\s*$/i, '')
        ));
      }
    }

    const uniqueTitles = Array.from(new Set(titles.filter(Boolean)));
    if (uniqueTitles.length > 0) {
      TMDB_TITLE_CACHE.set(cacheKey, {
        titles: uniqueTitles,
        expiresAt: Date.now() + (6 * 60 * 60 * 1000)
      });
      return uniqueTitles;
    }
  } catch (error) {
    console.warn(`${TAG} TMDB page fallback failed for ${mediaType} ${tmdbId}: ${error.message}`);
  }

  return [];
}

function buildMovieStreams(baseUrl, payload) {
  const entries = Array.isArray(payload && payload.streams) ? payload.streams : [];
  const streams = [];

  for (const entry of entries) {
    const url = normalizeValue(entry && entry.url);
    if (!url || /^error$/i.test(url)) {
      continue;
    }

    const quality = normalizeValue(entry && entry.quality) || 'Auto';
    const title = normalizeValue(entry && entry.title) || 'AllYouCanWatch';
    const provider = normalizeValue(entry && entry.provider) || 'Provider';
    const size = normalizeValue(entry && entry.size);

    streams.push({
      name: `AllYouCanWatch | ${quality}`,
      title: [
        title,
        `${provider}${size ? ` | ${size}` : ''}`
      ].join('\n'),
      url: toAbsoluteUrl(baseUrl, url),
      quality,
      headers: entry && typeof entry.headers === 'object' ? entry.headers : undefined,
      provider: 'allyoucanwatch',
      sourceProvider: provider
    });
  }

  return streams;
}

function formatPayloadTypeLabel(payloadType) {
  const normalized = normalizeValue(payloadType);
  if (!normalized) {
    return 'Provider';
  }

  return normalized
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildDirectStream(baseUrl, payload, tmdbId, mediaType, season, episode) {
  const url = normalizeValue(payload && payload.url);
  if (!url) {
    return null;
  }

  const sourceProvider = formatPayloadTypeLabel(payload && payload.type);
  const subtitleLanguages = parseSubtitleLanguages(payload && payload.captions);
  const subtitleLabel = subtitleLanguages.length > 0
    ? ` | Subs: ${subtitleLanguages.join(', ')}`
    : '';
  const titleLabel = mediaType === 'series'
    ? `TMDB ${tmdbId} S${String(season || 1).padStart(2, '0')}E${String(episode || 1).padStart(2, '0')}`
    : `TMDB ${tmdbId}`;

  return {
    name: 'AllYouCanWatch | Auto',
    title: [
      titleLabel,
      `${sourceProvider}${subtitleLabel}`
    ].join('\n'),
    url: toAbsoluteUrl(baseUrl, url),
    quality: 'Auto',
    headers: {
      Referer: buildPlayerUrl(baseUrl, tmdbId, mediaType, season, episode)
    },
    provider: 'allyoucanwatch',
    sourceProvider
  };
}

function dedupeStreams(streams) {
  const deduped = [];
  const seen = new Set();

  for (const stream of streams) {
    const key = `${normalizeValue(stream && stream.url)}|${normalizeValue(stream && stream.name)}`;
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(stream);
  }

  return deduped;
}

async function tryFetchStreams(baseUrl, tmdbId, mediaType, season, episode, expectedTitles = []) {
  const playerUrl = buildPlayerUrl(baseUrl, tmdbId, mediaType, season, episode);
  const sseUrl = buildSseUrl(baseUrl, tmdbId, mediaType, season, episode);
  const response = await fetchWithTimeout(sseUrl, {
    headers: {
      ...DEFAULT_HEADERS,
      Referer: playerUrl
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const rawText = await response.text();
  const payloads = parseSsePayloads(rawText);
  if (payloads.length === 0) {
    return [];
  }

  const streams = [];

  for (const payload of payloads) {
    if (Array.isArray(payload && payload.streams)) {
      const titledEntries = payload.streams
        .map((entry) => normalizeValue(entry && entry.title))
        .filter(Boolean);
      if (expectedTitles.length === 0 && titledEntries.length > 0) {
        console.warn(`${TAG} skipping unverified provider catalog for ${mediaType} ${tmdbId}: ${titledEntries.slice(0, 3).join(' | ')}`);
        continue;
      }

      const filteredPayload = expectedTitles.length > 0
        ? {
          ...payload,
          streams: payload.streams.filter((entry) => {
            const title = normalizeValue(entry && entry.title);
            return !title || titleMatchesExpected(title, expectedTitles);
          })
        }
        : payload;

      if (expectedTitles.length > 0 && titledEntries.length > 0 && filteredPayload.streams.length === 0) {
        console.warn(`${TAG} rejected mismatched provider catalog for ${mediaType} ${tmdbId}: ${titledEntries.slice(0, 3).join(' | ')}`);
        continue;
      }

      streams.push(...buildMovieStreams(baseUrl, filteredPayload));
      continue;
    }

    const directStream = buildDirectStream(baseUrl, payload, tmdbId, mediaType, season, episode);
    if (directStream) {
      streams.push(directStream);
    }
  }

  return dedupeStreams(streams);
}

async function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  const normalizedMediaType = normalizeMediaType(mediaType);
  const expectedTitles = await getExpectedTitles(tmdbId, normalizedMediaType);

  if (expectedTitles.length === 0) {
    console.warn(`${TAG} proceeding in degraded mode for ${normalizedMediaType} ${tmdbId}: expected title verification unavailable`);
  }

  for (const baseUrl of BASE_URLS) {
    try {
      const streams = await tryFetchStreams(baseUrl, tmdbId, normalizedMediaType, season, episode, expectedTitles);
      if (streams.length > 0) {
        console.log(`${TAG} ${normalizedMediaType} ${tmdbId} -> ${streams.length} streams via ${baseUrl}`);
        return streams;
      }
    } catch (error) {
      console.warn(`${TAG} ${normalizedMediaType} ${tmdbId} failed via ${baseUrl}: ${error.message}`);
    }
  }

  console.log(`${TAG} ${normalizedMediaType} ${tmdbId} -> 0 streams`);
  return [];
}

module.exports = { getStreams };
