/**
 * Einschalten - German streaming provider
 * Adapted from WebStreamrMBG reference implementation
 * Supports: German movies
 */

var EINSCHALTEN_BASE = 'https://einschalten.in';
var TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
var TMDB_BASE = 'https://api.themoviedb.org/3';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function getStreams(tmdbId, mediaType, season, episode) {
  if (mediaType === 'tv') {
    return Promise.resolve([]);
  }

  var apiUrl = EINSCHALTEN_BASE + '/api/movies/' + tmdbId + '/watch';

  return fetch(apiUrl, {
    headers: {
      'User-Agent': UA,
      'Referer': EINSCHALTEN_BASE + '/'
    }
  })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (data) {
      if (!data || !data.streamUrl) return [];

      var title = data.releaseName || 'Einschalten';
      var streamUrl = data.streamUrl;

      try {
        new URL(streamUrl);
      } catch (e) {
        return [];
      }

      var quality = 'Auto';
      if (streamUrl.includes('1080') || title.includes('1080')) quality = '1080p';
      else if (streamUrl.includes('720') || title.includes('720')) quality = '720p';
      else if (streamUrl.includes('2160') || title.includes('4K') || title.includes('2160')) quality = '4K';

      return [{
        name: 'Einschalten',
        title: title + ' [DE]',
        quality: quality,
        url: streamUrl,
        headers: {
          'Referer': EINSCHALTEN_BASE + '/movies/' + tmdbId,
          'User-Agent': UA
        }
      }];
    })
    .catch(function (err) {
      console.error('[Einschalten] Error:', err.message || err);
      return [];
    });
}

module.exports = { getStreams: getStreams };
