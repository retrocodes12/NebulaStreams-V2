const TMDB_API_KEY = 'd131017ccc6e5462a81c9304d21476de';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const DECRYPT_API_URL = 'https://enc-dec.app/api/dec-videasy';

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Connection: 'keep-alive'
};

const REQUEST_TIMEOUT_MS = 8000;
const REQUEST_RETRIES = 3;

const PLAYBACK_HEADERS = {
  'User-Agent': REQUEST_HEADERS['User-Agent'],
  Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.fmovies.gd/',
  Origin: 'https://www.fmovies.gd',
  'Sec-Fetch-Dest': 'video',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'cross-site'
};

const SERVERS = [
  {
    name: 'Yoru',
    language: 'Original',
    url: 'https://api.videasy.net/cdn/sources-with-title'
  },
  {
    name: 'Vyse',
    language: 'Hindi',
    url: 'https://api.videasy.net/hdmovie/sources-with-title'
  }
];

function delay(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

function shouldRetryRequest(error, status) {
  if (status === 429 || status >= 500) {
    return true;
  }

  if (!error) {
    return false;
  }

  var message = String(error.message || error);
  return /fetch failed|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|Connection reset/i.test(message);
}

function requestWithRetry(url, options, parser) {
  var attempt = 0;

  function run() {
    var controller = new AbortController();
    var timeoutId = setTimeout(function() {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    return fetch(url, Object.assign({}, options, { signal: controller.signal }))
      .then(function(response) {
        clearTimeout(timeoutId);

        if (!response.ok) {
          if (attempt + 1 < REQUEST_RETRIES && shouldRetryRequest(null, response.status)) {
            attempt += 1;
            return delay(250 * attempt).then(run);
          }
          throw new Error('HTTP ' + response.status + ' for ' + url);
        }

        return parser(response);
      })
      .catch(function(error) {
        clearTimeout(timeoutId);
        if (attempt + 1 < REQUEST_RETRIES && shouldRetryRequest(error, 0)) {
          attempt += 1;
          return delay(250 * attempt).then(run);
        }
        throw error;
      });
  }

  return run();
}

function getJson(url) {
  return requestWithRetry(url, { headers: REQUEST_HEADERS }, function(response) {
    return response.json();
  });
}

function getText(url) {
  return requestWithRetry(url, { headers: REQUEST_HEADERS }, function(response) {
    return response.text();
  });
}

function postJson(url, payload) {
  return requestWithRetry(url, {
    method: 'POST',
    headers: Object.assign({}, REQUEST_HEADERS, {
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify(payload)
  }, function(response) {
    return response.json();
  });
}

function fetchMediaDetails(tmdbId, mediaType) {
  var normalizedType = mediaType === 'tv' || mediaType === 'series' ? 'tv' : 'movie';
  var url = TMDB_BASE_URL + '/' + normalizedType + '/' + tmdbId + '?api_key=' + TMDB_API_KEY + '&append_to_response=external_ids';

  return getJson(url).then(function(data) {
    return {
      tmdbId: String(data.id || tmdbId),
      mediaType: normalizedType,
      title: normalizedType === 'tv' ? data.name : data.title,
      year: normalizedType === 'tv'
        ? String(data.first_air_date || '').slice(0, 4)
        : String(data.release_date || '').slice(0, 4),
      imdbId: data.external_ids && data.external_ids.imdb_id ? data.external_ids.imdb_id : ''
    };
  });
}

function buildServerUrl(server, media, season, episode) {
  var params = new URLSearchParams();
  params.set('title', encodeURIComponent(encodeURIComponent(media.title).replace(/\+/g, '%20')));
  params.set('mediaType', media.mediaType);
  params.set('year', media.year || '');
  params.set('tmdbId', media.tmdbId);
  params.set('imdbId', media.imdbId || '');

  if (media.mediaType === 'tv') {
    params.set('seasonId', String(season || 1));
    params.set('episodeId', String(episode || 1));
  }

  return server.url + '?' + params.toString();
}

function decryptPayload(encryptedText, tmdbId) {
  return postJson(DECRYPT_API_URL, { text: encryptedText, id: String(tmdbId) }).then(function(response) {
    return response.result || {};
  });
}

function normalizeQuality(value) {
  var raw = String(value || '').trim();
  var upper;

  if (!raw) {
    return 'Adaptive';
  }

  upper = raw.toUpperCase();
  if (/^\d{3,4}P$/.test(upper)) {
    return upper;
  }
  if (/^\d{3,4}p$/.test(raw)) {
    return raw;
  }
  if (/hindi/i.test(raw)) {
    return 'Adaptive';
  }
  return raw;
}

function createStream(source, server, media) {
  var quality = normalizeQuality(source.quality);
  var title = media.year ? media.title + ' (' + media.year + ')' : media.title;

  return {
    name: 'Fmovies ' + server.name + ' (' + server.language + ') - ' + quality,
    title: title,
    url: source.url,
    quality: quality,
    headers: PLAYBACK_HEADERS,
    provider: 'fmovies',
    language: server.language
  };
}

function fetchFromServer(server, media, season, episode) {
  return getText(buildServerUrl(server, media, season, episode))
    .then(function(encryptedText) {
      if (!encryptedText || !encryptedText.trim()) {
        return [];
      }
      return decryptPayload(encryptedText, media.tmdbId);
    })
    .then(function(payload) {
      var sources = Array.isArray(payload && payload.sources) ? payload.sources : [];
      return sources
        .filter(function(source) {
          return source && typeof source.url === 'string' && source.url.includes('workers.dev');
        })
        .map(function(source) {
          return createStream(source, server, media);
        });
    })
    .catch(function() {
      return [];
    });
}

function dedupeStreams(streams) {
  var seen = new Set();

  return streams.filter(function(stream) {
    if (seen.has(stream.url)) {
      return false;
    }
    seen.add(stream.url);
    return true;
  });
}

function flattenResults(results) {
  return results.reduce(function(all, item) {
    return all.concat(item || []);
  }, []);
}

function sortStreams(streams) {
  function rank(quality) {
    var match = String(quality || '').match(/(\d{3,4})/);
    if (match) {
      return parseInt(match[1], 10);
    }
    if (/adaptive/i.test(String(quality || ''))) {
      return 9999;
    }
    return 0;
  }

  return streams.slice().sort(function(left, right) {
    return rank(right.quality) - rank(left.quality);
  });
}

function getStreams(tmdbIdOrMedia, mediaType, season, episode) {
  var tmdbId;
  var type;
  var normalizedSeason;
  var normalizedEpisode;

  mediaType = mediaType || 'movie';
  season = season == null ? null : season;
  episode = episode == null ? null : episode;

  try {
    if (typeof tmdbIdOrMedia === 'object' && tmdbIdOrMedia !== null) {
      tmdbId = tmdbIdOrMedia.tmdb_id || tmdbIdOrMedia.tmdbId;
      type = tmdbIdOrMedia.type || tmdbIdOrMedia.mediaType || 'movie';
      season = tmdbIdOrMedia.season;
      episode = tmdbIdOrMedia.episode;
    } else {
      tmdbId = tmdbIdOrMedia;
      type = mediaType;
    }

    type = type === 'series' ? 'tv' : type;
    normalizedSeason = season == null ? null : parseInt(season, 10);
    normalizedEpisode = episode == null ? null : parseInt(episode, 10);

    return fetchMediaDetails(tmdbId, type)
      .then(function(media) {
        return Promise.all(SERVERS.map(function(server) {
          return fetchFromServer(server, media, normalizedSeason, normalizedEpisode);
        }));
      })
      .then(function(results) {
        return sortStreams(dedupeStreams(flattenResults(results)));
      })
      .catch(function() {
        return [];
      });
  } catch (_error) {
    return Promise.resolve([]);
  }
}

module.exports = { getStreams };
