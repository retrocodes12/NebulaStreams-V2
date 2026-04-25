const TMDB_API_KEY = 'd131017ccc6e5462a81c9304d21476de';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const EMBED_DOMAINS = ['https://vidsrc-embed.ru', 'https://vsembed.ru', 'https://vidsrc-embed.su'];
const REQUEST_TIMEOUT_MS = 10000;
const REQUEST_RETRIES = 3;
const FLARESOLVERR_ENDPOINT = String(process.env.FLARESOLVERR_ENDPOINT || '').trim().replace(/\/+$/, '');
const FLARESOLVERR_TIMEOUT_MS = Math.max(parseInt(process.env.FLARESOLVERR_TIMEOUT_MS || '', 10) || 45000, REQUEST_TIMEOUT_MS);
const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Connection: 'keep-alive'
};
const PLAYBACK_HOST_REPLACEMENT = 'cloudnestra.com';

function delay(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

function randomIpAddress() {
  return [
    Math.floor(Math.random() * 223) + 1,
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256)
  ].join('.');
}

function buildProxyHeaders(url, ipAddress) {
  if (!ipAddress) {
    return {};
  }

  var host = '';
  var proto = 'https';

  try {
    var parsed = new URL(url);
    host = parsed.host;
    proto = parsed.protocol.replace(/:$/, '') || 'https';
  } catch (_error) {}

  return {
    Forwarded: 'by=unknown;for=' + ipAddress + ';host=' + host + ';proto=' + proto,
    'X-Forwarded-For': ipAddress,
    'X-Forwarded-Host': host,
    'X-Forwarded-Proto': proto,
    'X-Real-IP': ipAddress
  };
}

function parseRetryDelayMs(headers, attempt) {
  var retryAfter = headers && typeof headers.get === 'function' ? headers.get('retry-after') : '';
  var seconds = parseInt(retryAfter, 10);

  if (!Number.isNaN(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, 5000);
  }

  return 300 * attempt;
}

function shouldRetryRequest(error, status) {
  if (status === 429 || status >= 500) {
    return true;
  }

  if (!error) {
    return false;
  }

  return /fetch failed|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|Connection reset|aborted/i
    .test(String(error.message || error));
}

function request(url, options, parser) {
  var attempt = 0;

  function run() {
    var controller = new AbortController();
    var timeoutId = setTimeout(function() {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    var requestOptions = Object.assign({}, options || {});
    requestOptions.signal = controller.signal;
    requestOptions.headers = Object.assign({}, REQUEST_HEADERS, requestOptions.headers || {});

    return fetch(url, requestOptions)
      .then(function(response) {
        clearTimeout(timeoutId);

        if (!response.ok) {
          if (attempt + 1 < REQUEST_RETRIES && shouldRetryRequest(null, response.status)) {
            attempt += 1;
            return delay(parseRetryDelayMs(response.headers, attempt)).then(run);
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

function getJson(url, options) {
  return request(url, options, function(response) {
    return response.json();
  });
}

function getText(url, options) {
  return request(url, options, function(response) {
    return response.text();
  });
}

function hasCloudflareTurnstile(html) {
  return /cf-turnstile|challenges\.cloudflare\.com\/turnstile/i.test(String(html || ''));
}

function normalizeFlareSolverrEndpoint(endpoint) {
  if (!endpoint) {
    return '';
  }

  return endpoint.endsWith('/v1') ? endpoint : endpoint + '/v1';
}

function requestViaFlareSolverr(url, options) {
  var endpoint = normalizeFlareSolverrEndpoint(FLARESOLVERR_ENDPOINT);

  if (!endpoint) {
    return Promise.resolve('');
  }

  var requestHeaders = Object.assign({}, REQUEST_HEADERS, options && options.headers ? options.headers : {});
  var payload = {
    cmd: 'request.get',
    url: url,
    maxTimeout: FLARESOLVERR_TIMEOUT_MS,
    headers: requestHeaders
  };

  if (options && options.session) {
    payload.session = options.session;
  }

  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })
    .then(function(response) {
      if (!response.ok) {
        throw new Error('FlareSolverr HTTP ' + response.status);
      }

      return response.json();
    })
    .then(function(result) {
      if (!result || result.status !== 'ok' || !result.solution || typeof result.solution.response !== 'string') {
        throw new Error('Invalid FlareSolverr response');
      }

      return result.solution.response;
    });
}

function createFlareSolverrSession() {
  var endpoint = normalizeFlareSolverrEndpoint(FLARESOLVERR_ENDPOINT);

  if (!endpoint) {
    return Promise.resolve('');
  }

  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ cmd: 'sessions.create' })
  })
    .then(function(response) {
      if (!response.ok) {
        throw new Error('FlareSolverr session HTTP ' + response.status);
      }

      return response.json();
    })
    .then(function(result) {
      return result && result.session ? String(result.session) : '';
    })
    .catch(function() {
      return '';
    });
}

function destroyFlareSolverrSession(session) {
  var endpoint = normalizeFlareSolverrEndpoint(FLARESOLVERR_ENDPOINT);

  if (!endpoint || !session) {
    return Promise.resolve();
  }

  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      cmd: 'sessions.destroy',
      session: session
    })
  }).catch(function() {
    return null;
  });
}

function fetchMediaDetails(tmdbId, mediaType) {
  var normalizedType = mediaType === 'tv' || mediaType === 'series' ? 'tv' : 'movie';
  var url = TMDB_BASE_URL + '/' + normalizedType + '/' + tmdbId + '?api_key=' + TMDB_API_KEY + '&append_to_response=external_ids';

  return getJson(url).then(function(data) {
    var imdbId = '';

    if (normalizedType === 'tv' && data.external_ids && data.external_ids.imdb_id) {
      imdbId = data.external_ids.imdb_id;
    } else if (data.imdb_id) {
      imdbId = data.imdb_id;
    } else if (data.external_ids && data.external_ids.imdb_id) {
      imdbId = data.external_ids.imdb_id;
    }

    if (!imdbId) {
      throw new Error('Missing IMDb id for TMDB ' + tmdbId);
    }

    return {
      tmdbId: String(data.id || tmdbId),
      imdbId: imdbId,
      mediaType: normalizedType,
      title: normalizedType === 'tv' ? data.name : data.title,
      year: normalizedType === 'tv'
        ? String(data.first_air_date || '').slice(0, 4)
        : String(data.release_date || '').slice(0, 4)
    };
  });
}

function buildEmbedUrl(baseUrl, media, season, episode) {
  if (media.mediaType === 'tv') {
    return baseUrl + '/embed/tv/' + media.imdbId + '/' + (season || 1) + '-' + (episode || 1);
  }

  return baseUrl + '/embed/movie/' + media.imdbId;
}

function stripHtmlComments(html) {
  return String(html || '').replace(/<!--/g, '').replace(/-->/g, '');
}

function extractIframeUrl(html) {
  var match = stripHtmlComments(html).match(/id=["']player_iframe["'][^>]+src=["']([^"']+)["']/i);

  if (!match || !match[1]) {
    return '';
  }

  return match[1].replace(/^\/\//, 'https://');
}

function extractCloudStreamHash(html) {
  var match = stripHtmlComments(html).match(/class=["']server["'][^>]+data-hash=["']([^"']+)["'][^>]*>\s*CloudStream Pro\s*</i)
    || stripHtmlComments(html).match(/data-hash=["']([^"']+)["'][^>]*>\s*CloudStream Pro\s*</i);

  return match ? match[1] : '';
}

function extractPlayerPath(html) {
  var match = String(html || '').match(/src:\s*'([^']+)'/i)
    || String(html || '').match(/src:\s*"([^"]+)"/i);

  return match ? match[1] : '';
}

function extractTitle(html) {
  var match = String(html || '').match(/<title>([^<]+)<\/title>/i);
  return match ? match[1].trim() : 'VidSrc';
}

function extractFileBundle(html) {
  var match = String(html || '').match(/file:\s*"([\s\S]*?)"\s*,\s*cuid:/i);
  return match ? match[1].trim() : '';
}

function resolveCandidateUrls(fileBundle) {
  var unique = new Set();

  String(fileBundle || '')
    .split(/\s+or\s+/i)
    .map(function(url) {
      return String(url || '').trim();
    })
    .filter(function(url) {
      return url.startsWith('https://') && url.includes('/master.m3u8');
    })
    .forEach(function(url) {
      unique.add(url.replace(/\{v\d\}/g, PLAYBACK_HOST_REPLACEMENT));
    });

  return Array.from(unique);
}

function parseMaxHeight(playlistText) {
  var match;
  var maxHeight = 0;
  var regex = /RESOLUTION=\d+x(\d+)/gi;

  while ((match = regex.exec(String(playlistText || ''))) !== null) {
    maxHeight = Math.max(maxHeight, parseInt(match[1], 10) || 0);
  }

  return maxHeight || null;
}

function qualityFromHeight(height) {
  if (!height) {
    return 'Auto';
  }

  if (height >= 2160) {
    return '4K';
  }

  return height + 'p';
}

function validatePlaylist(url, referer) {
  return getText(url, {
    headers: {
      Referer: referer,
      Origin: 'https://cloudnestra.com',
      Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*'
    }
  }).then(function(playlistText) {
    if (!String(playlistText || '').includes('#EXTM3U')) {
      throw new Error('Invalid HLS playlist');
    }

    return {
      url: url,
      height: parseMaxHeight(playlistText)
    };
  });
}

function buildStreams(validatedPlaylists, title, playbackReferer) {
  return validatedPlaylists.map(function(item, index) {
    var quality = qualityFromHeight(item.height);
    var titleLine = item.height
      ? title + '\nVidSrc ' + quality
      : title + '\nVidSrc Auto';

    return {
      name: 'VidSrc' + (validatedPlaylists.length > 1 ? ' Server ' + (index + 1) : ''),
      title: titleLine,
      url: item.url,
      quality: quality,
      headers: {
        Referer: playbackReferer,
        Origin: 'https://cloudnestra.com',
        'User-Agent': REQUEST_HEADERS['User-Agent']
      },
      provider: 'vidsrc'
    };
  });
}

function fetchEmbedHtml(media, season, episode) {
  var domains = EMBED_DOMAINS.slice();

  function tryDomain() {
    var domainIndex = Math.floor(Math.random() * domains.length);
    var baseUrl = domains.splice(domainIndex, 1)[0];
    var embedUrl = buildEmbedUrl(baseUrl, media, season, episode);

    return getText(embedUrl)
      .then(function(html) {
        if (!extractIframeUrl(html) || !extractCloudStreamHash(html)) {
          throw new Error('Missing player iframe or CloudStream server');
        }

        return {
          embedUrl: embedUrl,
          html: html
        };
      })
      .catch(function(error) {
        if (domains.length) {
          return tryDomain();
        }
        throw error;
      });
  }

  return tryDomain();
}

function getRcpHtml(rcpUrl, embedUrl, ipAddress, flareSolverrSession) {
  var requestHeaders = Object.assign({
    Referer: new URL(embedUrl).origin
  }, buildProxyHeaders(rcpUrl, ipAddress));

  return getText(rcpUrl, {
    headers: requestHeaders
  }).then(function(rcpHtml) {
    if (extractPlayerPath(rcpHtml) || !hasCloudflareTurnstile(rcpHtml) || !FLARESOLVERR_ENDPOINT) {
      return rcpHtml;
    }

    return requestViaFlareSolverr(rcpUrl, {
      headers: requestHeaders,
      session: flareSolverrSession
    }).then(function(solvedHtml) {
      return solvedHtml || rcpHtml;
    }).catch(function(error) {
      console.warn('[VidSrc] FlareSolverr failed for RCP:', error && error.message ? error.message : error);
      return rcpHtml;
    });
  }).catch(function(error) {
    if (!FLARESOLVERR_ENDPOINT) {
      throw error;
    }

    return requestViaFlareSolverr(rcpUrl, {
      headers: requestHeaders,
      session: flareSolverrSession
    });
  });
}

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  return fetchMediaDetails(tmdbId, mediaType || 'movie')
    .then(function(media) {
      var ipAddress = randomIpAddress();

      return Promise.resolve(FLARESOLVERR_ENDPOINT ? createFlareSolverrSession() : '')
        .then(function(flareSolverrSession) {
          return fetchEmbedHtml(media, seasonNum, episodeNum).then(function(embedResult) {
        var iframeUrl = new URL(extractIframeUrl(embedResult.html));
        var hash = extractCloudStreamHash(embedResult.html);
        var rcpUrl = new URL('/rcp/' + hash, iframeUrl.origin).toString();

        return getRcpHtml(rcpUrl, embedResult.embedUrl, ipAddress, flareSolverrSession).then(function(rcpHtml) {
          var playerPath = extractPlayerPath(rcpHtml);

          if (!playerPath) {
            return [];
          }

          var playerUrl = new URL(playerPath, iframeUrl.origin).toString();
          var playerHeaders = Object.assign({
            Referer: rcpUrl
          }, buildProxyHeaders(playerUrl, ipAddress));

          return getText(playerUrl, {
            headers: playerHeaders
          }).then(function(playerHtml) {
            var fileBundle = extractFileBundle(playerHtml);
            var candidateUrls = resolveCandidateUrls(fileBundle);

            if (!candidateUrls.length) {
              return [];
            }

            return Promise.all(candidateUrls.map(function(url) {
              return validatePlaylist(url, playerUrl).catch(function() {
                return null;
              });
            })).then(function(validated) {
              var playlists = validated.filter(Boolean);

              if (!playlists.length) {
                return [];
              }

              return buildStreams(playlists, extractTitle(embedResult.html), playerUrl);
            });
          });
        });
          }).finally(function() {
            return destroyFlareSolverrSession(flareSolverrSession);
          });
        });
    })
    .catch(function(error) {
      console.error('[VidSrc] Error:', error && error.message ? error.message : error);
      return [];
    });
}

module.exports = { getStreams: getStreams };
