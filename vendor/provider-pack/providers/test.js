// ============================================================
// Einthusan Provider for Nuvio
// Author: Nik
// Version: 1.0.0
// Supports: Hindi, Tamil, Telugu, Malayalam, Kannada,
//           Bengali, Marathi, Punjabi movies
// Note: Works with TMDB title search → Einthusan match
// ============================================================

var BASE_URL = 'https://einthusan.tv';

var HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Origin': 'https://einthusan.tv',
  'Referer': 'https://einthusan.tv/'
};

// Language map — Einthusan uses lang slug in URL
var LANG_SLUGS = ['hindi', 'tamil', 'telugu', 'malayalam', 'kannada', 'bengali', 'marathi', 'punjabi'];

// ── Utility: simple HTML tag stripper ──────────────────────
function stripTags(html) {
  return html.replace(/<[^>]*>/g, '').trim();
}

// ── Utility: extract value between two strings ─────────────
function extractBetween(str, start, end) {
  var si = str.indexOf(start);
  if (si === -1) return null;
  si += start.length;
  var ei = str.indexOf(end, si);
  if (ei === -1) return null;
  return str.substring(si, ei).trim();
}

// ── Step 1: Search Einthusan for a movie title ─────────────
function searchEinthusan(title, lang) {
  return new Promise(function (resolve) {
    var searchUrl = BASE_URL + '/movie/results/?lang=' + lang + '&find=Search&title=' + encodeURIComponent(title);

    fetch(searchUrl, { headers: HEADERS })
      .then(function (res) { return res.text(); })
      .then(function (html) {
        // Extract first result movie ID
        // Pattern: href="/movie/watch/12345/?lang=hindi"
        var pattern = /href="\/movie\/watch\/(\d+)\/\?lang=([^"]+)"/;
        var match = html.match(pattern);

        if (!match) {
          resolve(null);
          return;
        }

        var movieId = match[1];
        var movieLang = match[2];

        // Also try to grab the movie title from result to verify match
        var titlePattern = /<h3[^>]*>([\s\S]*?)<\/h3>/;
        var titleMatch = html.match(titlePattern);
        var foundTitle = titleMatch ? stripTags(titleMatch[1]) : '';

        resolve({
          id: movieId,
          lang: movieLang,
          title: foundTitle
        });
      })
      .catch(function () { resolve(null); });
  });
}

// ── Step 2: Get stream URL from movie watch page ───────────
function getStreamFromMoviePage(movieId, lang) {
  return new Promise(function (resolve) {
    var watchUrl = BASE_URL + '/movie/watch/' + movieId + '/?lang=' + lang;
    var ajaxUrl = BASE_URL + '/ajax/movie/watch/' + movieId + '/';

    var pageHeaders = Object.assign({}, HEADERS, {
      'Referer': BASE_URL + '/movie/browse/?lang=' + lang
    });

    fetch(watchUrl, { headers: pageHeaders })
      .then(function (res) { return res.text(); })
      .then(function (html) {

        // Method 1: Look for direct MP4 link
        var mp4Match = html.match(/file\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)/i);
        if (mp4Match) {
          resolve([{
            url: mp4Match[1],
            quality: 'HD',
            format: 'mp4'
          }]);
          return;
        }

        // Method 2: Look for M3U8 / HLS stream
        var m3u8Match = html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)/i);
        if (m3u8Match) {
          resolve([{
            url: m3u8Match[1],
            quality: 'HD',
            format: 'm3u8'
          }]);
          return;
        }

        // Method 3: Extract CSRF token + ejpingdom data and hit AJAX
        var csrfMatch = html.match(/gorilla\.csrf\.Token['":\s]+(['"]+)([^'"]+)/);
        var csrf = csrfMatch ? csrfMatch[2] : '';

        var ejMatch = html.match(/data-ejpingdom['":\s]+(['"]+)([^'"]+)/);
        var ejData = ejMatch ? ejMatch[2] : '';

        if (csrf && ejData) {
          var ajaxHeaders = Object.assign({}, HEADERS, {
            'Referer': watchUrl,
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/x-www-form-urlencoded'
          });

          var postBody = 'xEvent=UIVideoPlayer.PingOutcome&xJson=' +
            encodeURIComponent(ejData) +
            '&arcVersion=3&appVersion=59&gorilla.csrf.Token=' +
            encodeURIComponent(csrf);

          fetch(ajaxUrl, {
            method: 'POST',
            headers: ajaxHeaders,
            body: postBody
          })
            .then(function (r) { return r.text(); })
            .then(function (ajaxHtml) {
              var streamMatch = ajaxHtml.match(/["'](https?:\/\/[^"']+\.(mp4|m3u8)[^"']*)/i);
              if (streamMatch) {
                resolve([{
                  url: streamMatch[1],
                  quality: 'HD',
                  format: streamMatch[2]
                }]);
              } else {
                resolve([]);
              }
            })
            .catch(function () { resolve([]); });
        } else {
          resolve([]);
        }
      })
      .catch(function () { resolve([]); });
  });
}

// ── Step 3: Lookup TMDB title using TMDB ID ────────────────
function getTmdbTitle(tmdbId, mediaType) {
  return new Promise(function (resolve) {
    // Nuvio passes tmdbId — we use TMDB's public endpoint (no key needed for basic info)
    var tmdbUrl = 'https://api.themoviedb.org/3/' + mediaType + '/' + tmdbId + '?language=en-US&api_key=4ef0d7355d9ffb5151e987764708ce96';

    fetch(tmdbUrl)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var title = data.title || data.name || null;
        resolve(title);
      })
      .catch(function () { resolve(null); });
  });
}

// ── Main exported function ─────────────────────────────────
function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  return new Promise(function (resolve) {

    // Einthusan only has movies (not TV series usually)
    // We'll still try for both but focus on movies
    getTmdbTitle(tmdbId, mediaType)
      .then(function (title) {
        if (!title) {
          resolve([]);
          return;
        }

        // Try searching across key Indian languages
        var searchPromises = LANG_SLUGS.map(function (lang) {
          return searchEinthusan(title, lang);
        });

        Promise.all(searchPromises)
          .then(function (results) {
            // Filter out nulls and get first valid result
            var validResults = results.filter(function (r) { return r !== null; });

            if (validResults.length === 0) {
              resolve([]);
              return;
            }

            // Get streams from first valid match
            var best = validResults[0];
            return getStreamFromMoviePage(best.id, best.lang);
          })
          .then(function (streams) {
            resolve(streams || []);
          })
          .catch(function () { resolve([]); });
      });
  });
}

module.exports = { getStreams: getStreams };
