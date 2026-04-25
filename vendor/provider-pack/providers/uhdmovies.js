"use strict";

// src/uhdmovies/index.js
var https = require("node:https");
var dns = require("node:dns");
var dnsPromises = require("node:dns").promises;
var axios = require("axios");
var DOMAIN = (process.env.UHDMOVIES_BASE_URL || "https://uhdmovies.ink").replace(/\/+$/, "");
var TMDB_API = "https://api.themoviedb.org/3";
var TMDB_API_KEY = "1865f43a0549ca50d341dd9ab8b29f49";
var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
var PUBLIC_RESOLVER = new dnsPromises.Resolver();
var UHD_DNS_BYPASS_HOSTS = {
  "uhdmovies.ink": true,
  "www.uhdmovies.ink": true,
  "uhdmovies.rip": true,
  "www.uhdmovies.rip": true
};
var DNS_CACHE_TTL_MS = 30 * 60 * 1000;
var TMDB_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
var TMDB_RETRY_DELAYS_MS = [250, 750, 1500];
var SITEMAP_CACHE_TTL_MS = 30 * 60 * 1000;
var MAX_POST_SITEMAP_PAGES = 12;
var dnsCache = new Map();
var tmdbCache = new Map();
var sitemapCache = {
  entries: null,
  expiresAt: 0
};
PUBLIC_RESOLVER.setServers(["1.1.1.1", "8.8.8.8"]);
function getBaseUrl(url) {
  if (!url) return DOMAIN;
  var match = url.match(/^(https?:\/\/[^\/]+)/);
  return match ? match[1] : DOMAIN;
}
function isDnsBypassHost(hostname) {
  return !!UHD_DNS_BYPASS_HOSTS[String(hostname || "").toLowerCase()];
}
function resolveDnsBypassAddress(hostname) {
  hostname = String(hostname || "").toLowerCase();
  var cached = dnsCache.get(hostname);
  if (cached && Date.now() - cached.ts < DNS_CACHE_TTL_MS) {
    return Promise.resolve(cached.ip);
  }
  return PUBLIC_RESOLVER.resolve4(hostname).then(function(addresses) {
    if (!addresses || !addresses.length) throw new Error("No A record for " + hostname);
    dnsCache.set(hostname, { ip: addresses[0], ts: Date.now() });
    return addresses[0];
  }).catch(function() {
    return new Promise(function(resolve, reject) {
      dns.lookup(hostname, { family: 4 }, function(err, address) {
        if (err) return reject(err);
        dnsCache.set(hostname, { ip: address, ts: Date.now() });
        resolve(address);
      });
    });
  });
}
function createResponse(statusCode, headersMap, body) {
  return {
    status: statusCode,
    ok: statusCode >= 200 && statusCode < 300,
    headers: {
      get: function(name) {
        return headersMap[String(name || "").toLowerCase()] || null;
      }
    },
    text: function() {
      return Promise.resolve(body);
    },
    json: function() {
      return Promise.resolve(JSON.parse(body));
    }
  };
}
function sleep(delayMs) {
  return new Promise(function(resolve) {
    var timer = setTimeout(resolve, delayMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
}
function providerFetch(url, options, redirectCount) {
  options = options || {};
  redirectCount = redirectCount || 0;
  var targetUrl;
  try {
    targetUrl = new URL(url);
  } catch (err) {
    return Promise.reject(err);
  }
  if (!isDnsBypassHost(targetUrl.hostname)) {
    return fetch(url, options);
  }
  return resolveDnsBypassAddress(targetUrl.hostname).then(function(address) {
    return new Promise(function(resolve, reject) {
      var headers = Object.assign({}, options.headers || {});
      if (!headers.Host) headers.Host = targetUrl.host;
      var req = https.request({
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        servername: targetUrl.hostname,
        host: targetUrl.hostname,
        port: targetUrl.port || 443,
        path: targetUrl.pathname + targetUrl.search,
        method: options.method || "GET",
        headers,
        lookup: function(hostname, lookupOptions, callback) {
          if (typeof lookupOptions === "function") {
            callback = lookupOptions;
            lookupOptions = {};
          }
          if (hostname === targetUrl.hostname) {
            if (lookupOptions && lookupOptions.all) {
              return callback(null, [{ address: address, family: 4 }]);
            }
            return callback(null, address, 4);
          }
          dns.lookup(hostname, lookupOptions, callback);
        }
      }, function(res) {
        var chunks = [];
        res.on("data", function(chunk) {
          chunks.push(chunk);
        });
        res.on("end", function() {
          var body = Buffer.concat(chunks).toString("utf8");
          var headersMap = {};
          Object.keys(res.headers || {}).forEach(function(key) {
            var value = res.headers[key];
            headersMap[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value || "");
          });
          if (res.statusCode >= 300 && res.statusCode < 400 && headersMap.location && redirectCount < 5 && options.redirect !== "manual") {
            var redirectUrl = new URL(headersMap.location, targetUrl.toString()).toString();
            var nextOptions = Object.assign({}, options);
            if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && String(options.method || "GET").toUpperCase() !== "GET")) {
              nextOptions.method = "GET";
              delete nextOptions.body;
            }
            return resolve(providerFetch(redirectUrl, nextOptions, redirectCount + 1));
          }
          resolve(createResponse(res.statusCode || 500, headersMap, body));
        });
      });
      req.on("error", reject);
      req.setTimeout(15000, function() {
        req.destroy(new Error("Request timeout"));
      });
      if (options.body) req.write(options.body);
      req.end();
    });
  });
}
function fixUrl(url, domain) {
  if (!url) return "";
  if (url.indexOf("http") === 0) return url;
  if (url.indexOf("//") === 0) return "https:" + url;
  if (url.indexOf("/") === 0) return domain + url;
  return domain + "/" + url;
}
function toFormEncoded(obj) {
  return Object.keys(obj).map(function(k) {
    return encodeURIComponent(k) + "=" + encodeURIComponent(obj[k] || "");
  }).join("&");
}
function stripTags(html) {
  return (html || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").trim();
}
function extractFormAction(html) {
  var m = html.match(/<form[^>]*id="landing"[^>]*action="([^"]+)"/i) || html.match(/<form[^>]*action="([^"]+)"[^>]*id="landing"/i);
  return m ? m[1] : null;
}
function extractFormInputs(html) {
  var obj = {};
  var formMatch = html.match(/<form[^>]*id="landing"[^>]*>([\s\S]*?)<\/form>/i) || html.match(/<form[^>]*>([\s\S]*?)<\/form>/i);
  var formHtml = formMatch ? formMatch[1] : html;
  var re = /<input[^>]+>/gi;
  var m;
  while ((m = re.exec(formHtml)) !== null) {
    var nameM = m[0].match(/name="([^"]+)"/i);
    var valueM = m[0].match(/value="([^"]*)"/i);
    if (nameM) obj[nameM[1]] = valueM ? valueM[1] : "";
  }
  return obj;
}
function extractScriptContaining(html, needle) {
  var re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    if (m[1].indexOf(needle) !== -1) return m[1];
  }
  return "";
}
function extractMetaRefresh(html) {
  var m = html.match(/<meta[^>]*http-equiv="refresh"[^>]*content="([^"]+)"/i) || html.match(/<meta[^>]*content="([^"]+)"[^>]*http-equiv="refresh"/i);
  if (!m) return null;
  var urlM = m[1].match(/url=(.+)/i);
  return urlM ? urlM[1].trim() : null;
}
function extractBtnSuccessLinks(html) {
  var links = [];
  var seen = {};
  var patterns = [
    /<a[^>]*class="[^"]*btn-success[^"]*"[^>]*href="([^"]+)"/gi,
    /<a[^>]*href="([^"]+)"[^>]*class="[^"]*btn-success[^"]*"/gi
  ];
  for (var pi = 0; pi < patterns.length; pi++) {
    var re = patterns[pi];
    var m;
    while ((m = re.exec(html)) !== null) {
      if (m[1].indexOf("http") === 0 && !seen[m[1]]) {
        seen[m[1]] = true;
        links.push(m[1]);
      }
    }
  }
  return links;
}
function extractTextCenterLinks(html) {
  var links = [];
  var divRe = /<div[^>]*class="[^"]*text-center[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  var divM;
  while ((divM = divRe.exec(html)) !== null) {
    var divHtml = divM[1];
    var aRe = /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    var aM;
    while ((aM = aRe.exec(divHtml)) !== null) {
      links.push({ href: aM[1], text: stripTags(aM[2]) });
    }
  }
  return links;
}
function extractFirstListGroupItem(html) {
  var m = html.match(/<li[^>]*class="[^"]*list-group-item[^"]*"[^>]*>([\s\S]*?)<\/li>/i);
  return m ? stripTags(m[1]) : "";
}
function extractThirdListItem(html) {
  var re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  var count = 0;
  var m;
  while ((m = re.exec(html)) !== null) {
    count++;
    if (count === 3) return stripTags(m[1]);
  }
  return "";
}
function getIndexQuality(str) {
  if (!str) return "Unknown";
  // Check explicit resolution first (e.g. 2160p, 1080p, 720p)
  var m = str.match(/(\d{3,4})[pP]/);
  if (m) return m[1] + "p";
  // Only treat 4K/UHD as 2160p when it's a standalone quality tag, not part of site names like "UHDMovies"
  if (/\b4[kK]\b/.test(str) || /\bUHD\b(?!movies)/i.test(str)) return "2160p";
  return "Unknown";
}
function buildQualityLabel(str) {
  var resolution = getIndexQuality(str);
  var label = resolution === "2160p" ? "4K" : resolution;
  var fuente = null;
  if (/remux/i.test(str))           fuente = "BluRay REMUX";
  else if (/blu.?ray|bluray/i.test(str)) fuente = "BluRay";
  else if (/web.?dl/i.test(str))    fuente = "WEB-DL";
  else if (/webrip/i.test(str))     fuente = "WEBRip";
  else if (/hdrip/i.test(str))      fuente = "HDRip";
  else if (/dvdrip/i.test(str))     fuente = "DVDRip";
  else if (/hdtv/i.test(str))       fuente = "HDTV";
  var codec = null;
  if (/\bHEVC\b|\bx265\b|\bH\.?265\b/i.test(str))      codec = "x265/HEVC";
  else if (/\bAVC\b|\bx264\b|\bH\.?264\b/i.test(str))  codec = "x264/AVC";
  return [label, fuente, codec].filter(Boolean).join(" | ");
}
function cleanTitle(title) {
  var qualityTags = ["WEBRip", "WEB-DL", "WEB", "BluRay", "HDRip", "DVDRip", "HDTV", "CAM", "TS", "R5", "DVDScr", "BRRip", "BDRip", "DVD", "PDTV", "HD"];
  var audioTags = ["AAC", "AC3", "DTS", "MP3", "FLAC", "DD5", "EAC3", "Atmos"];
  var subTags = ["ESub", "ESubs", "Subs", "MultiSub", "NoSub", "EnglishSub", "HindiSub"];
  var codecTags = ["x264", "x265", "H264", "HEVC", "AVC"];
  var parts = title.split(/[.\-_]/);
  var startIndex = -1;
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].toLowerCase();
    for (var q = 0; q < qualityTags.length; q++) {
      if (p.indexOf(qualityTags[q].toLowerCase()) !== -1) {
        startIndex = i;
        break;
      }
    }
    if (startIndex !== -1) break;
  }
  var endIndex = -1;
  for (var j = parts.length - 1; j >= 0; j--) {
    var pp = parts[j].toLowerCase();
    var found = false;
    var allTags = subTags.concat(audioTags).concat(codecTags);
    for (var t = 0; t < allTags.length; t++) {
      if (pp.indexOf(allTags[t].toLowerCase()) !== -1) {
        found = true;
        break;
      }
    }
    if (found) {
      endIndex = j;
      break;
    }
  }
  if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
    return parts.slice(startIndex, endIndex + 1).join(".");
  } else if (startIndex !== -1) {
    return parts.slice(startIndex).join(".");
  }
  return parts.slice(-3).join(".");
}
function normalizeSearchText(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function tokenizeSearchText(value) {
  return normalizeSearchText(value).split(" ").filter(function(token) {
    return token.length > 1;
  });
}
function deriveTitleFromUhdUrl(url) {
  try {
    var pathname = new URL(url).pathname.replace(/\/+$/, "");
    var slug = pathname.split("/").pop() || "";
    slug = decodeURIComponent(slug).replace(/^download-/i, "").replace(/-/g, " ").trim();
    return slug;
  } catch (_err) {
    return "";
  }
}
function scoreSitemapEntry(entry, title, year) {
  var titleText = normalizeSearchText(title);
  var entryText = normalizeSearchText(entry.title || entry.rawTitle || "");
  if (!titleText || !entryText) return 0;
  var titleTokens = tokenizeSearchText(title);
  var entryTokens = new Set(tokenizeSearchText(entry.title || entry.rawTitle || ""));
  var matchingTokens = 0;
  for (var i = 0; i < titleTokens.length; i++) {
    if (entryTokens.has(titleTokens[i])) matchingTokens++;
  }
  var tokenScore = titleTokens.length ? matchingTokens / titleTokens.length : 0;
  var containsScore = entryText.indexOf(titleText) !== -1 || titleText.indexOf(entryText) !== -1 ? 1 : 0;
  var yearScore = year && String(entry.rawTitle || "").indexOf(String(year)) !== -1 ? 0.5 : 0;
  return tokenScore * 10 + containsScore * 4 + yearScore;
}
function fetchText(url, extraHeaders) {
  var headers = Object.assign({ "User-Agent": USER_AGENT }, extraHeaders || {});
  return providerFetch(url, { headers, redirect: "follow" }).then(function(res) {
    return res.text();
  });
}
function fetchJson(url) {
  return providerFetch(url, { headers: { "User-Agent": USER_AGENT } }).then(function(res) {
    return res.json();
  });
}
function getTmdbDetails(tmdbId, mediaType) {
  var isSeries = mediaType === "series" || mediaType === "tv";
  var endpoint = isSeries ? "tv" : "movie";
  var cacheKey = endpoint + ":" + tmdbId;
  var cached = tmdbCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.value);
  }
  console.log("[UHDMovies] TMDB: " + TMDB_API + "/" + endpoint + "/" + tmdbId + "?api_key=***");
  return Promise.resolve().then(function() {
    var attempt = 0;
    var lastError = null;
    function runAttempt() {
      return axios.get(TMDB_API + "/" + endpoint + "/" + tmdbId, {
        params: { api_key: TMDB_API_KEY },
        timeout: 12e3,
        headers: {
          "User-Agent": USER_AGENT,
          "Connection": "close"
        },
        validateStatus: function(status) {
          return status >= 200 && status < 300;
        }
      }).then(function(response) {
        var data = response.data || {};
        var result = isSeries ? {
          title: data.name,
          year: data.first_air_date ? data.first_air_date.slice(0, 4) : null
        } : {
          title: data.title,
          year: data.release_date ? data.release_date.slice(0, 4) : null
        };
        tmdbCache.set(cacheKey, {
          value: result,
          expiresAt: Date.now() + TMDB_CACHE_TTL_MS
        });
        return result;
      }).catch(function(error) {
        lastError = error;
        if (attempt >= TMDB_RETRY_DELAYS_MS.length) {
          throw error;
        }
        var delayMs = TMDB_RETRY_DELAYS_MS[attempt++];
        return sleep(delayMs).then(runAttempt);
      });
    }
    return runAttempt().catch(function(err) {
      console.error("[UHDMovies] TMDB error: " + ((err == null ? void 0 : err.message) || (lastError == null ? void 0 : lastError.message) || "unknown error"));
      return null;
    });
  });
}
function searchByTitle(title, year) {
  var query = encodeURIComponent((title + " " + (year || "")).trim());
  var url = DOMAIN + "/?s=" + query;
  console.log("[UHDMovies] Search: " + url);
  return fetchText(url).then(function(html) {
    var results = parseSearchResults(html);
    if (results.length) return results;
    return searchSitemaps(title, year);
  }).catch(function(err) {
    console.error("[UHDMovies] Search error: " + err.message);
    return searchSitemaps(title, year);
  });
}
function parseSearchResults(html) {
  var results = [];
  var chunks = html.split(/<article\b/i);
  for (var i = 1; i < chunks.length; i++) {
    var chunk = "<article" + chunks[i];
    var classM = chunk.match(/<article[^>]*class="([^"]*)"/i);
    if (!classM || classM[1].indexOf("gridlove-post") === -1) continue;
    var h1M = chunk.match(/<h1[^>]*class="[^"]*sanket[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
    var titleRaw = h1M ? stripTags(h1M[1]).replace(/^Download\s+/i, "") : "";
    var titleM = titleRaw.match(/^(.*\)\d*)/);
    var title = titleM ? titleM[1] : titleRaw;
    var imgDivM = chunk.match(/<div[^>]*class="[^"]*entry-image[^"]*"[^>]*>[\s\S]*?<a\s[^>]*href="([^"]+)"/i);
    var href = imgDivM ? imgDivM[1] : null;
    if (href && title) {
      results.push({ title, url: href, rawTitle: titleRaw });
    }
  }
  console.log("[UHDMovies] Results: " + results.length);
  return results;
}
function loadSitemapEntries() {
  if (sitemapCache.entries && sitemapCache.expiresAt > Date.now()) {
    return Promise.resolve(sitemapCache.entries);
  }
  return Promise.resolve().then(function() {
    var tasks = [];
    for (var page = 1; page <= MAX_POST_SITEMAP_PAGES; page++) {
      var sitemapPath = page === 1 ? "/post-sitemap.xml" : "/post-sitemap" + page + ".xml";
      tasks.push(
        fetchText(DOMAIN + sitemapPath).catch(function() {
          return "";
        })
      );
    }
    return Promise.all(tasks);
  }).then(function(bodies) {
    var seen = {};
    var entries = [];
    bodies.forEach(function(body) {
      if (!body || body.indexOf("<urlset") === -1) return;
      var matches = body.match(/<loc>https:\/\/uhdmovies\.ink\/[^<]+<\/loc>/gi) || [];
      matches.forEach(function(match) {
        var url = match.replace(/^<loc>/i, "").replace(/<\/loc>$/i, "").trim();
        if (!url || seen[url]) return;
        seen[url] = true;
        var rawTitle = deriveTitleFromUhdUrl(url);
        entries.push({
          url: url,
          rawTitle: rawTitle,
          title: rawTitle
        });
      });
    });
    sitemapCache = {
      entries: entries,
      expiresAt: Date.now() + SITEMAP_CACHE_TTL_MS
    };
    console.log("[UHDMovies] Sitemap entries: " + entries.length);
    return entries;
  }).catch(function(err) {
    console.error("[UHDMovies] Sitemap load error: " + err.message);
    return [];
  });
}
function searchSitemaps(title, year) {
  return loadSitemapEntries().then(function(entries) {
    var scored = entries.map(function(entry) {
      return {
        entry: entry,
        score: scoreSitemapEntry(entry, title, year)
      };
    }).filter(function(item) {
      return item.score >= 6;
    }).sort(function(a, b) {
      return b.score - a.score;
    }).slice(0, 8).map(function(item) {
      return {
        title: item.entry.title,
        rawTitle: item.entry.rawTitle,
        url: item.entry.url
      };
    });
    console.log("[UHDMovies] Sitemap matches: " + scored.length);
    return scored;
  });
}
function bypassHrefli(url) {
  var host = getBaseUrl(url);
  console.log("[UHDMovies] bypassHrefli: " + url);
  return fetchText(url).then(function(html) {
    var formUrl = extractFormAction(html);
    var formData = extractFormInputs(html);
    if (!formUrl) return Promise.resolve(null);
    return providerFetch(formUrl, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: toFormEncoded(formData)
    }).then(function(res) {
      return res.text();
    });
  }).then(function(html) {
    if (!html) return null;
    var formUrl = extractFormAction(html);
    var formData = extractFormInputs(html);
    if (!formUrl) return null;
    return providerFetch(formUrl, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: toFormEncoded(formData)
    }).then(function(res) {
      return res.text().then(function(t) {
        return { html: t, formData };
      });
    });
  }).then(function(result) {
    if (!result) return null;
    var script = extractScriptContaining(result.html, "?go=");
    var skTokenM = script.match(/\?go=([^"]+)/);
    if (!skTokenM) return null;
    var skToken = skTokenM[1];
    var wpHttp2 = result.formData["_wp_http2"] || "";
    return fetchText(host + "?go=" + skToken, {
      "Cookie": skToken + "=" + wpHttp2
    });
  }).then(function(html) {
    if (!html) return null;
    var driveUrl = extractMetaRefresh(html);
    return driveUrl || null;
  }).then(function(driveUrl) {
    if (!driveUrl) return null;
    return fetchText(driveUrl).then(function(html) {
      var pathM = html.match(/replace\("([^"]+)"\)/);
      if (!pathM || pathM[1] === "/404") return null;
      return fixUrl(pathM[1], getBaseUrl(driveUrl));
    });
  }).catch(function(err) {
    console.error("[UHDMovies] bypassHrefli error: " + err.message);
    return null;
  });
}
function extractVideoSeed(finallink) {
  console.log("[UHDMovies] VideoSeed: " + finallink);
  var hostM = finallink.match(/^https?:\/\/([^\/]+)/);
  var host = hostM ? hostM[1] : "video-seed.xyz";
  var tokenParts = finallink.split("?url=");
  if (tokenParts.length < 2) return Promise.resolve(null);
  var token = tokenParts[1];
  return providerFetch("https://" + host + "/api", {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      "x-token": host,
      "Referer": finallink
    },
    body: "keys=" + encodeURIComponent(token)
  }).then(function(res) {
    return res.text();
  }).then(function(text) {
    var m = text.match(/url":"([^"]+)"/);
    return m ? m[1].replace(/\\\//g, "/") : null;
  }).catch(function(err) {
    console.error("[UHDMovies] VideoSeed error: " + err.message);
    return null;
  });
}
function extractInstantLink(finallink) {
  console.log("[UHDMovies] InstantLink: " + finallink);
  var hostM = finallink.match(/^https?:\/\/([^\/]+)/);
  var host = hostM ? hostM[1] : finallink.indexOf("video-leech") !== -1 ? "video-leech.pro" : "video-seed.pro";
  var tokenParts = finallink.split("url=");
  if (tokenParts.length < 2) return Promise.resolve(null);
  var token = tokenParts[1];
  return providerFetch("https://" + host + "/api", {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      "x-token": host,
      "Referer": finallink
    },
    body: "keys=" + encodeURIComponent(token)
  }).then(function(res) {
    return res.text();
  }).then(function(text) {
    var m = text.match(/url":"([^"]+)"/);
    return m ? m[1].replace(/\\\//g, "/") : null;
  }).catch(function(err) {
    console.error("[UHDMovies] InstantLink error: " + err.message);
    return null;
  });
}
function extractResumeBot(url) {
  console.log("[UHDMovies] ResumeBot: " + url);
  return fetchText(url).then(function(html) {
    var tokenM = html.match(/formData\.append\('token', '([a-f0-9]+)'\)/);
    var pathM = html.match(/fetch\('\/download\?id=([a-zA-Z0-9\/+]+)'/);
    if (!tokenM || !pathM) return null;
    var token = tokenM[1];
    var path = pathM[1];
    var baseUrl = url.split("/download")[0];
    return providerFetch(baseUrl + "/download?id=" + path, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "*/*",
        "Origin": baseUrl,
        "Referer": url
      },
      body: "token=" + encodeURIComponent(token)
    });
  }).then(function(res) {
    if (!res) return null;
    return res.text();
  }).then(function(text) {
    if (!text) return null;
    try {
      var json = JSON.parse(text);
      return json.url && json.url.indexOf("http") === 0 ? json.url : null;
    } catch (e) {
      return null;
    }
  }).catch(function(err) {
    console.error("[UHDMovies] ResumeBot error: " + err.message);
    return null;
  });
}
function extractCFType1(url) {
  console.log("[UHDMovies] CFType1: " + url);
  return fetchText(url + "?type=1").then(function(html) {
    return extractBtnSuccessLinks(html);
  }).catch(function(err) {
    console.error("[UHDMovies] CFType1 error: " + err.message);
    return [];
  });
}
function extractResumeCloudLink(baseUrl, path) {
  console.log("[UHDMovies] ResumeCloud: " + baseUrl + path);
  return fetchText(baseUrl + path).then(function(html) {
    var links = extractBtnSuccessLinks(html);
    return links.length ? links[0] : null;
  }).catch(function(err) {
    console.error("[UHDMovies] ResumeCloud error: " + err.message);
    return null;
  });
}
function extractDriveseedPage(url) {
  console.log("[UHDMovies] Driveseed: " + url);
  var streams = [];
  return Promise.resolve().then(function() {
    if (url.indexOf("r?key=") !== -1) {
      return fetchText(url).then(function(html) {
        var redirectM = html.match(/replace\("([^"]+)"\)/);
        if (!redirectM) return html;
        var base = getBaseUrl(url);
        return fetchText(base + redirectM[1]);
      });
    }
    return fetchText(url);
  }).then(function(html) {
    var baseDomain = getBaseUrl(url);
    var qualityText = extractFirstListGroupItem(html);
    var rawFileName = qualityText.replace("Name : ", "").trim();
    var fileName = cleanTitle(rawFileName);
    var size = extractThirdListItem(html).replace("Size : ", "").trim();
    var quality = buildQualityLabel(qualityText);
    var labelExtras = "";
    if (fileName) labelExtras += "[" + fileName + "]";
    if (size) labelExtras += "[" + size + "]";
    var textCenterLinks = extractTextCenterLinks(html);
    var promises = [];
    textCenterLinks.forEach(function(item) {
      var text = (item.text || "").toLowerCase();
      var href = item.href;
      if (!href) return;
      if (text.indexOf("instant download") !== -1) {
        promises.push(
          extractInstantLink(href).then(function(link) {
            if (link) streams.push({ name: "UHDMovies", title: "Driveseed Instant " + labelExtras, url: link, quality });
          })
        );
      } else if (text.indexOf("resume worker bot") !== -1) {
        promises.push(
          extractResumeBot(href).then(function(link) {
            if (link) streams.push({ name: "UHDMovies", title: "Driveseed ResumeBot " + labelExtras, url: link, quality });
          })
        );
      } else if (text.indexOf("direct links") !== -1) {
        promises.push(
          extractCFType1(baseDomain + href).then(function(links) {
            links.forEach(function(link) {
              streams.push({ name: "UHDMovies", title: "Driveseed Direct " + labelExtras, url: link, quality });
            });
          })
        );
      } else if (text.indexOf("resume cloud") !== -1) {
        promises.push(
          extractResumeCloudLink(baseDomain, href).then(function(link) {
            if (link) streams.push({ name: "UHDMovies", title: "Driveseed ResumeCloud " + labelExtras, url: link, quality });
          })
        );
      } else if (text.indexOf("cloud download") !== -1) {
        streams.push({ name: "UHDMovies", title: "Driveseed Cloud " + labelExtras, url: href, quality });
      }
    });
    return Promise.all(promises).then(function() {
      return streams;
    });
  }).catch(function(err) {
    console.error("[UHDMovies] Driveseed error: " + err.message);
    return [];
  });
}
function getMovieLinks(pageUrl) {
  console.log("[UHDMovies] Movie links: " + pageUrl);
  return fetchText(pageUrl).then(function(html) {
    var links = [];
    var entryM = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*)/i);
    var entryHtml = entryM ? entryM[1] : html;
    var parts = entryHtml.split(/<\/?p(?:\s[^>]*)?\s*>/i);
    for (var i = 0; i < parts.length; i++) {
      if (!/\[.*\]/.test(parts[i])) continue;
      var sourceName = stripTags(parts[i]).split("Download")[0].trim();
      for (var j = i + 1; j < Math.min(i + 6, parts.length); j++) {
        var btnM = parts[j].match(/<a[^>]*class="[^"]*maxbutton-1[^"]*"[^>]*href="([^"]+)"/i) || parts[j].match(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*maxbutton-1[^"]*"/i);
        if (btnM) {
          links.push({ sourceName, sourceLink: btnM[1] });
          break;
        }
      }
    }
    console.log("[UHDMovies] Movie links found: " + links.length);
    return links;
  }).catch(function(err) {
    console.error("[UHDMovies] getMovieLinks error: " + err.message);
    return [];
  });
}
function getTvEpisodeLink(pageUrl, targetSeason, targetEpisode) {
  console.log("[UHDMovies] TV S" + targetSeason + "E" + targetEpisode + ": " + pageUrl);
  return fetchText(pageUrl).then(function(html) {
    var links = [];
    var blockRe = /<(p|div)(\s[^>]*)?>[\s\S]*?<\/\1>/gi;
    var prevDetails = "";
    var currentSeason = 1;
    var m;
    while ((m = blockRe.exec(html)) !== null) {
      var blockHtml = m[0];
      var blockText = stripTags(blockHtml);
      var hasEpisodeLink = /episode/i.test(blockHtml) && /<a\b/i.test(blockHtml);
      if (hasEpisodeLink) {
        var seasonM = prevDetails.match(/(?:Season\s+|S0?)(\d+)/i);
        if (seasonM) currentSeason = parseInt(seasonM[1]);
        if (currentSeason === targetSeason) {
          var episodeLinks = [];
          var aRe = /<a\b[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/gi;
          var aM;
          while ((aM = aRe.exec(blockHtml)) !== null) {
            if (/episode/i.test(aM[0])) episodeLinks.push(aM[1]);
          }
          if (targetEpisode <= episodeLinks.length && targetEpisode >= 1) {
            var link = episodeLinks[targetEpisode - 1];
            var sizeM = prevDetails.match(/(\d+(?:\.\d+)?\s*(?:MB|GB))/i);
            links.push({
              sourceLink: link,
              quality: buildQualityLabel(prevDetails),
              size: sizeM ? sizeM[1] : null,
              details: prevDetails
            });
          }
        }
        currentSeason++;
      }
      prevDetails = blockText;
    }
    console.log("[UHDMovies] Episode links found: " + links.length);
    return links;
  }).catch(function(err) {
    console.error("[UHDMovies] getTvEpisodeLink error: " + err.message);
    return [];
  });
}
function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[UHDMovies] getStreams " + mediaType + " " + tmdbId);
  var allStreams = [];
  return getTmdbDetails(tmdbId, mediaType).then(function(tmdbDetails) {
    if (!tmdbDetails) return [];
    console.log("[UHDMovies] Title: " + tmdbDetails.title + " (" + tmdbDetails.year + ")");
    return searchByTitle(tmdbDetails.title, tmdbDetails.year);
  }).then(function(searchResults) {
    if (!searchResults || searchResults.length === 0) {
      console.log("[UHDMovies] No search results");
      return [];
    }
    var isSeries = mediaType === "series" || mediaType === "tv";
    function processResult(index) {
      if (index >= searchResults.length) return Promise.resolve(allStreams);
      var result = searchResults[index];
      console.log("[UHDMovies] Processing: " + result.title);
      var linksPromise = isSeries && season && episode ? getTvEpisodeLink(result.url, season, episode) : getMovieLinks(result.url);
      return linksPromise.then(function(links) {
        var extractPromises = links.map(function(linkData) {
          var sourceLink = linkData.sourceLink;
          if (!sourceLink) return Promise.resolve([]);
          var finalLinkPromise = sourceLink.indexOf("unblockedgames") !== -1 ? bypassHrefli(sourceLink) : Promise.resolve(sourceLink);
          return finalLinkPromise.then(function(finalLink) {
            if (!finalLink) return [];
            if (finalLink.indexOf("driveseed") !== -1 || finalLink.indexOf("driveleech") !== -1) {
              return extractDriveseedPage(finalLink);
            }
            if (finalLink.indexOf("video-seed") !== -1) {
              return extractVideoSeed(finalLink).then(function(url) {
                if (!url) return [];
                return [{ name: "UHDMovies", title: "UHDMovies " + (linkData.quality || "Unknown"), url, quality: linkData.quality || "Unknown" }];
              });
            }
            return [{
              name: "UHDMovies",
              title: "UHDMovies " + (linkData.sourceName || linkData.quality || ""),
              url: finalLink,
              quality: linkData.quality || "Unknown"
            }];
          });
        });
        return Promise.all(extractPromises).then(function(results) {
          results.forEach(function(streams) {
            allStreams = allStreams.concat(streams);
          });
          return processResult(index + 1);
        });
      });
    }
    return processResult(0).then(function(streams) {
      function scoreStream(s) {
        var q = s.quality || "";
        var rScore = 0;
        if (/^4K/i.test(q))    rScore = 4;
        else if (/1080p/i.test(q)) rScore = 3;
        else if (/720p/i.test(q))  rScore = 2;
        else if (/480p/i.test(q))  rScore = 1;
        var sScore = 0;
        if (/remux/i.test(q))       sScore = 5;
        else if (/blu.?ray/i.test(q)) sScore = 4;
        else if (/web.?dl/i.test(q))  sScore = 3;
        else if (/webrip/i.test(q))   sScore = 2;
        else if (/hdrip|dvdrip|hdtv/i.test(q)) sScore = 1;
        return rScore * 10 + sScore;
      }
      streams.sort(function(a, b) { return scoreStream(b) - scoreStream(a); });
      return streams;
    });
  }).catch(function(err) {
    console.error("[UHDMovies] Error: " + err.message);
    return [];
  });
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}
