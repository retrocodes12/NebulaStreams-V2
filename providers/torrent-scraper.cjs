const axios = require('axios');
const cheerio = require('cheerio-without-node-native');

const TMDB_API_KEY = process.env.TMDB_API_KEY || '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept-Encoding': '*'
};
const SOURCES = [
  {
    id: '1337x',
    baseUrl: 'https://1337xx.to'
  },
  {
    id: 'tpb',
    apiUrl: 'https://apibay.org'
  }
];

const client = axios.create({
  timeout: 10_000,
  headers: HEADERS,
  validateStatus: (status) => status >= 200 && status < 300
});
const fastClient = axios.create({
  timeout: 4_000,
  headers: HEADERS,
  validateStatus: (status) => status >= 200 && status < 300
});

const toInt = (value) => {
  const parsed = Number.parseInt(String(value || '').replaceAll(',', ''), 10);
  return Number.isInteger(parsed) ? parsed : 0;
};

const convertBytes = (num) => {
  let value = Number(num) || 0;
  const step = 1000;
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];

  for (const unit of units) {
    if (value < step) {
      return `${value.toFixed(1)} ${unit}`;
    }
    value /= step;
  }

  return `${value.toFixed(1)} PB`;
};

const getQuality = (name) => {
  const normalized = String(name || '');
  const match = normalized.match(/(2160|1440|1080|720|480|360)[pP]/);
  return match ? `${match[1]}p` : 'Torrent';
};

const sleep = (delayMs) => new Promise((resolve) => {
  const timer = setTimeout(resolve, delayMs);
  timer.unref?.();
});

const withRetries = async (task, delaysMs = [250, 750]) => {
  let lastError;

  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;

      if (attempt < delaysMs.length) {
        await sleep(delaysMs[attempt]);
      }
    }
  }

  throw lastError;
};

const buildSearchQuery = (mediaInfo, mediaType, season, episode) => {
  if (mediaType === 'tv' && season && episode) {
    return `${mediaInfo.title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  }

  if (mediaType === 'tv' && season) {
    return `${mediaInfo.title} Season ${season}`;
  }

  return `${mediaInfo.title} ${mediaInfo.year || ''}`.trim();
};

const getTmdbInfo = async (tmdbId, mediaType) => {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const response = await withRetries(() => client.get(`${TMDB_BASE_URL}/${endpoint}/${tmdbId}`, {
    params: {
      api_key: TMDB_API_KEY
    }
  }), [300, 900, 1800]);

  return {
    title: response.data.title || response.data.name || '',
    year: String(response.data.release_date || response.data.first_air_date || '').slice(0, 4) || null
  };
};

const search1337x = async (query) => {
  const response = await fastClient.get(`${SOURCES[0].baseUrl}/search/${encodeURIComponent(query)}/1/`);
  const $ = cheerio.load(response.data);
  const rows = [];

  $('tbody > tr').each((_, element) => {
    const anchors = $(element).find('td.coll-1 > a');
    const anchor = anchors.eq(1);
    const link = anchor.attr('href');

    if (!link) {
      return;
    }

    rows.push({
      name: anchor.text().trim(),
      seeders: toInt($(element).find('td.coll-2').text()),
      leechers: toInt($(element).find('td.coll-3').text()),
      size: `${$(element).find('td.coll-4').text().split('B')[0]}B`.trim(),
      detailsUrl: `${SOURCES[0].baseUrl}${link}`
    });
  });

  return rows;
};

const get1337xMagnet = async (detailsUrl) => {
  const response = await fastClient.get(detailsUrl);
  const $ = cheerio.load(response.data);
  const magnet = $('ul.dropdown-menu > li').last().find('a').attr('href') || null;
  return magnet;
};

const searchThePirateBay = async (query) => {
  const response = await client.get(`${SOURCES[1].apiUrl}/q.php`, {
    params: {
      q: query,
      cat: '100,200,300,400,600'
    }
  });

  if (!Array.isArray(response.data) || response.data[0]?.name === 'No results returned') {
    return [];
  }

  return response.data.map((torrent) => ({
    name: torrent.name,
    seeders: toInt(torrent.seeders),
    leechers: toInt(torrent.leechers),
    size: convertBytes(torrent.size),
    magnet: `magnet:?xt=urn:btih:${torrent.info_hash}&dn=${encodeURIComponent(torrent.name)}`,
    sourceSite: 'ThePirateBay'
  }));
};

const normalizeTorrent = (torrent, sourceSite) => ({
  name: `${sourceSite} Torrent`,
  title: torrent.name,
  quality: getQuality(torrent.name),
  size: torrent.size,
  provider: 'torrent-scraper',
  magnet: torrent.magnet,
  seeders: torrent.seeders,
  sourceSite
});

async function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  try {
    const mediaInfo = await getTmdbInfo(tmdbId, mediaType);
    const query = buildSearchQuery(mediaInfo, mediaType, season, episode);

    const torrentsTpb = await searchThePirateBay(query).catch(() => []);
    const shouldTry1337x = torrentsTpb.length < 3;
    const torrents1337x = shouldTry1337x
      ? await search1337x(query).catch(() => [])
      : [];

    const enriched1337x = [];

    for (const torrent of torrents1337x.slice(0, Math.max(0, 5 - torrentsTpb.length))) {
      try {
        const magnet = await get1337xMagnet(torrent.detailsUrl);

        if (!magnet) {
          continue;
        }

        enriched1337x.push({
          ...torrent,
          magnet,
          sourceSite: '1337x'
        });
      } catch {
        continue;
      }
    }

    const merged = [
      ...torrentsTpb.slice(0, 5).map((torrent) => normalizeTorrent(torrent, 'ThePirateBay')),
      ...enriched1337x.map((torrent) => normalizeTorrent(torrent, '1337x'))
    ].filter((torrent) => torrent.magnet);

    merged.sort((left, right) => {
      if (right.seeders !== left.seeders) {
        return right.seeders - left.seeders;
      }

      return left.title.localeCompare(right.title);
    });

    return merged;
  } catch {
    return [];
  }
}

module.exports = {
  getStreams
};
