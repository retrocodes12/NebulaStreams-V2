/**
 * Frembed - French streaming provider (VF/VOSTFR)
 * Adapted from WebStreamrMBG reference implementation
 */

var FREMBED_BASE = 'https://frembed.cyou';
var TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
var TMDB_BASE = 'https://api.themoviedb.org/3';

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
var _resolvedBase = null;
var _resolvedBaseExpiry = 0;

function resolveBaseUrl() {
  var now = Date.now();
  if (_resolvedBase && _resolvedBaseExpiry > now) {
    return Promise.resolve(_resolvedBase);
  }

  return fetch(FREMBED_BASE, {
    redirect: 'follow',
    headers: { 'User-Agent': UA }
  })
    .then(function (res) {
      var finalUrl = res.url || FREMBED_BASE;
      var parsed = new URL(finalUrl);
      var base = parsed.origin;
      _resolvedBase = base;
      _resolvedBaseExpiry = Date.now() + 3600000;
      return base;
    })
    .catch(function () {
      return FREMBED_BASE;
    });
}

function getTmdbTitle(tmdbId, mediaType) {
  var endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  var url = TMDB_BASE + '/' + endpoint + '/' + tmdbId + '?api_key=' + TMDB_API_KEY + '&language=fr';

  return fetch(url, { headers: { 'User-Agent': UA } })
    .then(function (res) {
      if (!res.ok) return null;
      return res.json();
    })
    .then(function (data) {
      if (!data) return null;
      return {
        title: data.title || data.name || '',
        year: (data.release_date || data.first_air_date || '').slice(0, 4)
      };
    })
    .catch(function () {
      return null;
    });
}

function getStreams(tmdbId, mediaType, season, episode) {
  return resolveBaseUrl()
    .then(function (baseUrl) {
      var apiUrl;
      if (mediaType === 'tv' && season) {
        apiUrl = baseUrl + '/api/series?id=' + tmdbId + '&sa=' + season + '&epi=' + (episode || 1) + '&idType=tmdb';
      } else {
        apiUrl = baseUrl + '/api/films?id=' + tmdbId + '&idType=tmdb';
      }

      return fetch(apiUrl, {
        headers: {
          'User-Agent': UA,
          'Referer': baseUrl + '/'
        }
      })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (data) {
          if (!data || typeof data !== 'object') return [];

          var streams = [];
          var title = data.title || 'Frembed';
          var keys = Object.keys(data);

          for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            if (key.startsWith('link') && data[key] && typeof data[key] === 'string') {
              var linkUrl = data[key].trim();
              if (!linkUrl || linkUrl.includes(',https')) continue;

              try {
                new URL(linkUrl);
              } catch (e) {
                continue;
              }

              var quality = 'Auto';
              if (linkUrl.includes('1080')) quality = '1080p';
              else if (linkUrl.includes('720')) quality = '720p';
              else if (linkUrl.includes('4k') || linkUrl.includes('2160')) quality = '4K';

              streams.push({
                name: 'Frembed',
                title: title + ' [FR] - ' + key.replace('link', 'Server '),
                quality: quality,
                url: linkUrl,
                headers: {
                  'Referer': baseUrl + '/',
                  'User-Agent': UA
                }
              });
            }
          }

          return streams;
        });
    })
    .catch(function (err) {
      console.error('[Frembed] Error:', err.message || err);
      return [];
    });
}

module.exports = { getStreams: getStreams };
