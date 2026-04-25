// Vixsrc Scraper for Nuvio Local Scrapers
// React Native compatible version - Standalone (no external dependencies)
// Converted to Promise-based syntax for sandbox compatibility

// Constants
const TMDB_API_KEY = "68e094699525b18a70bab2f86b1fa706";
const BASE_URL = 'https://vixsrc.to';

// Helper function to make HTTP requests with default headers
function makeRequest(url, options = {}) {
    const defaultHeaders = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json,*/*',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        ...options.headers
    };

    return fetch(url, {
        method: options.method || 'GET',
        headers: defaultHeaders,
        ...options
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return response;
    })
    .catch(error => {
        console.error(`[Vixsrc] Request failed for ${url}: ${error.message}`);
        throw error;
    });
}

// Helper function to get TMDB info
function getTmdbInfo(tmdbId, mediaType) {
    const url = `https://api.themoviedb.org/3/${mediaType === 'tv' ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    
    return makeRequest(url)
    .then(response => response.json())
    .then(data => {
        const title = mediaType === 'tv' ? data.name : data.title;
        const year = mediaType === 'tv' ? data.first_air_date?.substring(0, 4) : data.release_date?.substring(0, 4);
        
        if (!title) {
            throw new Error('Could not extract title from TMDB response');
        }
        
        console.log(`[Vixsrc] TMDB Info: "${title}" (${year})`);
        return { title, year, data };
    });
}

// Helper function to parse M3U8 playlist
function parseM3U8Playlist(content, baseUrl) {
    const streams = [];
    const audioTracks = [];
    const lines = content.split('\n');

    let currentStream = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Parse video streams
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            // Parse stream info
            const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
            const resolutionMatch = line.match(/RESOLUTION=(\d+x\d+)/);
            const nameMatch = line.match(/NAME="([^"]+)"/) || line.match(/NAME=([^,]+)/);

            if (bandwidthMatch) {
                currentStream = {
                    bandwidth: parseInt(bandwidthMatch[1]),
                    resolution: resolutionMatch ? resolutionMatch[1] : 'Unknown',
                    quality: nameMatch ? nameMatch[1] : getQualityFromResolution(resolutionMatch ? resolutionMatch[1] : 'Unknown'),
                    url: ''
                };
            }
        } 
        // Parse audio tracks
        else if (line.startsWith('#EXT-X-MEDIA:')) {
            const typeMatch = line.match(/TYPE=([^,]+)/);
            const nameMatch = line.match(/NAME="([^"]+)"/);
            const groupIdMatch = line.match(/GROUP-ID="([^"]+)"/);
            const languageMatch = line.match(/LANGUAGE="([^"]+)"/);
            const uriMatch = line.match(/URI="([^"]+)"/);

            if (typeMatch && typeMatch[1] === 'AUDIO') {
                const audioTrack = {
                    type: 'audio',
                    name: nameMatch ? nameMatch[1] : 'Unknown Audio',
                    groupId: groupIdMatch ? groupIdMatch[1] : 'unknown',
                    language: languageMatch ? languageMatch[1] : 'unknown',
                    url: uriMatch ? resolveUrl(uriMatch[1], baseUrl) : null
                };
                audioTracks.push(audioTrack);
            }
        }
        // Handle URLs for video streams
        else if (line.startsWith('http') && currentStream) {
            // This is the URL for the current video stream
            currentStream.url = line.startsWith('http') ? line : resolveUrl(line, baseUrl);
            streams.push(currentStream);
            currentStream = null;
        }
    }

    console.log(`[Vixsrc] Found ${audioTracks.length} audio tracks:`);
    audioTracks.forEach((track, index) => {
        console.log(`   ${index + 1}. ${track.name} (${track.language}) - ${track.url ? 'Available' : 'No URL'}`);
    });

    return { streams, audioTracks };
}

// Helper function to get quality from resolution
function getQualityFromResolution(resolution) {
    if (resolution.includes('1920x1080') || resolution.includes('1080')) {
        return '1080p';
    } else if (resolution.includes('1280x720') || resolution.includes('720')) {
        return '720p';
    } else if (resolution.includes('854x480') || resolution.includes('640x480') || resolution.includes('480')) {
        return '480p';
    } else if (resolution.includes('640x360') || resolution.includes('360')) {
        return '360p';
    } else {
        return resolution;
    }
}

// Helper function to resolve URLs
function resolveUrl(url, baseUrl) {
    if (url.startsWith('http')) {
        return url;
    }

    // Handle relative URLs
    const baseUrlObj = new URL(baseUrl);
    if (url.startsWith('/')) {
        return `${baseUrlObj.protocol}//${baseUrlObj.host}${url}`;
    } else {
        const basePath = baseUrlObj.pathname.substring(0, baseUrlObj.pathname.lastIndexOf('/') + 1);
        return `${baseUrlObj.protocol}//${baseUrlObj.host}${basePath}${url}`;
    }
}

function extractPageConfig(html) {
    const tokenMatch = String(html || '').match(/['"]token['"]\s*:\s*['"](.*?)['"]/i);
    const expiresMatch = String(html || '').match(/['"]expires['"]\s*:\s*['"](.*?)['"]/i);
    const urlMatch = String(html || '').match(/url:\s*['"](.*?)['"]/i);

    if (!tokenMatch || !expiresMatch || !urlMatch) {
        return null;
    }

    return {
        token: tokenMatch[1],
        expires: expiresMatch[1],
        url: urlMatch[1]
    };
}

function buildPlaylistUrl(pageConfig) {
    const baseUrl = new URL(pageConfig.url, BASE_URL);
    const playlistUrl = new URL(`${baseUrl.origin}${baseUrl.pathname}.m3u8${baseUrl.search}`);
    playlistUrl.searchParams.set('token', pageConfig.token);
    playlistUrl.searchParams.set('expires', pageConfig.expires);
    playlistUrl.searchParams.set('h', '1');
    return playlistUrl.toString();
}

function parseHeightFromPlaylist(playlistText) {
    let maxHeight = 0;
    const regex = /RESOLUTION=\d+x(\d+)/gi;
    let match;

    while ((match = regex.exec(String(playlistText || ''))) !== null) {
        const height = parseInt(match[1], 10);
        if (!Number.isNaN(height) && height > maxHeight) {
            maxHeight = height;
        }
    }

    return maxHeight || null;
}

function parseLanguagesFromPlaylist(playlistText) {
    const languages = new Set();
    const regex = /LANGUAGE="([a-z]{2,3})"/gi;
    let match;

    while ((match = regex.exec(String(playlistText || ''))) !== null) {
        languages.add(match[1].toLowerCase());
    }

    return Array.from(languages);
}

// Helper function to fetch stream URL from the current Vixsrc API/embed flow
function extractStreamFromPage(url, contentType, contentId, seasonNum, episodeNum) {
    let apiUrl;
    let subtitleApiUrl;

    if (contentType === 'movie') {
        apiUrl = `${BASE_URL}/api/movie/${contentId}`;
        subtitleApiUrl = `https://sub.wyzie.ru/search?id=${contentId}`;
    } else {
        apiUrl = `${BASE_URL}/api/tv/${contentId}/${seasonNum}/${episodeNum}`;
        subtitleApiUrl = `https://sub.wyzie.ru/search?id=${contentId}&season=${seasonNum}&episode=${episodeNum}`;
    }

    console.log(`[Vixsrc] Fetching API: ${apiUrl}`);

    return makeRequest(apiUrl)
    .then(response => response.json())
    .then(data => {
        if (!data || !data.src) {
            console.log('[Vixsrc] No src found in API response');
            return null;
        }

        const embedUrl = data.src.startsWith('http')
            ? data.src
            : `${BASE_URL}${data.src}`;

        console.log(`[Vixsrc] API returned embed: ${embedUrl}`);
        return makeRequest(embedUrl, {
            headers: {
                Referer: contentType === 'movie'
                    ? `${BASE_URL}/movie/${contentId}`
                    : `${BASE_URL}/tv/${contentId}/${seasonNum || 1}/${episodeNum || 1}`
            }
        })
        .then(response => response.text())
        .then(embedHtml => {
            const pageConfig = extractPageConfig(embedHtml);

            if (!pageConfig) {
                console.log('[Vixsrc] Missing token/expires/url in embed response');
                return null;
            }

            const masterPlaylistUrl = buildPlaylistUrl(pageConfig);

            return makeRequest(masterPlaylistUrl, {
                headers: {
                    Referer: embedUrl
                }
            })
            .then(response => response.text())
            .then(playlistText => ({
                masterPlaylistUrl,
                subtitleApiUrl,
                referer: embedUrl,
                height: parseHeightFromPlaylist(playlistText),
                languages: parseLanguagesFromPlaylist(playlistText)
            }))
            .catch(error => {
                console.log(`[Vixsrc] Playlist validation failed: ${error.message}`);
                return {
                    masterPlaylistUrl,
                    subtitleApiUrl,
                    referer: embedUrl,
                    height: null,
                    languages: []
                };
            });
        });
    });
}

// Helper function to get subtitles
function getSubtitles(subtitleApiUrl) {
    return makeRequest(subtitleApiUrl)
    .then(response => response.json())
    .then(subtitleData => {
        // Find English subtitle track (same logic as original)
        let subtitleTrack = subtitleData.find(track =>
            track.display.includes('English') && (track.encoding === 'ASCII' || track.encoding === 'UTF-8')
        );

        if (!subtitleTrack) {
            subtitleTrack = subtitleData.find(track => track.display.includes('English') && track.encoding === 'CP1252');
        }

        if (!subtitleTrack) {
            subtitleTrack = subtitleData.find(track => track.display.includes('English') && track.encoding === 'CP1250');
        }

        if (!subtitleTrack) {
            subtitleTrack = subtitleData.find(track => track.display.includes('English') && track.encoding === 'CP850');
        }

        const subtitles = subtitleTrack ? subtitleTrack.url : '';
        console.log(subtitles ? `[Vixsrc] Found subtitles: ${subtitles}` : '[Vixsrc] No English subtitles found');
        return subtitles;
    })
    .catch(error => {
        console.log('[Vixsrc] Subtitle fetch failed:', error.message);
        return '';
    });
}

// Main function to get streams - adapted for Nuvio provider format
function getStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    console.log(`[Vixsrc] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);

    // TMDB is not required for VixSrc playback. Avoid making it a hard dependency
    // because transient TMDB fetch resets would otherwise hide working streams.
    getTmdbInfo(tmdbId, mediaType).catch(error => {
        console.log(`[Vixsrc] TMDB lookup skipped: ${error.message}`);
        return null;
    });

    return extractStreamFromPage(null, mediaType, tmdbId, seasonNum, episodeNum)
    .then(streamData => {
        if (!streamData) {
            console.log('[Vixsrc] No stream data found');
            return [];
        }

        const { masterPlaylistUrl, subtitleApiUrl, referer, height, languages } = streamData;

        console.log('[Vixsrc] Returning direct stream with Auto quality...');

        return getSubtitles(subtitleApiUrl)
        .then(() => {
            const nuvioStreams = [{
                name: "Vixsrc",
                title: height ? `Auto Quality Stream\nVixSrc ${height}p` : "Auto Quality Stream",
                url: masterPlaylistUrl,
                quality: height ? `${height}p` : 'Auto',
                languages: Array.isArray(languages) ? languages : [],
                type: 'direct',
                headers: {
                    'Referer': referer || BASE_URL,
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
                }
            }];

            console.log('[Vixsrc] Successfully processed 1 stream with Auto quality');
            return nuvioStreams;
        });
    })
    .catch(error => {
        console.error(`[Vixsrc] Error in getStreams: ${error.message}`);
        return [];
    });
}

// Export for React Native
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getStreams };
} else {
    global.VixsrcScraperModule = { getStreams };
}
