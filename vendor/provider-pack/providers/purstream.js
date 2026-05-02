// =============================================================
// Provider Nuvio : Purstream.art (VF/VOSTFR/MULTI français)
// Version : 3.4.0
// Fix : vérification année de sortie pour éviter les homonymes
// Domaine récupéré depuis domains.json (GitHub)
// Fallback : purstream.wiki puis Telegram
// =============================================================

var DOMAINS_URL           = 'https://raw.githubusercontent.com/wooodyhood/nuvio-repo/main/domains.json';
var PURSTREAM_FALLBACK    = 'cx';
var PURSTREAM_API         = 'https://api.purstream.' + PURSTREAM_FALLBACK + '/api/v1';
var PURSTREAM_REFERER     = 'https://purstream.' + PURSTREAM_FALLBACK + '/';
var PURSTREAM_UA          = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
var TMDB_KEY              = '2dca580c2a14b55200e784d157207b4d';

var _cachedEndpoint = null;

// ---------------------------------------------------------------
// Récupération du domaine depuis domains.json (GitHub)
// Fallback : purstream.wiki puis Telegram
// ---------------------------------------------------------------
function detectPurstreamDomain() {
  if (_cachedEndpoint) return Promise.resolve(_cachedEndpoint);

  return fetch(DOMAINS_URL)
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function(data) {
      var tld = data.purstream;
      if (!tld) throw new Error('Domaine purstream absent du fichier');
      console.log('[Purstream] Domaine récupéré: purstream.' + tld);
      _cachedEndpoint = {
        api:     'https://api.purstream.' + tld + '/api/v1',
        referer: 'https://purstream.' + tld + '/'
      };
      return _cachedEndpoint;
    })
    .catch(function() {
      console.warn('[Purstream] domains.json échoué, fallback purstream.wiki');
      return fetch('https://purstream.wiki/', { headers: { 'User-Agent': PURSTREAM_UA } })
        .then(function(res) { return res.text(); })
        .then(function(html) {
          var m = html.match(/https?:\/\/purstream\.[a-z]+/gi);
          if (!m) throw new Error('Aucun domaine sur purstream.wiki');
          var domains = m.filter(function(u) {
            var lower = u.toLowerCase();
            return lower.indexOf('purstream.wiki') === -1 && lower.indexOf('t.me') === -1;
          });
          if (!domains.length) throw new Error('Aucun domaine valide');
          var tld = domains[domains.length - 1].toLowerCase().replace(/https?:\/\/purstream\./, '').replace(/\/$/, '');
          _cachedEndpoint = {
            api:     'https://api.purstream.' + tld + '/api/v1',
            referer: 'https://purstream.' + tld + '/'
          };
          console.log('[Purstream] Domaine via purstream.wiki: purstream.' + tld);
          return _cachedEndpoint;
        })
        .catch(function() {
          return fetch('https://t.me/s/purstreamm', { headers: { 'User-Agent': PURSTREAM_UA } })
            .then(function(res) { return res.text(); })
            .then(function(html) {
              var m = html.match(/https?:\/\/purstream\.[a-z]+/gi);
              if (!m) throw new Error('Aucun domaine Telegram');
              var domains = m.filter(function(u) {
                var lower = u.toLowerCase();
                return lower.indexOf('t.me') === -1 && lower.indexOf('telegram') === -1;
              });
              if (!domains.length) throw new Error('Aucun domaine valide');
              var tld = domains[domains.length - 1].toLowerCase().replace(/https?:\/\/purstream\./, '').replace(/\/$/, '');
              _cachedEndpoint = {
                api:     'https://api.purstream.' + tld + '/api/v1',
                referer: 'https://purstream.' + tld + '/'
              };
              console.log('[Purstream] Domaine via Telegram: purstream.' + tld);
              return _cachedEndpoint;
            })
            .catch(function() {
              console.warn('[Purstream] Fallback hardcodé: ' + PURSTREAM_FALLBACK);
              return {
                api:     'https://api.purstream.' + PURSTREAM_FALLBACK + '/api/v1',
                referer: 'https://purstream.' + PURSTREAM_FALLBACK + '/'
              };
            });
        });
    });
}

function applyPurstreamDomain(endpoint) {
  PURSTREAM_API     = endpoint.api;
  PURSTREAM_REFERER = endpoint.referer;
}

// ---------------------------------------------------------------
// Nettoyage d'un titre pour comparaison souple
// ---------------------------------------------------------------
function cleanTitle(s) {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/[àáâãäå]/g, 'a')
    .replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i')
    .replace(/[òóôõö]/g, 'o')
    .replace(/[ùúûü]/g, 'u')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------
// Extraire l'année depuis une date "2021-11-12 00:00:00" ou "2021"
// ---------------------------------------------------------------
function extractYear(dateStr) {
  if (!dateStr) return null;
  var m = String(dateStr).match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

// ---------------------------------------------------------------
// Étape 1 : tmdbId → titres FR + original + année via TMDB
// ---------------------------------------------------------------
function getTitleFromTmdb(tmdbId, mediaType) {
  var type = mediaType === 'tv' ? 'tv' : 'movie';
  var url = 'https://api.themoviedb.org/3/' + type + '/' + tmdbId + '?language=fr-FR&api_key=' + TMDB_KEY;

  return fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': PURSTREAM_UA }
  })
    .then(function(res) {
      if (!res.ok) throw new Error('TMDB HTTP ' + res.status);
      return res.json();
    })
    .then(function(data) {
      var titleFr   = data.title || data.name || '';
      var titleOrig = data.original_title || data.original_name || '';
      if (!titleFr && !titleOrig) throw new Error('Aucun titre TMDB');

      // Année de sortie : release_date pour films, first_air_date pour séries
      var dateStr = data.release_date || data.first_air_date || '';
      var year    = extractYear(dateStr);

      console.log('[Purstream] TMDB: FR="' + titleFr + '" ORIG="' + titleOrig + '" année=' + year);
      return { fr: titleFr, orig: titleOrig, year: year };
    });
}

// ---------------------------------------------------------------
// Étape 2 : recherche purstream par titre + vérification année
// - Match exact sur le titre (nettoyé)
// - Si plusieurs résultats avec le même titre → vérifier l'année
// - Tolérance ±1 an (post-prod, sorties décalées)
// - Si aucun match → erreur (pas de faux positif)
// ---------------------------------------------------------------
function findPurstreamIdByTitle(title, mediaType, tmdbYear) {
  if (!title) throw new Error('Titre vide');
  var encoded = encodeURIComponent(title);
  var url = PURSTREAM_API + '/search-bar/search/' + encoded;

  console.log('[Purstream] Recherche: ' + url);

  return fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': PURSTREAM_UA,
      'Referer': PURSTREAM_REFERER,
      'Origin': 'https://purstream.art'
    }
  })
    .then(function(res) {
      if (!res.ok) throw new Error('Search HTTP ' + res.status);
      return res.json();
    })
    .then(function(data) {
      if (!data || !data.data || !data.data.items) throw new Error('Réponse vide');

      var items = data.data.items.movies && data.data.items.movies.items
        ? data.data.items.movies.items
        : [];

      if (items.length === 0) throw new Error('Absent de purstream: ' + title);

      var targetType  = mediaType === 'tv' ? 'tv' : 'movie';
      var cleanTarget = cleanTitle(title);

      // Garder uniquement les items dont le titre correspond exactement
      var titleMatches = [];
      for (var i = 0; i < items.length; i++) {
        if (cleanTitle(items[i].title) === cleanTarget) {
          titleMatches.push(items[i]);
        }
      }

      if (titleMatches.length === 0) throw new Error('Pas de match exact pour: ' + title);

      // Un seul match → on le prend directement (pas besoin de vérifier l'année)
      if (titleMatches.length === 1) {
        // Vérification année quand même si on a l'info des deux côtés
        var item = titleMatches[0];
        var purYear = extractYear(item.release_date);
        if (tmdbYear && purYear && Math.abs(tmdbYear - purYear) > 1) {
          throw new Error('Année incorrecte: TMDB=' + tmdbYear + ' purstream=' + purYear + ' pour "' + title + '"');
        }
        console.log('[Purstream] Match unique: id=' + item.id + ' "' + item.title + '" (' + purYear + ')');
        return item.id;
      }

      // Plusieurs matchs de titre → utiliser l'année pour départager
      console.log('[Purstream] ' + titleMatches.length + ' matchs pour "' + title + '", départage par année (TMDB=' + tmdbYear + ')');

      // Priorité 1 : bon type + bonne année
      for (var i = 0; i < titleMatches.length; i++) {
        var item = titleMatches[i];
        var purYear = extractYear(item.release_date);
        if (item.type === targetType && tmdbYear && purYear && Math.abs(tmdbYear - purYear) <= 1) {
          console.log('[Purstream] Match type+année: id=' + item.id + ' (' + purYear + ')');
          return item.id;
        }
      }

      // Priorité 2 : bonne année (type ignoré)
      for (var i = 0; i < titleMatches.length; i++) {
        var item = titleMatches[i];
        var purYear = extractYear(item.release_date);
        if (tmdbYear && purYear && Math.abs(tmdbYear - purYear) <= 1) {
          console.log('[Purstream] Match année seule: id=' + item.id + ' (' + purYear + ')');
          return item.id;
        }
      }

      // Priorité 3 : bon type sans vérification année (pas d'info année)
      for (var i = 0; i < titleMatches.length; i++) {
        if (titleMatches[i].type === targetType) {
          console.log('[Purstream] Match type seul: id=' + titleMatches[i].id);
          return titleMatches[i].id;
        }
      }

      // Dernier recours : premier match de titre
      console.log('[Purstream] Match titre (premier): id=' + titleMatches[0].id);
      return titleMatches[0].id;
    });
}

// ---------------------------------------------------------------
// Étape 1+2 : tmdbId → purstreamId
// Essaie titre FR, puis titre original si différent
// ---------------------------------------------------------------
function findPurstreamId(tmdbId, mediaType) {
  return getTitleFromTmdb(tmdbId, mediaType)
    .then(function(titles) {
      return findPurstreamIdByTitle(titles.fr, mediaType, titles.year)
        .catch(function(errFr) {
          if (!titles.orig || cleanTitle(titles.orig) === cleanTitle(titles.fr)) {
            throw errFr;
          }
          console.log('[Purstream] Titre FR sans match ("' + titles.fr + '"), essai titre original: ' + titles.orig);
          return findPurstreamIdByTitle(titles.orig, mediaType, titles.year);
        });
    });
}

// ---------------------------------------------------------------
// Étape 3A : Sources d'un FILM
// GET /api/v1/media/{purstreamId}/sheet → data.items.urls[]
// ---------------------------------------------------------------
function fetchMovieSources(purstreamId) {
  var url = PURSTREAM_API + '/media/' + purstreamId + '/sheet';
  console.log('[Purstream] Film sheet: ' + url);

  return fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': PURSTREAM_UA,
      'Referer': PURSTREAM_REFERER,
      'Origin': 'https://purstream.art'
    }
  })
    .then(function(res) {
      if (!res.ok) throw new Error('Sheet HTTP ' + res.status);
      return res.json();
    })
    .then(function(data) {
      if (!data || !data.data || !data.data.items) throw new Error('Sheet vide');
      var urls = data.data.items.urls;
      if (!urls || urls.length === 0) throw new Error('Aucune URL dans sheet');
      return urls;
    });
}

// ---------------------------------------------------------------
// Étape 3B : Sources d'une SÉRIE
// GET /api/v1/stream/{purstreamId}/episode?season=X&episode=Y
// → data.items.sources[]
// ---------------------------------------------------------------
function fetchEpisodeSources(purstreamId, season, episode) {
  var url = PURSTREAM_API + '/stream/' + purstreamId + '/episode?season=' + (season || 1) + '&episode=' + (episode || 1);
  console.log('[Purstream] Série épisode: ' + url);

  return fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': PURSTREAM_UA,
      'Referer': PURSTREAM_REFERER,
      'Origin': 'https://purstream.art'
    }
  })
    .then(function(res) {
      if (!res.ok) throw new Error('Episode HTTP ' + res.status);
      return res.json();
    })
    .then(function(data) {
      if (!data || !data.data || !data.data.items) throw new Error('Episode vide');
      var sources = data.data.items.sources;
      if (!sources || sources.length === 0) throw new Error('Aucune source épisode');
      return sources;
    });
}

// ---------------------------------------------------------------
// Normalisation vers le format Nuvio
// ---------------------------------------------------------------
function parseLang(name) {
  if (!name) return 'MULTI';
  var n = name.toUpperCase();
  if (n.indexOf('VOSTFR') !== -1) return 'VOSTFR';
  if (n.indexOf('VF')     !== -1) return 'VF';
  if (n.indexOf('MULTI')  !== -1) return 'MULTI';
  return 'MULTI';
}

function parseQuality(name) {
  if (!name) return 'HD';
  if (name.indexOf('4K')   !== -1 || name.indexOf('4k')   !== -1) return '4K';
  if (name.indexOf('1080') !== -1) return '1080p';
  if (name.indexOf('720')  !== -1) return '720p';
  if (name.indexOf('480')  !== -1) return '480p';
  return 'HD';
}

function isDirectStream(url) {
  return url && (url.match(/\.m3u8/i) || url.match(/\.mp4/i));
}

function normalizeMovieSources(urls) {
  var results = [];
  for (var i = 0; i < urls.length; i++) {
    var item = urls[i];
    var url  = item.url;
    var name = item.name || '';
    if (!url) continue;
    if (!isDirectStream(url)) {
      console.log('[Purstream] Ignoré embed: ' + url);
      continue;
    }
    results.push({
      name: 'Purstream',
      title: 'Purstream ' + parseQuality(name) + ' | ' + parseLang(name),
      url: url,
      quality: parseQuality(name),
      format: url.match(/\.mp4/i) ? 'mp4' : 'm3u8',
      headers: { 'User-Agent': PURSTREAM_UA, 'Referer': PURSTREAM_REFERER }
    });
  }
  return results;
}

function normalizeEpisodeSources(sources) {
  var results = [];
  for (var i = 0; i < sources.length; i++) {
    var item = sources[i];
    var url  = item.stream_url;
    var name = item.source_name || '';
    if (!url) continue;
    results.push({
      name: 'Purstream',
      title: 'Purstream ' + parseQuality(name) + ' | ' + parseLang(name),
      url: url,
      quality: parseQuality(name),
      format: item.format || 'm3u8',
      headers: { 'User-Agent': PURSTREAM_UA, 'Referer': PURSTREAM_REFERER }
    });
  }
  return results;
}

// ---------------------------------------------------------------
// Fonction principale appelée par Nuvio
// ---------------------------------------------------------------
function getStreams(tmdbId, mediaType, season, episode) {
  console.log('[Purstream] START tmdbId=' + tmdbId + ' type=' + mediaType + ' S' + season + 'E' + episode);

  return detectPurstreamDomain()
    .then(function(endpoint) {
      applyPurstreamDomain(endpoint);
      return pipeline();
    })
    .catch(function(err) {
      console.error('[Purstream] Erreur globale: ' + (err.message || String(err)));
      return [];
    });

  function pipeline() {
    return findPurstreamId(tmdbId, mediaType)
      .then(function(purstreamId) {
        console.log('[Purstream] purstreamId=' + purstreamId);
        if (mediaType === 'tv') {
          return fetchEpisodeSources(purstreamId, season, episode)
            .then(function(sources) {
              var result = normalizeEpisodeSources(sources);
              console.log('[Purstream] ' + result.length + ' sources série');
              return result;
            });
        } else {
          return fetchMovieSources(purstreamId)
            .then(function(urls) {
              var result = normalizeMovieSources(urls);
              console.log('[Purstream] ' + result.length + ' sources film');
              return result;
            });
        }
      });
  }
}

// ---------------------------------------------------------------
// Export
// ---------------------------------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}
