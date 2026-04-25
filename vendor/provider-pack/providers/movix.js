// =============================================================
// Provider Nuvio : Movix.rodeo (VF/VOSTFR français)
// Version : 4.0.0 - Triple API (purstream + cpasmal + fstream)
// =============================================================
 
var MOVIX_API = 'https://api.movix.blog';
var MOVIX_REFERER = 'https://movix.rodeo/';
var TELEGRAM_CHANNEL = 'https://t.me/s/movix_site';
 
function detectApiFromTelegram() {
  return fetch(TELEGRAM_CHANNEL, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  })
    .then(function(res) { return res.text(); })
    .then(function(html) {
      var matches = html.match(/https?:\/\/movix\.[a-z]+/gi);
      if (!matches) return null;
      var frontendDomains = matches.filter(function(url) {
        return !url.includes('t.me') && !url.includes('noel.') && !url.includes('telegram');
      });
      if (frontendDomains.length === 0) return null;
      var lastFrontend = frontendDomains[frontendDomains.length - 1];
      var tld = lastFrontend.replace(/https?:\/\/movix\./, '');
      return { api: 'https://api.movix.' + tld, referer: lastFrontend + '/' };
    })
    .catch(function() { return null; });
}
 
function resolveRedirect(url, referer) {
  return fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': referer || MOVIX_REFERER
    }
  }).then(function(res) { return res.url || url; })
    .catch(function() { return url; });
}
 
function resolveEmbed(embedUrl, referer) {
  return fetch(embedUrl, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': referer || MOVIX_REFERER
    }
  })
    .then(function(res) { return res.text(); })
    .then(function(html) {
      var patterns = [
        /file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i,
        /source\s+src=["']([^"']+\.m3u8[^"']*)["']/i,
        /["']([^"']*\.m3u8(?:\?[^"']*)?)["']/i,
        /file\s*:\s*["']([^"']+\.mp4[^"']*)["']/i
      ];
      for (var i = 0; i < patterns.length; i++) {
        var match = html.match(patterns[i]);
        if (match) {
          var url = match[1];
          if (url.startsWith('//')) url = 'https:' + url;
          if (url.startsWith('http')) return url;
        }
      }
      return null;
    })
    .catch(function() { return null; });
}
 
// API 1 : Purstream — m3u8 direct
function fetchPurstream(apiBase, referer, tmdbId, mediaType, season, episode) {
  var url = mediaType === 'tv'
    ? apiBase + '/api/purstream/tv/' + tmdbId + '/stream?season=' + (season || 1) + '&episode=' + (episode || 1)
    : apiBase + '/api/purstream/movie/' + tmdbId + '/stream';
 
  console.log('[Movix] Purstream: ' + url);
  return fetch(url, {
    method: 'GET',
    headers: { 'Referer': referer, 'Origin': referer.replace(/\/$/, ''), 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  })
    .then(function(res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
    .then(function(data) {
      if (!data || !data.sources || data.sources.length === 0) throw new Error('Vide');
      return data.sources;
    });
}
 
// API 2 : Cpasmal — voe, netu, doodstream, vidoza (VF/VOSTFR)
function fetchCpasmal(apiBase, referer, tmdbId, mediaType, season, episode) {
  var url = mediaType === 'tv'
    ? apiBase + '/api/cpasmal/tv/' + tmdbId + '/' + (season || 1) + '/' + (episode || 1)
    : apiBase + '/api/cpasmal/movie/' + tmdbId;
 
  console.log('[Movix] Cpasmal: ' + url);
  return fetch(url, {
    method: 'GET',
    headers: { 'Referer': referer, 'Origin': referer.replace(/\/$/, ''), 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  })
    .then(function(res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
    .then(function(data) {
      if (!data || !data.links) throw new Error('Vide');
      var sources = [];
      var langs = ['vf', 'vostfr'];
      langs.forEach(function(lang) {
        if (data.links[lang]) {
          data.links[lang].forEach(function(link) {
            sources.push({
              url: link.url,
              name: 'Movix ' + lang.toUpperCase(),
              player: link.server,
              lang: lang
            });
          });
        }
      });
      if (sources.length === 0) throw new Error('Aucune source');
      return sources;
    });
}
 
// API 3 : FStream — vidzy, fsvid, uqload (VF/VOSTFR)
function fetchFstream(apiBase, referer, tmdbId, mediaType, season, episode) {
  var url = mediaType === 'tv'
    ? apiBase + '/api/fstream/tv/' + tmdbId + '/season/' + (season || 1)
    : apiBase + '/api/fstream/movie/' + tmdbId;
 
  console.log('[Movix] FStream: ' + url);
  return fetch(url, {
    method: 'GET',
    headers: { 'Referer': referer, 'Origin': referer.replace(/\/$/, ''), 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  })
    .then(function(res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
    .then(function(data) {
      if (!data || !data.episodes) throw new Error('Vide');
      var ep = String(episode || 1);
      var episodeData = data.episodes[ep];
      if (!episodeData) throw new Error('Épisode non trouvé');
      var sources = [];
      ['VF', 'VOSTFR'].forEach(function(lang) {
        if (episodeData.languages[lang]) {
          episodeData.languages[lang].forEach(function(source) {
            sources.push({ url: source.url, name: 'Movix FStream ' + lang, player: source.player, lang: lang });
          });
        }
      });
      if (sources.length === 0) throw new Error('Aucune source');
      return sources;
    });
}
 
// Domaines qu'on ne peut pas résoudre (nécessitent cookies/JS)
var UNSUPPORTED_PLAYERS = ['netu', 'voe', 'uqload', 'doodstream', 'vidoza', 'younetu', 'bysebuho', 'kakaflix', 'ralphy'];
 
function processEmbedSources(sources, referer) {
  // Filtrer d'abord les players non supportés
  var supportedSources = sources.filter(function(source) {
    var urlLower = source.url.toLowerCase();
    return !UNSUPPORTED_PLAYERS.some(function(player) {
      return urlLower.indexOf(player) !== -1;
    });
  });
 
  if (supportedSources.length === 0) return Promise.resolve([]);
 
  return Promise.all(supportedSources.slice(0, 8).map(function(source) {
    return resolveEmbed(source.url, referer).then(function(directUrl) {
      // On vérifie que l'URL résolue est bien un stream direct
      if (!directUrl || (!directUrl.match(/\.m3u8/i) && !directUrl.match(/\.mp4/i))) return null;
      return {
        name: 'Movix',
        title: source.name + ' - ' + source.player,
        url: directUrl,
        quality: 'HD',
        format: directUrl.match(/\.mp4/i) ? 'mp4' : 'm3u8',
        headers: {
          'Referer': referer,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      };
    });
  })).then(function(results) {
    return results.filter(function(r) { return r !== null; });
  });
}
 
function getStreams(tmdbId, mediaType, season, episode) {
  console.log('[Movix] Fetching tmdbId=' + tmdbId + ' type=' + mediaType + ' S' + season + 'E' + episode);
 
  var apiBase = MOVIX_API;
  var referer = MOVIX_REFERER;
 
  // Étape 1 : Purstream (m3u8 direct)
  return fetchPurstream(apiBase, referer, tmdbId, mediaType, season, episode)
    .then(function(sources) {
      return Promise.all(sources.map(function(source) {
        return resolveRedirect(source.url, referer).then(function(resolvedUrl) {
          return {
            name: 'Movix',
            title: source.name || 'Movix VF',
            url: resolvedUrl,
            quality: source.name && source.name.indexOf('1080') !== -1 ? '1080p' : '720p',
            format: source.format || 'm3u8',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          };
        });
      }));
    })
    .catch(function() {
      // Étape 2 : Cpasmal + FStream en parallèle
      console.log('[Movix] Purstream vide, tentative Cpasmal + FStream...');
      return Promise.all([
        fetchCpasmal(apiBase, referer, tmdbId, mediaType, season, episode).catch(function() { return []; }),
        fetchFstream(apiBase, referer, tmdbId, mediaType, season, episode).catch(function() { return []; })
      ]).then(function(results) {
        var allSources = results[0].concat(results[1]);
        if (allSources.length === 0) throw new Error('Aucune source');
        return processEmbedSources(allSources, referer);
      });
    })
    .catch(function() {
      // Étape 3 : Telegram fallback
      console.log('[Movix] Tentative Telegram...');
      return detectApiFromTelegram().then(function(detected) {
        if (!detected) return [];
        return Promise.all([
          fetchPurstream(detected.api, detected.referer, tmdbId, mediaType, season, episode).catch(function() { return null; }),
          fetchCpasmal(detected.api, detected.referer, tmdbId, mediaType, season, episode).catch(function() { return []; }),
          fetchFstream(detected.api, detected.referer, tmdbId, mediaType, season, episode).catch(function() { return []; })
        ]).then(function(results) {
          if (results[0]) {
            return Promise.all(results[0].map(function(source) {
              return resolveRedirect(source.url, detected.referer).then(function(resolvedUrl) {
                return { name: 'Movix', title: source.name || 'Movix VF', url: resolvedUrl, quality: '720p', format: 'm3u8', headers: { 'User-Agent': 'Mozilla/5.0' } };
              });
            }));
          }
          var allSources = results[1].concat(results[2]);
          return processEmbedSources(allSources, detected.referer);
        });
      }).catch(function() { return []; });
    })
    .catch(function(err) {
      console.error('[Movix] Erreur globale:', err.message || err);
      return [];
    });
}
 
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}
