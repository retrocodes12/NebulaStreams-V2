// =============================================================
// Provider Nuvio : Purstream.art (VF/VOSTFR/MULTI français)
// Version : 3.0.0
// Stratégie : tmdbId → titre TMDB → recherche purstream → streams
// =============================================================

var PURSTREAM_API = 'https://api.purstream.art/api/v1';
var PURSTREAM_REFERER = 'https://purstream.art/';
var PURSTREAM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
var TMDB_KEY = '2dca580c2a14b55200e784d157207b4d';

// ---------------------------------------------------------------
// Étape 1 : tmdbId → titre français via TMDB
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
      var titleFr = data.title || data.name;
      var titleOrig = data.original_title || data.original_name;
      if (!titleFr && !titleOrig) throw new Error('Aucun titre TMDB');
      console.log('[Purstream] Titres TMDB: FR=' + titleFr + ' ORIG=' + titleOrig);
      return { fr: titleFr, orig: titleOrig };
    });
}

// ---------------------------------------------------------------
// Étape 2 : titre → ID purstream interne
// GET /api/v1/search-bar/search/{titre}
// Tous les résultats sont dans items.movies (films ET séries)
// Le champ "type" vaut "movie" ou "tv"
// ---------------------------------------------------------------
function findPurstreamIdByTitle(title, mediaType) {
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

      // Tout est dans movies.items (films ET séries confondus)
      var items = data.data.items.movies && data.data.items.movies.items
        ? data.data.items.movies.items
        : [];

      if (items.length === 0) throw new Error('Aucun résultat pour: ' + title);

      var targetType = mediaType === 'tv' ? 'tv' : 'movie';
      var titleLower = title.toLowerCase();

      // 1. Match exact titre + bon type
      for (var i = 0; i < items.length; i++) {
        if (items[i].type === targetType && items[i].title && items[i].title.toLowerCase() === titleLower) {
          console.log('[Purstream] Match exact: id=' + items[i].id + ' type=' + items[i].type);
          return items[i].id;
        }
      }

      // 2. Match exact titre (peu importe le type)
      for (var i = 0; i < items.length; i++) {
        if (items[i].title && items[i].title.toLowerCase() === titleLower) {
          console.log('[Purstream] Match titre: id=' + items[i].id + ' type=' + items[i].type);
          return items[i].id;
        }
      }

      // 3. Premier résultat du bon type
      for (var i = 0; i < items.length; i++) {
        if (items[i].type === targetType) {
          console.log('[Purstream] Premier du bon type: id=' + items[i].id);
          return items[i].id;
        }
      }

      // 4. Fallback : premier résultat
      console.log('[Purstream] Fallback premier: id=' + items[0].id);
      return items[0].id;
    });
}

// ---------------------------------------------------------------
// Étape 1+2 combinées : tmdbId → purstreamId
// Essaie titre FR puis titre original si FR échoue
// ---------------------------------------------------------------
function findPurstreamId(tmdbId, mediaType) {
  return getTitleFromTmdb(tmdbId, mediaType)
    .then(function(titles) {
      return findPurstreamIdByTitle(titles.fr, mediaType)
        .catch(function(err) {
          console.log('[Purstream] Titre FR échoué (' + err.message + '), essai titre original...');
          return findPurstreamIdByTitle(titles.orig, mediaType);
        });
    });
}

// ---------------------------------------------------------------
// Étape 3A : Sources d'un FILM
// GET /api/v1/media/{purstreamId}/sheet
// → data.items.urls[] : { url, name }
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
// → data.items.sources[] : { stream_url, source_name, format }
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
// Normalisation des sources vers le format Nuvio
// ---------------------------------------------------------------
function parseLang(name) {
  if (!name) return 'MULTI';
  var n = name.toUpperCase();
  if (n.indexOf('VOSTFR') !== -1) return 'VOSTFR';
  if (n.indexOf('VF') !== -1) return 'VF';
  if (n.indexOf('MULTI') !== -1) return 'MULTI';
  return 'MULTI';
}

function parseQuality(name) {
  if (!name) return 'HD';
  if (name.indexOf('4K') !== -1 || name.indexOf('4k') !== -1) return '4K';
  if (name.indexOf('1080') !== -1) return '1080p';
  if (name.indexOf('720') !== -1) return '720p';
  if (name.indexOf('480') !== -1) return '480p';
  return 'HD';
}

function isDirectStream(url) {
  return url && (url.match(/\.m3u8/i) || url.match(/\.mp4/i));
}

function normalizeMovieSources(urls) {
  var results = [];
  for (var i = 0; i < urls.length; i++) {
    var item = urls[i];
    var url = item.url;
    var name = item.name || '';
    if (!url) continue;

    // Ignorer les embeds (voe, doodstream, etc.)
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
      headers: {
        'User-Agent': PURSTREAM_UA,
        'Referer': PURSTREAM_REFERER
      }
    });
  }
  return results;
}

function normalizeEpisodeSources(sources) {
  var results = [];
  for (var i = 0; i < sources.length; i++) {
    var item = sources[i];
    var url = item.stream_url;
    var name = item.source_name || '';
    if (!url) continue;

    results.push({
      name: 'Purstream',
      title: 'Purstream ' + parseQuality(name) + ' | ' + parseLang(name),
      url: url,
      quality: parseQuality(name),
      format: item.format || 'm3u8',
      headers: {
        'User-Agent': PURSTREAM_UA,
        'Referer': PURSTREAM_REFERER
      }
    });
  }
  return results;
}

// ---------------------------------------------------------------
// Fonction principale appelée par Nuvio
// ---------------------------------------------------------------
function getStreams(tmdbId, mediaType, season, episode) {
  console.log('[Purstream] START tmdbId=' + tmdbId + ' type=' + mediaType + ' S' + season + 'E' + episode);

  return findPurstreamId(tmdbId, mediaType)
    .then(function(purstreamId) {
      console.log('[Purstream] purstreamId=' + purstreamId);

      if (mediaType === 'tv') {
        return fetchEpisodeSources(purstreamId, season, episode)
          .then(function(sources) {
            var result = normalizeEpisodeSources(sources);
            console.log('[Purstream] ' + result.length + ' sources série trouvées');
            return result;
          });
      } else {
        return fetchMovieSources(purstreamId)
          .then(function(urls) {
            var result = normalizeMovieSources(urls);
            console.log('[Purstream] ' + result.length + ' sources film trouvées');
            return result;
          });
      }
    })
    .catch(function(err) {
      console.error('[Purstream] Erreur globale: ' + (err.message || String(err)));
      return [];
    });
}

// ---------------------------------------------------------------
// Export
// ---------------------------------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}
