/**
 * PlayIMDb - Hardened with WebStreamr-style direct extraction
 *
 * Improvements over previous version:
 * - Per-fetch AbortController timeouts (no hangs on slow upstream)
 * - Multiple vsembed/vidsrc domain fallback with random rotation
 * - Random X-Forwarded-For / Client IP to bypass IP-based blocks
 * - Primary direct-extraction path (server data-hash -> /rcp/<hash> -> m3u8)
 *   eliminates dependency on enc-dec.app for the common CloudStream Pro server
 * - enc-dec.app retained as fallback only when direct extraction fails
 */

const TMDB_API_KEY = '1b3113663c9004682ed61086cf967c44';
const TMDB_BASE = 'https://api.themoviedb.org/3';

// Domain pool (matches WebStreamrMBG VidSrc extractor list, plus vsembed legacy)
const VSEMBED_DOMAINS = [
    'vsembed.ru',
    'vsembed.su',
    'vidsrcme.ru',
    'vidsrcme.su',
    'vidsrc-me.ru',
    'vidsrc-me.su',
    'vsrc.su'
];

// Per-fetch timeouts (much smaller than the overall provider timeout so a single
// stuck upstream cannot exhaust the whole budget)
const FETCH_TIMEOUT_MS = 6000;
const TMDB_FETCH_TIMEOUT_MS = 4000;
const ENC_DEC_TIMEOUT_MS = 8000;

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function randomIp() {
    return `${Math.floor(Math.random() * 223) + 1}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
}

function shuffle(arr) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

async function safeFetch(url, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : FETCH_TIMEOUT_MS;
    const baseHeaders = {
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
        ...(options.headers || {})
    };

    if (typeof fetchv2 === 'function') {
        try {
            const method = options.method || 'GET';
            const body = options.body || null;
            return await fetchv2(url, baseHeaders, method, body, true, options.encoding || 'utf-8');
        } catch (e) {
            console.error('[PlayIMDb] fetchv2 failed:', url, e.message);
        }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
    try {
        const fetchOpts = {
            method: options.method || 'GET',
            headers: baseHeaders,
            signal: controller.signal
        };
        if (options.body !== undefined && options.body !== null) {
            fetchOpts.body = options.body;
        }
        return await fetch(url, fetchOpts);
    } catch (e) {
        console.error(`[PlayIMDb] fetch failed (${url}): ${e.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function toQualityLabel(text) {
    const val = String(text || '').toLowerCase();
    if (val.includes('2160') || val.includes('4k')) return '2160p';
    if (val.includes('1440')) return '1440p';
    if (val.includes('1080')) return '1080p';
    if (val.includes('720')) return '720p';
    return 'HD';
}

function detectLanguage(url) {
    const lowUrl = String(url || '').toLowerCase();
    if (lowUrl.includes('_hi') || lowUrl.includes('hindi')) return 'HN';
    if (lowUrl.includes('_ta') || lowUrl.includes('tamil')) return 'TM';
    if (lowUrl.includes('_te') || lowUrl.includes('telugu')) return 'TL';
    return 'EN';
}

async function getTMDBInfo(id, type) {
    let url = `${TMDB_BASE}/${type === 'tv' ? 'tv' : 'movie'}/${id}?api_key=${TMDB_API_KEY}`;

    if (String(id).startsWith('tt')) {
        url = `${TMDB_BASE}/find/${id}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
        const res = await safeFetch(url, { timeoutMs: TMDB_FETCH_TIMEOUT_MS });
        const data = res && res.ok ? await res.json() : null;
        if (data) {
            const result = (type === 'tv' ? data.tv_results[0] : data.movie_results[0]);
            if (result) {
                return {
                    title: result.title || result.name,
                    year: (result.release_date || result.first_air_date || '').split('-')[0],
                    imdbId: id
                };
            }
        }
    }

    const res = await safeFetch(url, { timeoutMs: TMDB_FETCH_TIMEOUT_MS });
    const data = res && res.ok ? await res.json() : null;
    if (!data) return null;

    const info = {
        title: data.title || data.name,
        year: (data.release_date || data.first_air_date || '').split('-')[0],
        imdbId: data.imdb_id || id
    };

    if (!info.imdbId && type === 'tv') {
        const extRes = await safeFetch(`${TMDB_BASE}/tv/${id}/external_ids?api_key=${TMDB_API_KEY}`, { timeoutMs: TMDB_FETCH_TIMEOUT_MS });
        const ext = extRes && extRes.ok ? await extRes.json() : null;
        if (ext) info.imdbId = ext.imdb_id;
    }
    return info;
}

/**
 * WebStreamr-style direct extraction:
 *   1. Fetch /embed page, find #player_iframe + .server[data-hash] for CloudStream Pro
 *   2. Fetch <iframeOrigin>/rcp/<dataHash> with Referer: domain origin
 *   3. Extract src:'...' pattern from that iframe HTML
 *   4. Fetch resolved player URL, extract `(https://.*?{v\d}.*?) or` pattern
 *   5. Replace {v\d} with iframe.host -> direct m3u8 URL
 */
async function tryDirectExtraction(domain, embedPath, ipHeader) {
    const newUrl = `https://${domain}${embedPath}`;
    const headers = {
        'X-Forwarded-For': ipHeader,
        'Client-IP': ipHeader,
        Referer: `https://${domain}/`
    };

    const pageRes = await safeFetch(newUrl, { headers });
    const pageHtml = pageRes && pageRes.ok ? await pageRes.text() : '';
    if (!pageHtml) return { html: '', streams: [] };

    // Strip HTML comments (server entries are sometimes commented out)
    const cleanedHtml = pageHtml.replace(/<!--/g, '').replace(/-->/g, '');

    // Extract iframe URL
    const iframeMatch = cleanedHtml.match(/iframe\s+id=["']player_iframe["']\s+src=["']([^"']+)["']/i)
        || cleanedHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    if (!iframeMatch) return { html: cleanedHtml, streams: [] };

    let iframeUrlStr = iframeMatch[1];
    if (iframeUrlStr.startsWith('//')) iframeUrlStr = `https:${iframeUrlStr}`;
    else if (iframeUrlStr.startsWith('/')) iframeUrlStr = `https://${domain}${iframeUrlStr}`;

    let iframeUrl;
    try { iframeUrl = new URL(iframeUrlStr); } catch { return { html: cleanedHtml, streams: [] }; }

    // Extract title
    const titleMatch = cleanedHtml.match(/<title>([^<]+)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].trim() : '';

    // Find .server elements with data-hash, prefer CloudStream Pro
    const serverRegex = /<[a-zA-Z]+[^>]*class=["'][^"']*\bserver\b[^"']*["'][^>]*\bdata-hash=["']([^"']+)["'][^>]*>([^<]+)</gi;
    const servers = [];
    let m;
    while ((m = serverRegex.exec(cleanedHtml)) !== null) {
        servers.push({ dataHash: m[1], serverName: m[2].trim() });
    }
    // Also try alternate ordering
    if (servers.length === 0) {
        const altRegex = /<[a-zA-Z]+[^>]*\bdata-hash=["']([^"']+)["'][^>]*class=["'][^"']*\bserver\b[^"']*["'][^>]*>([^<]+)</gi;
        while ((m = altRegex.exec(cleanedHtml)) !== null) {
            servers.push({ dataHash: m[1], serverName: m[2].trim() });
        }
    }

    if (servers.length === 0) return { html: cleanedHtml, streams: [], iframeUrl };

    // Prefer CloudStream Pro, then any server
    const preferred = servers.filter((s) => s.serverName.toLowerCase().includes('cloudstream'));
    const targets = preferred.length > 0 ? preferred : servers;

    const streams = [];
    const seen = new Set();

    for (const { serverName, dataHash } of targets) {
        try {
            const rcpUrl = `${iframeUrl.origin}/rcp/${dataHash}`;
            const rcpRes = await safeFetch(rcpUrl, { headers: { Referer: `https://${domain}/`, 'X-Forwarded-For': ipHeader } });
            const rcpHtml = rcpRes && rcpRes.ok ? await rcpRes.text() : '';
            if (!rcpHtml) continue;

            const srcMatch = rcpHtml.match(/src\s*:\s*['"]([^'"]+)['"]/);
            if (!srcMatch) continue;

            let playerUrlStr = srcMatch[1];
            if (playerUrlStr.startsWith('//')) playerUrlStr = `https:${playerUrlStr}`;
            else if (playerUrlStr.startsWith('/')) playerUrlStr = `${iframeUrl.origin}${playerUrlStr}`;

            const playerRes = await safeFetch(playerUrlStr, { headers: { Referer: rcpUrl, 'X-Forwarded-For': ipHeader } });
            const playerHtml = playerRes && playerRes.ok ? await playerRes.text() : '';
            if (!playerHtml) continue;

            // WebStreamr pattern: `(https:\/\/.*?{v\d}.*?) or`
            const fileMatch = playerHtml.match(/(https:\/\/[^\s'"`]*?\{v\d\}[^\s'"`]*?)\s+or\b/);
            if (fileMatch) {
                const m3u8Url = fileMatch[1].replace(/\{v\d\}/, iframeUrl.host);
                const quality = toQualityLabel(m3u8Url);
                const lang = detectLanguage(m3u8Url);
                const dedup = `${quality}-${lang}-${m3u8Url}`;
                if (!seen.has(dedup)) {
                    seen.add(dedup);
                    streams.push({
                        name: `PlayIMDb | ${quality} | ${serverName}`,
                        title: pageTitle ? `${pageTitle}\n[${lang}] Direct Stream` : `[${lang}] Direct Stream`,
                        url: m3u8Url,
                        quality,
                        headers: { Referer: `${iframeUrl.origin}/` },
                        provider: 'playimdb'
                    });
                }
                continue;
            }

            // Fallback: look for direct .m3u8 URLs in player HTML
            const directM3u8 = playerHtml.match(/https?:\/\/[^\s'"`<>]+\.m3u8[^\s'"`<>]*/g);
            if (directM3u8) {
                for (const url of directM3u8) {
                    const quality = toQualityLabel(url);
                    const lang = detectLanguage(url);
                    const dedup = `${quality}-${lang}-${url}`;
                    if (!seen.has(dedup)) {
                        seen.add(dedup);
                        streams.push({
                            name: `PlayIMDb | ${quality} | ${serverName}`,
                            title: pageTitle ? `${pageTitle}\n[${lang}] Direct Stream` : `[${lang}] Direct Stream`,
                            url,
                            quality,
                            headers: { Referer: `${iframeUrl.origin}/` },
                            provider: 'playimdb'
                        });
                    }
                }
            }
        } catch (e) {
            console.error(`[PlayIMDb] Direct extraction failed for ${serverName}: ${e.message}`);
        }
    }

    return { html: cleanedHtml, streams, iframeUrl };
}

/**
 * Legacy enc-dec.app fallback path (existing logic, kept as last resort)
 */
async function tryEncDecExtraction(domain, embedPath, mediaTitle, movieTitle, ipHeader) {
    const playUrl = `https://${domain}${embedPath}`;
    const headers = { 'X-Forwarded-For': ipHeader, Referer: `https://${domain}/` };

    const pageRes = await safeFetch(playUrl, { headers });
    const pageHtml = pageRes && pageRes.ok ? await pageRes.text() : '';
    if (!pageHtml) return [];

    const iframeMatch = pageHtml.match(/iframe\s+id=["']player_iframe["']\s+src=["']([^"']+)["']/i)
        || pageHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    if (!iframeMatch) return [];

    const iframeSrc = iframeMatch[1];
    const cloudBase = iframeSrc.startsWith('//')
        ? `https:${iframeSrc}`
        : (iframeSrc.startsWith('/') ? `https://${domain}${iframeSrc}` : iframeSrc);

    const cloudRes = await safeFetch(cloudBase, { headers: { Referer: playUrl, 'X-Forwarded-For': ipHeader } });
    const cloudHtml = cloudRes && cloudRes.ok ? await cloudRes.text() : '';
    if (!cloudHtml) return [];

    const prorcpPath = (cloudHtml.match(/src\s*:\s*['"](\/prorcp\/[^'"]+)['"]/) || [])[1];
    if (!prorcpPath) return [];

    const prorcpUrl = new URL(cloudBase).origin + prorcpPath;
    const finalRes = await safeFetch(prorcpUrl, { headers: { Referer: cloudBase, 'X-Forwarded-For': ipHeader } });
    const finalHtml = finalRes && finalRes.ok ? await finalRes.text() : '';
    if (!finalHtml) return [];

    const hidden = finalHtml.match(/<div id="([^"]+)"[^>]*style=["']display\s*:\s*none;?["'][^>]*>([a-zA-Z0-9:\/.,{}\-_=+ ]+)<\/div>/);
    if (!hidden) return [];

    const decRes = await safeFetch('https://enc-dec.app/api/dec-cloudnestra', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: hidden[2], div_id: hidden[1] }),
        timeoutMs: ENC_DEC_TIMEOUT_MS
    });
    const decJson = decRes && decRes.ok ? await decRes.json() : null;
    const urls = decJson && Array.isArray(decJson.result) ? [...new Set(decJson.result)] : [];
    if (urls.length === 0) return [];

    const streams = [];
    const seen = new Set();
    for (const url of urls) {
        const quality = toQualityLabel(url);
        const lang = detectLanguage(url);
        const dedup = `${quality}-${lang}`;
        if (!seen.has(dedup)) {
            seen.add(dedup);
            streams.push({
                name: `${movieTitle} | ${quality} | Server ${streams.length + 1}`,
                title: `${mediaTitle}\n[${lang}] Direct Stream`,
                url,
                quality,
                headers: { Referer: 'https://cloudnestra.com/' },
                provider: 'playimdb'
            });
        }
    }
    return streams;
}

async function resolveDirectStreams(media, type, season, episode) {
    const imdbId = media.imdbId;
    if (!imdbId) return [];

    const seStr = type === 'tv' ? ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : '';
    const movieTitle = media.title || 'Unknown';
    const mediaTitle = `${movieTitle} (${media.year || 'N/A'})${seStr}`;

    // For TV, use direct episode-level path; vsembed/vidsrc support both forms
    const embedPath = type === 'tv' && season && episode
        ? `/embed/tv/${imdbId}/${season}-${episode}`
        : `/embed/${imdbId}/`;
    const ipHeader = randomIp();

    // Try domains in random order to spread load and bypass blocks
    const domains = shuffle(VSEMBED_DOMAINS);
    for (const domain of domains) {
        try {
            const direct = await tryDirectExtraction(domain, embedPath, ipHeader);
            if (direct.streams.length > 0) {
                console.log(`[PlayIMDb] Direct extraction succeeded on ${domain}: ${direct.streams.length} streams`);
                return direct.streams;
            }

            // If direct extraction couldn't even fetch the page, try next domain
            if (!direct.html) continue;

            // Page loaded but direct extraction yielded no streams — try enc-dec.app fallback
            const fallback = await tryEncDecExtraction(domain, embedPath, mediaTitle, movieTitle, ipHeader);
            if (fallback.length > 0) {
                console.log(`[PlayIMDb] Fallback enc-dec extraction succeeded on ${domain}: ${fallback.length} streams`);
                return fallback;
            }
        } catch (e) {
            console.error(`[PlayIMDb] Domain ${domain} failed: ${e.message}`);
        }
    }

    console.log('[PlayIMDb] All domains exhausted, no streams found');
    return [];
}

async function getStreams(tmdbId, type, season, episode) {
    try {
        const media = await getTMDBInfo(tmdbId, type);
        const finalMedia = media || { title: 'Unknown', year: 'N/A', imdbId: tmdbId };
        return await resolveDirectStreams(finalMedia, type, season, episode);
    } catch (e) {
        console.error(`[PlayIMDb] getStreams error: ${e.message}`);
        return [];
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getStreams };
} else {
    global.getStreams = getStreams;
}
