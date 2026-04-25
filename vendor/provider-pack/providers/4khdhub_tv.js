/**
 * 4khdhub - Built from src/4khdhub/
 * Generated: 2025-12-31T21:33:16.718Z
 */
"use strict";
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/4khdhub/constants.js
var BASE_URL = "https://4khdhub.dad";
var TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";
var DOMAINS_URL = "https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json";

// src/4khdhub/utils.js
var domainCache = { url: BASE_URL, ts: 0 };
function fetchLatestDomain() {
  return __async(this, null, function* () {
    const now = Date.now();
    if (now - domainCache.ts < 36e5) return domainCache.url;
    try {
      const response = yield fetch(DOMAINS_URL);
      const data = yield response.json();
      if (data && data["4khdhub"]) {
        domainCache.url = data["4khdhub"];
        domainCache.ts = now;
      }
    } catch (e) {}
    return domainCache.url;
  });
}

// src/4khdhub/http.js
function fetchText(_0) {
  return __async(this, arguments, function* (url, options = {}) {
    try {
      const response = yield fetch(url, {
        headers: __spreadValues({
          "User-Agent": USER_AGENT
        }, options.headers)
      });
      return yield response.text();
    } catch (err) {
      console.log(`[4KHDHub] Request failed for ${url}: ${err.message}`);
      return null;
    }
  });
}
function decodeHtmlEntities(value) {
  return String(value || "").replace(/&#(\d+);/g, (_, code) => {
    const num = parseInt(code, 10);
    return Number.isFinite(num) ? String.fromCharCode(num) : "";
  }).replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// src/4khdhub/tmdb.js
function getTmdbDetails(tmdbId, type) {
  return __async(this, null, function* () {
    const isSeries = type === "series" || type === "tv";
    const endpoint = isSeries ? "tv" : "movie";
    const url = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=alternative_titles`;
    console.log(`[4KHDHub] Fetching TMDB details from: ${url}`);
    const buildApiResult = (data) => {
      if (!data)
        return null;
      const title = isSeries ? data.name : data.title;
      if (!title)
        return null;
      return {
        title,
        originalTitle: isSeries ? data.original_name || null : data.original_title || null,
        alternativeTitles: data.alternative_titles && Array.isArray(data.alternative_titles.titles) ? data.alternative_titles.titles.slice().sort((left, right) => {
          const score = (entry) => entry && entry.iso_3166_1 === "IN" ? 0 : entry && entry.iso_3166_1 === "US" ? 1 : 2;
          return score(left) - score(right);
        }).map((entry) => entry && entry.title).filter(Boolean) : [],
        year: isSeries ? data.first_air_date ? parseInt(data.first_air_date.split("-")[0]) : 0 : data.release_date ? parseInt(data.release_date.split("-")[0]) : 0
      };
    };
    const parseTmdbPageFallback = (html) => {
      if (!html)
        return null;
      let title = null;
      let originalTitle = null;
      let year = 0;
      const scriptMatches = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi) || [];
      scriptMatches.some((scriptTag) => {
        const match = scriptTag.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
        if (!match || !match[1])
          return false;
        try {
          const parsed = JSON.parse(decodeHtmlEntities(match[1]).trim());
          const parsedType = String(parsed && parsed["@type"] || "");
          if (parsedType && parsedType !== "TVSeries" && parsedType !== "Movie")
            return false;
          title = parsed && parsed.name ? String(parsed.name).trim() : title;
          originalTitle = parsed && parsed.alternateName ? String(parsed.alternateName).trim() : originalTitle;
          const dateStr = parsed && (parsed.datePublished || parsed.startDate);
          if (dateStr) {
            const yearMatch = String(dateStr).match(/\b(19|20)\d{2}\b/);
            if (yearMatch)
              year = parseInt(yearMatch[0], 10);
          }
          return !!title;
        } catch (_error) {
          return false;
        }
      });
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      if (!title && titleMatch && titleMatch[1]) {
        title = decodeHtmlEntities(titleMatch[1]).replace(/\s+—\s+The Movie Database.*$/i, "").replace(/\s+\((?:TV Series|Movie)[^)]+\)\s*$/i, "").trim();
      }
      if (!year && titleMatch && titleMatch[1]) {
        const yearMatch = decodeHtmlEntities(titleMatch[1]).match(/\b(19|20)\d{2}\b/);
        if (yearMatch)
          year = parseInt(yearMatch[0], 10);
      }
      return title ? {
        title,
        originalTitle: originalTitle || null,
        alternativeTitles: [],
        year: year || 0
      } : null;
    };
    const tryApi = (attempt = 0) => __async(this, null, function* () {
      try {
        const response = yield fetch(url);
        const data = yield response.json();
        const result = buildApiResult(data);
        if (result && result.title)
          return result;
      } catch (error) {
        console.log(`[4KHDHub] TMDB request failed: ${error.message}`);
      }
      if (attempt >= 1)
        return null;
      return yield tryApi(attempt + 1);
    });
    const apiResult = yield tryApi();
    if (apiResult && apiResult.title)
      return apiResult;
    const pageUrl = `https://www.themoviedb.org/${endpoint}/${tmdbId}`;
    console.log(`[4KHDHub] TMDB page fallback: ${pageUrl}`);
    const html = yield fetchText(pageUrl, {
      Referer: "https://www.themoviedb.org/"
    });
    const fallbackResult = parseTmdbPageFallback(html);
    if (fallbackResult && fallbackResult.title) {
      console.log(`[4KHDHub] TMDB page fallback resolved: ${fallbackResult.title} (${fallbackResult.year || "N/A"})`);
    }
    return fallbackResult;
  });
}
function normalizeTitleCandidate(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
function getTitleCandidates(details) {
  const seen = /* @__PURE__ */ new Set();
  const values = [details.title, details.originalTitle, ...(details.alternativeTitles || [])];
  const candidates = [];
  for (const value of values) {
    const candidate = normalizeTitleCandidate(value);
    if (!candidate || candidate.length < 4)
      continue;
    if (!/^[\x20-\x7E]+$/.test(candidate))
      continue;
    const key = candidate.toLowerCase();
    if (seen.has(key))
      continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates.length ? candidates : [details.title];
}

// src/4khdhub/utils.js
function atob(input) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  let str = String(input).replace(/=+$/, "");
  if (str.length % 4 === 1) {
    throw new Error("'atob' failed: The string to be decoded is not correctly encoded.");
  }
  let output = "";
  for (let bc = 0, bs, buffer, i = 0; buffer = str.charAt(i++); ~buffer && (bs = bc % 4 ? bs * 64 + buffer : buffer, bc++ % 4) ? output += String.fromCharCode(255 & bs >> (-2 * bc & 6)) : 0) {
    buffer = chars.indexOf(buffer);
  }
  return output;
}
function rot13Cipher(str) {
  return str.replace(/[a-zA-Z]/g, function(c) {
    return String.fromCharCode((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26);
  });
}
function levenshteinDistance(s, t) {
  if (s === t)
    return 0;
  const n = s.length;
  const m = t.length;
  if (n === 0)
    return m;
  if (m === 0)
    return n;
  const d = [];
  for (let i = 0; i <= n; i++) {
    d[i] = [];
    d[i][0] = i;
  }
  for (let j = 0; j <= m; j++) {
    d[0][j] = j;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = s.charAt(i - 1) === t.charAt(j - 1) ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[n][m];
}
function normalizeSearchTitle(value) {
  return String(value || "").replace(/\[[^\]]*]/g, " ").replace(/\s+-\s+[A-Z0-9]{2,10}\b/g, " ").replace(/[^a-z0-9]+/gi, " ").replace(/\s+/g, " ").trim().toLowerCase();
}
function parseBytes(val) {
  if (typeof val === "number")
    return val;
  if (!val)
    return 0;
  const match = val.match(/^([0-9.]+)\s*([a-zA-Z]+)$/);
  if (!match)
    return 0;
  const num = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  let multiplier = 1;
  if (unit.indexOf("k") === 0)
    multiplier = 1024;
  else if (unit.indexOf("m") === 0)
    multiplier = 1024 * 1024;
  else if (unit.indexOf("g") === 0)
    multiplier = 1024 * 1024 * 1024;
  else if (unit.indexOf("t") === 0)
    multiplier = 1024 * 1024 * 1024 * 1024;
  return num * multiplier;
}
function formatBytes(val) {
  if (val === 0)
    return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  let i = Math.floor(Math.log(val) / Math.log(k));
  if (i < 0)
    i = 0;
  return parseFloat((val / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// src/4khdhub/search.js
var cheerio = require("cheerio-without-node-native");
function fetchPageUrl(name, year, isSeries) {
  return __async(this, null, function* () {
    const domain = yield fetchLatestDomain();
    const searchUrl = `${domain}/?s=${encodeURIComponent(name + " " + year)}`;
    console.log(`[4KHDHub] Search Request URL: ${searchUrl}`);
    const html = yield fetchText(searchUrl);
    if (!html) {
      console.log("[4KHDHub] Search failed: No HTML response");
      return null;
    }
    const $ = cheerio.load(html);
    const targetType = isSeries ? "Series" : "Movies";
    console.log(`[4KHDHub] Parsing search results for type: ${targetType}`);
    const matchingCards = $(".movie-card").filter((_, el) => {
      const hasFormat = $(el).find(`.movie-card-format:contains("${targetType}")`).length > 0;
      if (!hasFormat) {
      }
      return hasFormat;
    }).filter((_, el) => {
      const metaText = $(el).find(".movie-card-meta").text();
      const movieCardYear = parseInt(metaText);
      const yearMatch = !isNaN(movieCardYear) && Math.abs(movieCardYear - year) <= 1;
      if (!yearMatch) {
        console.log(`[4KHDHub] Skip: Year mismatch (${movieCardYear} vs ${year}) - ${$(el).find(".movie-card-title").text().trim()}`);
      }
      return yearMatch;
    }).filter((_, el) => {
      const movieCardTitle = $(el).find(".movie-card-title").text().replace(/\[.*?]/g, "").trim();
      const normalizedMovieCardTitle = normalizeSearchTitle(movieCardTitle);
      const normalizedName = normalizeSearchTitle(name);
      const prefixMatch = normalizedMovieCardTitle === normalizedName || normalizedMovieCardTitle.indexOf(normalizedName + " ") === 0 || normalizedName.indexOf(normalizedMovieCardTitle + " ") === 0;
      const distance = prefixMatch ? 0 : levenshteinDistance(normalizedMovieCardTitle, normalizedName);
      const match = distance < 5;
      console.log(`[4KHDHub] Checking: "${movieCardTitle}" (Dist: ${distance}) vs "${name}"`);
      return match;
    }).map((_, el) => {
      let href = $(el).attr("href");
      if (href && !href.startsWith("http")) {
        href = domain + (href.startsWith("/") ? "" : "/") + href;
      }
      return href;
    }).get();
    if (matchingCards.length === 0) {
      console.log("[4KHDHub] No matching cards found after filtering");
    } else {
      console.log(`[4KHDHub] Found ${matchingCards.length} matching cards`);
    }
    return matchingCards.length > 0 ? matchingCards[0] : null;
  });
}
function fetchFirstPageUrl(titleCandidates, year, isSeries) {
  return __async(this, null, function* () {
    for (let index = 0; index < titleCandidates.length; index++) {
      const candidate = titleCandidates[index];
      if (!candidate)
        continue;
      if (index > 0) {
        console.log(`[4KHDHub] Trying alternate title: ${candidate}`);
      }
      const pageUrl = yield fetchPageUrl(candidate, year, isSeries);
      if (pageUrl) {
        return { url: pageUrl, title: candidate };
      }
    }
    return null;
  });
}

// src/4khdhub/extractor.js
var cheerio2 = require("cheerio-without-node-native");
function resolveRedirectUrl(redirectUrl) {
  return __async(this, null, function* () {
    const redirectHtml = yield fetchText(redirectUrl);
    if (!redirectHtml)
      return null;
    try {
      const redirectDataMatch = redirectHtml.match(/'o','(.*?)'/);
      if (!redirectDataMatch)
        return null;
      const step1 = atob(redirectDataMatch[1]);
      const step2 = atob(step1);
      const step3 = rot13Cipher(step2);
      const step4 = atob(step3);
      const redirectData = JSON.parse(step4);
      if (redirectData && redirectData.o) {
        return atob(redirectData.o);
      }
    } catch (e) {
      console.log(`[4KHDHub] Error resolving redirect: ${e.message}`);
    }
    return null;
  });
}
function extractSourceResults($, el) {
  return __async(this, null, function* () {
    const localHtml = $(el).html();
    const sizeMatch = localHtml.match(/([\d.]+ ?[GM]B)/);
    const heightMatch = localHtml.match(/\d{3,}p/);
    const title = $(el).find(".file-title, .episode-file-title").text().trim();
    let height = heightMatch ? parseInt(heightMatch[0]) : 0;
    if (height === 0 && (title.includes("4K") || title.includes("4k") || localHtml.includes("4K") || localHtml.includes("4k"))) {
      height = 2160;
    }
    const meta = {
      bytes: sizeMatch ? parseBytes(sizeMatch[1]) : 0,
      height,
      title
    };
    const hubCloudLink = $(el).find("a").filter((_, a) => $(a).text().includes("HubCloud")).attr("href");
    if (hubCloudLink) {
      const resolved = yield resolveRedirectUrl(hubCloudLink);
      return { url: resolved, meta };
    }
    const hubDriveLink = $(el).find("a").filter((_, a) => $(a).text().includes("HubDrive")).attr("href");
    if (hubDriveLink) {
      const resolvedDrive = yield resolveRedirectUrl(hubDriveLink);
      if (resolvedDrive) {
        const hubDriveHtml = yield fetchText(resolvedDrive);
        if (hubDriveHtml) {
          const $2 = cheerio2.load(hubDriveHtml);
          const innerCloudLink = $2('a:contains("HubCloud")').attr("href");
          if (innerCloudLink) {
            return { url: innerCloudLink, meta };
          }
        }
      }
    }
    return null;
  });
}
function extractHubCloud(hubCloudUrl, baseMeta) {
  return __async(this, null, function* () {
    if (!hubCloudUrl)
      return [];
    const redirectHtml = yield fetchText(hubCloudUrl, { headers: { Referer: hubCloudUrl } });
    if (!redirectHtml)
      return [];
    const redirectUrlMatch = redirectHtml.match(/var url ?= ?'(.*?)'/);
    if (!redirectUrlMatch)
      return [];
    const finalLinksUrl = redirectUrlMatch[1];
    const linksHtml = yield fetchText(finalLinksUrl, { headers: { Referer: hubCloudUrl } });
    if (!linksHtml)
      return [];
    const $ = cheerio2.load(linksHtml);
    const results = [];
    const sizeText = $("#size").text();
    const titleText = $("title").text().trim();
    const currentMeta = __spreadProps(__spreadValues({}, baseMeta), {
      bytes: parseBytes(sizeText) || baseMeta.bytes,
      title: titleText || baseMeta.title
    });
    $("a").each((_, el) => {
      const text = $(el).text();
      const href = $(el).attr("href");
      if (!href)
        return;
      if (text.includes("FSL") || text.includes("Download File")) {
        results.push({
          source: "FSL",
          url: href,
          meta: currentMeta
        });
      } else if (text.includes("PixelServer")) {
        const pixelUrl = href.replace("/u/", "/api/file/");
        results.push({
          source: "PixelServer",
          url: pixelUrl,
          meta: currentMeta
        });
      }
    });
    return results;
  });
}

// src/4khdhub/index.js
var cheerio3 = require("cheerio-without-node-native");
function getStreams(tmdbId, type, season, episode) {
  return __async(this, null, function* () {
    const tmdbDetails = yield getTmdbDetails(tmdbId, type);
    if (!tmdbDetails)
      return [];
    const { title, year } = tmdbDetails;
    console.log(`[4KHDHub] Search: ${title} (${year})`);
    const isSeries = type === "series" || type === "tv";
    const pageMatch = yield fetchFirstPageUrl(getTitleCandidates(tmdbDetails), year, isSeries);
    const pageUrl = pageMatch == null ? void 0 : pageMatch.url;
    if (!pageUrl) {
      console.log("[4KHDHub] Page not found");
      return [];
    }
    if ((pageMatch == null ? void 0 : pageMatch.title) && pageMatch.title !== title) {
      console.log(`[4KHDHub] Matched alternate title: ${pageMatch.title}`);
    }
    console.log(`[4KHDHub] Found page: ${pageUrl}`);
    const html = yield fetchText(pageUrl);
    if (!html)
      return [];
    const $ = cheerio3.load(html);
    const itemsToProcess = [];
    if (isSeries && season && episode) {
      const seasonStr = "S" + String(season).padStart(2, "0");
      const episodeStr = "Episode-" + String(episode).padStart(2, "0");
      $(".episode-item").each((_, el) => {
        if ($(".episode-title", el).text().includes(seasonStr)) {
          const downloadItems = $(".episode-download-item", el).filter((_2, item) => $(item).text().includes(episodeStr));
          downloadItems.each((_2, item) => {
            itemsToProcess.push(item);
          });
        }
      });
    } else {
      $(".download-item").each((_, el) => {
        itemsToProcess.push(el);
      });
    }
    console.log(`[4KHDHub] Processing ${itemsToProcess.length} items`);
    const streamPromises = itemsToProcess.map((item) => __async(this, null, function* () {
      try {
        const sourceResult = yield extractSourceResults($, item);
        if (sourceResult && sourceResult.url) {
          console.log(`[4KHDHub] Extracting from HubCloud: ${sourceResult.url}`);
          const extractedLinks = yield extractHubCloud(sourceResult.url, sourceResult.meta);
          return extractedLinks.map((link) => ({
            name: `4KHDHub - ${link.source}${sourceResult.meta.height ? ` ${sourceResult.meta.height}p` : ""}`,
            title: `${link.meta.title}
${formatBytes(link.meta.bytes || 0)}`,
            url: link.url,
            quality: sourceResult.meta.height ? `${sourceResult.meta.height}p` : void 0,
            behaviorHints: {
              bingeGroup: `4khdhub-${link.source}`
            }
          }));
        }
        return [];
      } catch (err) {
        console.log(`[4KHDHub] Item processing error: ${err.message}`);
        return [];
      }
    }));
    const results = yield Promise.all(streamPromises);
    return results.reduce((acc, val) => acc.concat(val), []);
  });
}
module.exports = { getStreams };
