/**
 * Filmpalast - German streaming provider (filmpalast.to)
 * Adapted from WebStreamrMBG reference implementation
 * Supports: German movies and series
 */

var cheerio;
try {
  cheerio = require('cheerio-without-node-native');
} catch (e) {
  try {
    cheerio = require('cheerio');
  } catch (e2) {
    cheerio = null;
  }
}

var FILMPALAST_BASE = 'https://filmpalast.to';
var TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
var TMDB_BASE = 'https://api.themoviedb.org/3';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

var STREAMING_HOSTS = [
  'voe', 'dood', 'streamtape', 'veev', 'vinovo', 'vidhide',
  'mixdrop', 'supervideo', 'uqload', 'filelion', 'lulustream',
  'fastream', 'dropload', 'savefiles', 'streamembed', 'vidara', 'vidsonic'
];

function isStreamingHost(hostname) {
  var h = (hostname || '').toLowerCase();
  for (var i = 0; i < STREAMING_HOSTS.length; i++) {
    if (h.includes(STREAMING_HOSTS[i])) return true;
  }
  return false;
}

function resolveHref(href, baseUrl) {
  var fullHref = href.startsWith('//') ? 'https:' + href : href;
  if (fullHref.startsWith('http')) return fullHref;
  return baseUrl + fullHref;
}

function getTmdbGermanTitle(tmdbId, mediaType) {
  var endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  var url = TMDB_BASE + '/' + endpoint + '/' + tmdbId + '?api_key=' + TMDB_API_KEY + '&language=de';

  return fetch(url, { headers: { 'User-Agent': UA } })
    .then(function (res) {
      if (!res.ok) return null;
      return res.json();
    })
    .then(function (data) {
      if (!data) return null;
      return {
        name: data.title || data.name || '',
        year: parseInt((data.release_date || data.first_air_date || '').slice(0, 4), 10) || 0
      };
    })
    .catch(function () {
      return null;
    });
}

function searchFilmpalast(query) {
  var searchUrl = FILMPALAST_BASE + '/search/title/' + encodeURIComponent(query);

  return fetch(searchUrl, {
    headers: {
      'User-Agent': UA,
      'Referer': FILMPALAST_BASE + '/'
    }
  })
    .then(function (res) {
      if (!res.ok) return null;
      return res.text();
    })
    .then(function (html) {
      if (!html || !cheerio) return null;

      var $ = cheerio.load(html);
      var links = [];

      $('a[href*="/stream/"]').each(function () {
        var href = $(this).attr('href');
        var title = $(this).attr('title') || $(this).text().trim();
        if (href) {
          links.push({ href: href, title: title });
        }
      });

      return links.length > 0 ? links : null;
    })
    .catch(function () {
      return null;
    });
}

function extractStreamsFromPage(pageUrl) {
  return fetch(pageUrl, {
    headers: {
      'User-Agent': UA,
      'Referer': FILMPALAST_BASE + '/'
    }
  })
    .then(function (res) {
      if (!res.ok) return [];
      return res.text();
    })
    .then(function (html) {
      if (!html || !cheerio) return [];

      var $ = cheerio.load(html);
      var streams = [];

      $('ul.currentStreamLinks').each(function () {
        var hostName = $(this).find('.hostName').text().trim();

        $(this).find('a[data-player-url]').each(function () {
          var playerUrl = $(this).attr('data-player-url');
          if (playerUrl && playerUrl.startsWith('http')) {
            streams.push({
              name: 'Filmpalast',
              title: hostName + ' [DE]',
              quality: 'Auto',
              url: playerUrl,
              headers: {
                'Referer': pageUrl,
                'User-Agent': UA
              }
            });
          }
        });

        $(this).find('a[href]').each(function () {
          var href = $(this).attr('href');
          if (!href || href === '#' || href.startsWith('javascript') || href.includes('filmpalast.to')) return;
          if ($(this).attr('data-player-url')) return;

          try {
            var url = resolveHref(href, FILMPALAST_BASE);
            var parsed = new URL(url);
            if (isStreamingHost(parsed.hostname)) {
              streams.push({
                name: 'Filmpalast',
                title: hostName + ' [DE]',
                quality: 'Auto',
                url: url,
                headers: {
                  'Referer': pageUrl,
                  'User-Agent': UA
                }
              });
            }
          } catch (e) {
            // skip invalid URLs
          }
        });
      });

      return streams;
    })
    .catch(function () {
      return [];
    });
}

function getStreams(tmdbId, mediaType, season, episode) {
  if (!cheerio) {
    console.warn('[Filmpalast] cheerio not available, skipping');
    return Promise.resolve([]);
  }

  return getTmdbGermanTitle(tmdbId, mediaType)
    .then(function (meta) {
      if (!meta || !meta.name) return [];

      var query;
      if (mediaType === 'tv' && season) {
        var s = String(season).padStart(2, '0');
        var e = String(episode || 1).padStart(2, '0');
        query = meta.name + ' S' + s + 'E' + e;
      } else {
        query = meta.name;
      }

      return searchFilmpalast(query)
        .then(function (links) {
          if (!links || links.length === 0) return [];

          var bestLink = links[0];

          if (mediaType !== 'tv' && meta.year) {
            for (var i = 0; i < links.length; i++) {
              if (links[i].title.includes(String(meta.year))) {
                bestLink = links[i];
                break;
              }
            }
          }

          var pageUrl = bestLink.href.startsWith('http')
            ? bestLink.href
            : FILMPALAST_BASE + bestLink.href;

          return extractStreamsFromPage(pageUrl);
        });
    })
    .catch(function (err) {
      console.error('[Filmpalast] Error:', err.message || err);
      return [];
    });
}

module.exports = { getStreams: getStreams };
