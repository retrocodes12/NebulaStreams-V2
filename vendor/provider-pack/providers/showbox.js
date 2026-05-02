// ShowBox Scraper for Nuvio Local Scrapers
// React Native compatible version - Promise-based approach only

// TMDB API Configuration
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// ShowBox API Configuration
const SHOWBOX_API_BASE = 'https://febapi.nuvioapp.space/api';
const TMDB_REQUEST_TIMEOUT_MS = 4000;
const SHOWBOX_API_TIMEOUT_MS = 22000;

// Working headers for ShowBox API
const WORKING_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Content-Type': 'application/json'
};

function getEnvString(name) {
    try {
        if (typeof process !== 'undefined' && process.env && process.env[name]) {
            return String(process.env[name]).trim();
        }
    } catch (e) {
        // ignore and fall through
    }
    return '';
}

// UI token (cookie) is provided by the host app via per-scraper settings (Plugin Screen)
function getUiToken(scraperSettings = null) {
    if (scraperSettings && scraperSettings.uiToken) {
        return String(scraperSettings.uiToken).trim();
    }

    try {
        // Prefer sandbox-injected globals
        if (typeof global !== 'undefined' && global.SCRAPER_SETTINGS && global.SCRAPER_SETTINGS.uiToken) {
            return String(global.SCRAPER_SETTINGS.uiToken);
        }
        if (typeof window !== 'undefined' && window.SCRAPER_SETTINGS && window.SCRAPER_SETTINGS.uiToken) {
            return String(window.SCRAPER_SETTINGS.uiToken);
        }
    } catch (e) {
        // ignore and fall through
    }
    const envToken = getEnvString('SHOWBOX_UI_TOKEN') || getEnvString('SHOWBOX_COOKIE');
    if (envToken) {
        return envToken;
    }
    return '';
}

// OSS Group is provided by the host app via per-scraper settings (Plugin Screen) - optional
function getOssGroup(scraperSettings = null) {
    if (scraperSettings && scraperSettings.ossGroup) {
        return String(scraperSettings.ossGroup).trim();
    }

    try {
        // Prefer sandbox-injected globals
        if (typeof global !== 'undefined' && global.SCRAPER_SETTINGS && global.SCRAPER_SETTINGS.ossGroup) {
            return String(global.SCRAPER_SETTINGS.ossGroup);
        }
        if (typeof window !== 'undefined' && window.SCRAPER_SETTINGS && window.SCRAPER_SETTINGS.ossGroup) {
            return String(window.SCRAPER_SETTINGS.ossGroup);
        }
    } catch (e) {
        // ignore and fall through
    }
    const envOssGroup = getEnvString('SHOWBOX_OSS_GROUP');
    if (envOssGroup) {
        return envOssGroup;
    }
    return null; // OSS group is optional
}

function decodeBase64Url(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);

    if (typeof atob === 'function') {
        return decodeURIComponent(Array.prototype.map.call(atob(padded), function (char) {
            return '%' + ('00' + char.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
    }

    if (typeof Buffer !== 'undefined' && Buffer.from) {
        return Buffer.from(padded, 'base64').toString('utf8');
    }

    throw new Error('No base64 decoder available');
}

function getJwtExpiryIso(token) {
    try {
        const payloadSegment = String(token || '').split('.')[1];

        if (!payloadSegment) {
            return 'unknown';
        }

        const payload = JSON.parse(decodeBase64Url(payloadSegment));

        if (!payload || typeof payload.exp !== 'number') {
            return 'unknown';
        }

        return new Date(payload.exp * 1000).toISOString();
    } catch (error) {
        return 'unknown';
    }
}

// Utility Functions
function getQualityFromName(qualityStr) {
    if (!qualityStr) return 'Unknown';

    const quality = qualityStr.toUpperCase();

    // Map API quality values to normalized format
    if (quality === 'ORG' || quality === 'ORIGINAL') return 'Original';
    if (quality === '4K' || quality === '2160P') return '4K';
    if (quality === '1440P' || quality === '2K') return '1440p';
    if (quality === '1080P' || quality === 'FHD') return '1080p';
    if (quality === '720P' || quality === 'HD') return '720p';
    if (quality === '480P' || quality === 'SD') return '480p';
    if (quality === '360P') return '360p';
    if (quality === '240P') return '240p';

    // Try to extract number from string and format consistently
    const match = qualityStr.match(/(\d{3,4})[pP]?/);
    if (match) {
        const resolution = parseInt(match[1]);
        if (resolution >= 2160) return '4K';
        if (resolution >= 1440) return '1440p';
        if (resolution >= 1080) return '1080p';
        if (resolution >= 720) return '720p';
        if (resolution >= 480) return '480p';
        if (resolution >= 360) return '360p';
        return '240p';
    }

    return 'Unknown';
}

function formatFileSize(sizeStr) {
    if (!sizeStr) return 'Unknown';

    // If it's already formatted (like "15.44 GB" or "224.39 MB"), return as is
    if (typeof sizeStr === 'string' && (sizeStr.includes('GB') || sizeStr.includes('MB') || sizeStr.includes('KB'))) {
        return sizeStr;
    }

    // If it's a number, convert to GB/MB
    if (typeof sizeStr === 'number') {
        const gb = sizeStr / (1024 * 1024 * 1024);
        if (gb >= 1) {
            return `${gb.toFixed(2)} GB`;
        } else {
            const mb = sizeStr / (1024 * 1024);
            return `${mb.toFixed(2)} MB`;
        }
    }

    return sizeStr;
}

// Helper function to make HTTP requests
function makeRequest(url, options = {}) {
    const controller = new AbortController();
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : SHOWBOX_API_TIMEOUT_MS;
    const timeoutId = setTimeout(function () {
        controller.abort(new Error(`Request timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const requestOptions = { ...options };
    delete requestOptions.timeoutMs;

    return fetch(url, {
        method: requestOptions.method || 'GET',
        headers: { ...WORKING_HEADERS, ...requestOptions.headers },
        ...requestOptions,
        signal: requestOptions.signal || controller.signal
    }).then(function (response) {
        clearTimeout(timeoutId);
        if (!response.ok) {
            // Try to get response body for better error logging
            return response.text().then(function (body) {
                console.error(`[ShowBox] HTTP Error ${response.status}: ${response.statusText}`);
                console.error(`[ShowBox] Response body: ${body.substring(0, 500)}`);
                throw new Error(`HTTP ${response.status}: ${response.statusText} - ${body.substring(0, 200)}`);
            }).catch(function (parseError) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            });
        }
        return response;
    }).catch(function (error) {
        clearTimeout(timeoutId);
        console.error(`[ShowBox] Request failed for ${url}: ${error.message}`);
        throw error;
    });
}

// Simple in-memory cache for TMDB metadata
const tmdbCache = new Map();
const TMDB_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Get movie/TV show details from TMDB
function getTMDBDetails(tmdbId, mediaType) {
    const cacheKey = `${mediaType}:${tmdbId}`;
    const cached = tmdbCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
        console.log(`[ShowBox] TMDB cache hit for ${cacheKey}`);
        return Promise.resolve(cached.value);
    }

    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}`;

    return makeRequest(url, { timeoutMs: TMDB_REQUEST_TIMEOUT_MS })
        .then(function (response) {
            return response.json();
        })
        .then(function (data) {
            const title = mediaType === 'tv' ? data.name : data.title;
            const releaseDate = mediaType === 'tv' ? data.first_air_date : data.release_date;
            const year = releaseDate ? parseInt(releaseDate.split('-')[0]) : null;

            const result = {
                title: title,
                year: year
            };

            tmdbCache.set(cacheKey, { value: result, expiresAt: Date.now() + TMDB_CACHE_TTL_MS });

            // Prune cache if it grows too large
            if (tmdbCache.size > 1000) {
                const now = Date.now();
                for (const [key, entry] of tmdbCache) {
                    if (entry.expiresAt <= now) {
                        tmdbCache.delete(key);
                    }
                }
            }

            return result;
        })
        .catch(function (error) {
            console.log(`[ShowBox] TMDB lookup failed: ${error.message}`);
            return {
                title: `TMDB ID ${tmdbId}`,
                year: null
            };
        });
}

// Process ShowBox API response - new format with versions and links
function processShowBoxResponse(data, mediaInfo, mediaType, seasonNum, episodeNum) {
    const streams = [];

    try {
        // Log full response for debugging
        console.log(`[ShowBox] API Response: ${JSON.stringify(data, null, 2).substring(0, 1000)}`);

        if (!data) {
            console.error(`[ShowBox] API returned empty/null response`);
            return streams;
        }

        // Check for API error messages in response
        if (data.error || data.message) {
            console.error(`[ShowBox] API Error: ${data.error || data.message}`);
            return streams;
        }

        if (!data.success) {
            console.error(`[ShowBox] API returned unsuccessful response (success=false)`);
            return streams;
        }

        if (!data.versions || !Array.isArray(data.versions) || data.versions.length === 0) {
            console.log(`[ShowBox] No versions found in API response`);
            return streams;
        }

        console.log(`[ShowBox] Processing ${data.versions.length} version(s)`);

        // Build title with year and episode info if TV
        let streamTitle = mediaInfo.title || 'Unknown Title';
        if (mediaInfo.year) {
            streamTitle += ` (${mediaInfo.year})`;
        }
        if (mediaType === 'tv' && seasonNum && episodeNum) {
            streamTitle = `${mediaInfo.title || 'Unknown'} S${String(seasonNum).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}`;
            if (mediaInfo.year) {
                streamTitle += ` (${mediaInfo.year})`;
            }
        }

        // Process each version
        data.versions.forEach(function (version, versionIndex) {
            const versionName = version.name || `Version ${versionIndex + 1}`;
            const versionSize = version.size || 'Unknown';

            // Process each link in the version
            if (version.links && Array.isArray(version.links)) {
                version.links.forEach(function (link) {
                    if (!link.url) return;

                    const normalizedQuality = getQualityFromName(link.quality || 'Unknown');
                    const linkSize = link.size || versionSize;
                    const linkName = link.name || `${normalizedQuality}`;

                    // Create stream name - use version number if multiple versions exist
                    let streamName = 'ShowBox';
                    if (data.versions.length > 1) {
                        streamName += ` V${versionIndex + 1}`;
                    }
                    streamName += ` ${normalizedQuality}`;

                    streams.push({
                        name: streamName,
                        title: streamTitle,
                        url: link.url,
                        quality: normalizedQuality,
                        size: formatFileSize(linkSize),
                        provider: 'showbox',
                        speed: link.speed || null
                    });

                    console.log(`[ShowBox] Added ${normalizedQuality} stream from ${versionName}: ${link.url.substring(0, 50)}...`);
                });
            }
        });

    } catch (error) {
        console.error(`[ShowBox] Error processing response: ${error.message}`);
    }

    return streams;
}

// Main scraping function
function getStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null, scraperSettings = null) {
    console.log(`[ShowBox] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}${mediaType === 'tv' ? `, S:${seasonNum}E:${episodeNum}` : ''}`);

    // Get cookie (uiToken) - required
    const cookie = getUiToken(scraperSettings);
    if (!cookie) {
        console.error('[ShowBox] No UI token (cookie) found in scraper settings');
        return Promise.resolve([]);
    }

    // Get OSS group - optional
    const ossGroup = getOssGroup(scraperSettings);
    console.log(`[ShowBox] Using cookie: ${cookie.substring(0, 20)}...${ossGroup ? `, OSS Group: ${ossGroup}` : ' (no OSS group)'}`);

    // Build API URL based on media type
    let apiUrl;
    if (mediaType === 'tv' && seasonNum && episodeNum) {
        // TV format: /api/media/tv/:tmdbId/oss=:ossGroup/:season/:episode?cookie=:cookie
        if (ossGroup) {
            apiUrl = `${SHOWBOX_API_BASE}/tv/${tmdbId}/oss=${ossGroup}/${seasonNum}/${episodeNum}?cookie=${encodeURIComponent(cookie)}`;
        } else {
            apiUrl = `${SHOWBOX_API_BASE}/tv/${tmdbId}/${seasonNum}/${episodeNum}?cookie=${encodeURIComponent(cookie)}`;
        }
    } else {
        // Movie format: /api/media/movie/:tmdbId?cookie=:cookie
        apiUrl = `${SHOWBOX_API_BASE}/movie/${tmdbId}?cookie=${encodeURIComponent(cookie)}`;
    }

    // Debug log with redacted cookie (show first/last 10 chars only)
    const debugUrl = apiUrl.replace(/cookie=([^&]+)/, function (match, cookieVal) {
        return 'cookie=' + cookieVal.substring(0, 10) + '...' + cookieVal.substring(cookieVal.length - 10);
    });
    console.log(`[ShowBox] Requesting: ${debugUrl}`);
    console.log(`[ShowBox] Cookie length: ${cookie.length}, Expires: ${getJwtExpiryIso(cookie)}`);

    const mediaInfoPromise = getTMDBDetails(tmdbId, mediaType)
        .then(function (mediaInfo) {
            console.log(`[ShowBox] TMDB Info: "${mediaInfo.title}" (${mediaInfo.year || 'N/A'})`);
            return mediaInfo;
        });

    const apiRequestPromise = makeRequest(apiUrl, { timeoutMs: SHOWBOX_API_TIMEOUT_MS })
        .then(function (response) {
            console.log(`[ShowBox] API Response status: ${response.status}`);
            return response.json();
        })
        .then(function (data) {
            console.log(`[ShowBox] API Response received:`, JSON.stringify(data, null, 2));
            return data;
        })
        .catch(function (error) {
            console.error(`[ShowBox] API request failed: ${error.message}`);
            throw error;
        });

    return Promise.all([mediaInfoPromise, apiRequestPromise])
        .then(function ([mediaInfo, data]) {
            // Process the response
            const streams = processShowBoxResponse(data, mediaInfo, mediaType, seasonNum, episodeNum);

            if (streams.length === 0) {
                console.log(`[ShowBox] No streams found in API response`);
                return [];
            }

            // Sort streams by quality (highest first)
            streams.sort(function (a, b) {
                const qualityOrder = {
                    'Original': 6,
                    '4K': 5,
                    '1440p': 4,
                    '1080p': 3,
                    '720p': 2,
                    '480p': 1,
                    '360p': 0,
                    '240p': -1,
                    'Unknown': -2
                };
                return (qualityOrder[b.quality] || -2) - (qualityOrder[a.quality] || -2);
            });

            console.log(`[ShowBox] Returning ${streams.length} streams`);
            return streams;
        })
        .catch(function (error) {
            console.error(`[ShowBox] Error in getStreams: ${error.message}`);
            return []; // Return empty array on error as per Nuvio scraper guidelines
        });
}

// Export the main function
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getStreams };
} else {
    // For React Native environment
    global.ShowBoxScraperModule = { getStreams };
}
