// Castle Scraper for Nuvio Local Scrapers
// React Native compatible version - Promise-based approach only
// Extracts streaming links using TMDB ID for Castle API with AES-CBC decryption

// TMDB API Configuration
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// Castle API Configuration
const CASTLE_BASE = 'https://api.fstcy.com';
const PKG = 'com.external.castle';
const CHANNEL = 'IndiaA';
const CLIENT = '1';
const LANG = 'en-US';
const SUFFIX = 'T!BgJB';

// Working headers for Castle API
const WORKING_HEADERS = {
    'User-Agent': 'okhttp/4.9.3',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'Keep-Alive',
    'Referer': CASTLE_BASE
};

// Headers for stream playback
const PLAYBACK_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'Accept': 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'video',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'cross-site',
    'DNT': '1'
};

// AES-CBC Decryption using remote server (Castle-specific)
function decryptCastle(encryptedB64, securityKeyB64) {
    console.log('[Castle] Starting Castle-specific AES-CBC decryption...');
    
    return fetch('https://aesdec.nuvioapp.space/decrypt-castle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            encryptedData: encryptedB64,
            securityKey: securityKeyB64
        })
    })
    .then(function(response) {
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return response.json();
    })
    .then(function(data) {
        if (data.error) throw new Error(data.error);
        console.log('[Castle] Server decryption successful');
        return data.decrypted;
    })
    .catch(function(error) {
        console.error(`[Castle] Server decryption failed: ${error.message}`);
        throw error;
    });
}

// Helper function to make HTTP requests
function makeRequest(url, options = {}) {
    const defaultHeaders = { ...WORKING_HEADERS };

    return fetch(url, {
        method: options.method || 'GET',
        headers: { ...defaultHeaders, ...options.headers },
        ...options
    }).then(function(response) {
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return response;
    }).catch(function(error) {
        console.error(`[Castle] Request failed for ${url}: ${error.message}`);
        throw error;
    });
}

// Get quality value for sorting (higher = better quality)
function getQualityValue(quality) {
    if (!quality) return 0;

    // Remove common prefixes and clean up
    const cleanQuality = quality.toString().toLowerCase()
        .replace(/^(sd|hd|fhd|uhd|4k)\s*/i, '')
        .replace(/p$/, '')
        .trim();

    // Handle specific quality names
    if (cleanQuality === '4k' || cleanQuality === '2160') return 2160;
    if (cleanQuality === '1440') return 1440;
    if (cleanQuality === '1080') return 1080;
    if (cleanQuality === '720') return 720;
    if (cleanQuality === '480') return 480;
    if (cleanQuality === '360') return 360;
    if (cleanQuality === '240') return 240;

    // Try to parse as number
    const numQuality = parseInt(cleanQuality);
    if (!isNaN(numQuality) && numQuality > 0) {
        return numQuality;
    }

    // Unknown quality goes last
    return 0;
}

// Extract cipher from response (can be JSON wrapper or raw base64)
function extractCipherFromResponse(response) {
    return response.text().then(function(text) {
        const trimmed = text.trim();
        if (!trimmed) {
            throw new Error('Empty response');
        }
        
        // Try to parse as JSON first
        try {
            const json = JSON.parse(trimmed);
            if (json && json.data && typeof json.data === 'string') {
                return json.data.trim();
            }
        } catch (e) {
            // Not JSON, assume it's raw base64
        }
        
        return trimmed;
    });
}

// Get security key from Castle API
function getSecurityKey() {
    console.log('[Castle] Fetching security key...');
    const url = `${CASTLE_BASE}/v0.1/system/getSecurityKey/1?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}`;
    
    return makeRequest(url, { timeout: 20000 })
        .then(function(response) {
            return response.json();
        })
        .then(function(data) {
            if (data.code !== 200 || !data.data) {
                throw new Error(`Security key API error: ${JSON.stringify(data)}`);
            }
            console.log('[Castle] Security key obtained');
            return data.data;
        });
}

// Search for content by keyword
function searchCastle(securityKey, keyword, page = 1, size = 30) {
    console.log(`[Castle] Searching for: ${keyword}`);
    
    const params = new URLSearchParams({
        channel: CHANNEL,
        clientType: CLIENT,
        keyword: keyword,
        lang: LANG,
        mode: '1',
        packageName: PKG,
        page: page.toString(),
        size: size.toString()
    });
    
    const url = `${CASTLE_BASE}/film-api/v1.1.0/movie/searchByKeyword?${params.toString()}`;
    
    return makeRequest(url, { timeout: 30000 })
        .then(function(response) {
            return extractCipherFromResponse(response);
        })
        .then(function(cipher) {
            return decryptCastle(cipher, securityKey);
        })
        .then(function(decrypted) {
            return JSON.parse(decrypted);
        });
}

// Get movie/TV details
function getDetails(securityKey, movieId) {
    console.log(`[Castle] Fetching details for movieId: ${movieId}`);
    
    const url = `${CASTLE_BASE}/film-api/v1.1/movie?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}&movieId=${movieId}&packageName=${PKG}`;
    
    return makeRequest(url, { timeout: 30000 })
        .then(function(response) {
            return extractCipherFromResponse(response);
        })
        .then(function(cipher) {
            return decryptCastle(cipher, securityKey);
        })
        .then(function(decrypted) {
            return JSON.parse(decrypted);
        });
}

// Get video URL using v2.0.1 getVideo2 (shared streams)
function getVideo2(securityKey, movieId, episodeId, resolution = 2) {
    console.log(`[Castle] Fetching video (v2) for movieId: ${movieId}, episodeId: ${episodeId}, resolution: ${resolution}`);
    
    const url = `${CASTLE_BASE}/film-api/v2.0.1/movie/getVideo2?clientType=${CLIENT}&packageName=${PKG}&channel=${CHANNEL}&lang=${LANG}`;
    
    const body = {
        mode: '1',
        appMarket: 'GuanWang',
        clientType: '1',
        woolUser: 'false',
        apkSignKey: 'ED0955EB04E67A1D9F3305B95454FED485261475',
        androidVersion: '13',
        movieId: movieId,
        episodeId: episodeId,
        isNewUser: 'true',
        resolution: resolution.toString(),
        packageName: PKG
    };
    
    return makeRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeout: 30000
    })
    .then(function(response) {
        return extractCipherFromResponse(response);
    })
    .then(function(cipher) {
        return decryptCastle(cipher, securityKey);
    })
    .then(function(decrypted) {
        return JSON.parse(decrypted);
    });
}

// Get video URL using v1.9.1 getVideo (language-specific)
function getVideoV1(securityKey, movieId, episodeId, languageId, resolution = 2) {
    console.log(`[Castle] Fetching video (v1) for movieId: ${movieId}, episodeId: ${episodeId}, languageId: ${languageId}, resolution: ${resolution}`);
    
    const params = new URLSearchParams({
        apkSignKey: 'ED0955EB04E67A1D9F3305B95454FED485261475',
        channel: CHANNEL,
        clientType: CLIENT,
        episodeId: episodeId.toString(),
        lang: LANG,
        languageId: languageId.toString(),
        mode: '1',
        movieId: movieId.toString(),
        packageName: PKG,
        resolution: resolution.toString()
    });
    
    const url = `${CASTLE_BASE}/film-api/v1.9.1/movie/getVideo?${params.toString()}`;
    
    return makeRequest(url, { timeout: 30000 })
        .then(function(response) {
            return extractCipherFromResponse(response);
        })
        .then(function(cipher) {
            return decryptCastle(cipher, securityKey);
        })
        .then(function(decrypted) {
            return JSON.parse(decrypted);
        });
}

// Extract data block from response
function extractDataBlock(obj) {
    if (obj && obj.data && typeof obj.data === 'object') {
        return obj.data;
    }
    return obj || {};
}

// Get movie/TV show details from TMDB
function getTMDBDetails(tmdbId, mediaType) {
    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;

    const attemptFetch = function(retryDelay) {
        const run = function() {
            return makeRequest(url)
                .then(function(response) {
                    return response.json();
                });
        };

        if (retryDelay <= 0) {
            return run();
        }

        return new Promise(function(resolve) {
            setTimeout(resolve, retryDelay);
        }).then(run);
    };

    return attemptFetch(0)
        .catch(function() {
            return attemptFetch(250);
        })
        .catch(function() {
            return attemptFetch(750);
        })
        .then(function(data) {
            const title = mediaType === 'tv' ? data.name : data.title;
            const releaseDate = mediaType === 'tv' ? data.first_air_date : data.release_date;
            const year = releaseDate ? parseInt(releaseDate.split('-')[0]) : null;

            return {
                title: title,
                year: year,
                tmdbId: tmdbId
            };
        });
}

// Find Castle movie ID by searching
function findCastleMovieId(securityKey, tmdbInfo) {
    const searchTerm = tmdbInfo.year ? `${tmdbInfo.title} ${tmdbInfo.year}` : tmdbInfo.title;
    
    return searchCastle(securityKey, searchTerm)
        .then(function(searchResult) {
            const data = extractDataBlock(searchResult);
            const rows = data.rows || [];
            
            if (rows.length === 0) {
                throw new Error('No search results found');
            }
            
            // Try to find exact match first
            for (let i = 0; i < rows.length; i++) {
                const item = rows[i];
                const itemTitle = (item.title || item.name || '').toLowerCase();
                const searchTitle = tmdbInfo.title.toLowerCase();
                
                if (itemTitle.includes(searchTitle) || searchTitle.includes(itemTitle)) {
                    const movieId = item.id || item.redirectId || item.redirectIdStr;
                    if (movieId) {
                        console.log(`[Castle] Found match: ${item.title || item.name} (id: ${movieId})`);
                        return movieId.toString();
                    }
                }
            }
            
            // Fallback to first result
            const firstItem = rows[0];
            const movieId = firstItem.id || firstItem.redirectId || firstItem.redirectIdStr;
            if (movieId) {
                console.log(`[Castle] Using first result: ${firstItem.title || firstItem.name} (id: ${movieId})`);
                return movieId.toString();
            }
            
            throw new Error('Could not extract movie ID from search results');
        });
}

// Process video response and extract streams
function processVideoResponse(videoData, mediaInfo, seasonNum, episodeNum, resolution, languageInfo) {
    const streams = [];
    const data = extractDataBlock(videoData);
    
    // Extract video URL
    const videoUrl = data.videoUrl;
    if (!videoUrl) {
        console.log('[Castle] No videoUrl found in response');
        return streams;
    }
    
    // Create media title
    let mediaTitle = mediaInfo.title || 'Unknown';
    if (mediaInfo.year) {
        mediaTitle += ` (${mediaInfo.year})`;
    }
    if (seasonNum && episodeNum) {
        mediaTitle = `${mediaInfo.title} S${String(seasonNum).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}`;
    }
    
    // Map resolution number to quality string
    const qualityMap = {
        1: '480p',
        2: '720p',
        3: '1080p'
    };
    const quality = qualityMap[resolution] || `${resolution}p`;
    
    // Check if there are multiple quality videos
    if (data.videos && Array.isArray(data.videos)) {
        data.videos.forEach(function(video) {
            // Clean up quality to remove SD/HD/FHD prefixes
            let videoQuality = video.resolutionDescription || video.resolution || quality;
            videoQuality = videoQuality.replace(/^(SD|HD|FHD)\s+/i, ''); // Remove SD/HD/FHD prefixes

            const streamName = languageInfo
                ? `Castle ${languageInfo} - ${videoQuality}`
                : `Castle - ${videoQuality}`;
            
            const sizeValue = video.size;
            const formattedSize = (typeof sizeValue === 'number' && sizeValue > 0)
                ? (sizeValue > 1000000000 ? `${(sizeValue / 1000000000).toFixed(2)} GB` : `${(sizeValue / 1000000).toFixed(0)} MB`)
                : 'Unknown';

            streams.push({
                name: streamName,
                title: mediaTitle,
                url: video.url || videoUrl,
                quality: videoQuality,
                size: formattedSize,
                headers: PLAYBACK_HEADERS,
                provider: 'castle'
            });
        });
    } else {
        const streamName = languageInfo
            ? `Castle ${languageInfo} - ${quality}`
            : `Castle - ${quality}`;

        // Try to extract size from response data
        const sizeValue = data.size;
        const formattedSize = (typeof sizeValue === 'number' && sizeValue > 0)
            ? (sizeValue > 1000000000 ? `${(sizeValue / 1000000000).toFixed(2)} GB` : `${(sizeValue / 1000000).toFixed(0)} MB`)
            : 'Unknown';

        streams.push({
            name: streamName,
            title: mediaTitle,
            url: videoUrl,
            quality: quality,
            size: formattedSize,
            headers: PLAYBACK_HEADERS,
            provider: 'castle'
        });
    }
    
    return streams;
}

// Main function to extract streaming links for Nuvio
function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
    console.log(`[Castle] Starting extraction for TMDB ID: ${tmdbId}, Type: ${mediaType}${mediaType === 'tv' ? `, S:${seasonNum}E:${episodeNum}` : ''}`);
    
    return new Promise(function(resolve, reject) {
        // Step 1: Get TMDB details
        getTMDBDetails(tmdbId, mediaType)
            .then(function(tmdbInfo) {
                console.log(`[Castle] TMDB Info: "${tmdbInfo.title}" (${tmdbInfo.year || 'N/A'})`);
                
                // Step 2: Get security key
                return getSecurityKey().then(function(securityKey) {
                    return { tmdbInfo: tmdbInfo, securityKey: securityKey };
                });
            })
            .then(function(context) {
                const { tmdbInfo, securityKey } = context;
                
                // Step 3: Find Castle movie ID
                return findCastleMovieId(securityKey, tmdbInfo).then(function(movieId) {
                    return { tmdbInfo: tmdbInfo, securityKey: securityKey, movieId: movieId };
                });
            })
            .then(function(context) {
                const { tmdbInfo, securityKey, movieId } = context;
                
                // Step 4: Get details
                return getDetails(securityKey, movieId).then(function(details) {
                    return { tmdbInfo: tmdbInfo, securityKey: securityKey, movieId: movieId, details: details };
                });
            })
            .then(function(context) {
                const { tmdbInfo, securityKey, movieId, details } = context;
                
                // Step 5: Handle seasons/episodes for TV shows
                let finalMovieId = movieId;
                let finalDetails = details;
                
                if (mediaType === 'tv' && seasonNum && episodeNum) {
                    const data = extractDataBlock(details);
                    const seasons = data.seasons || [];
                    
                    // Find the season
                    const season = seasons.find(function(s) {
                        return s.number === seasonNum;
                    });
                    
                    if (season && season.movieId && season.movieId !== movieId) {
                        console.log(`[Castle] Fetching season ${seasonNum} details...`);
                        return getDetails(securityKey, season.movieId.toString()).then(function(seasonDetails) {
                            return {
                                tmdbInfo: tmdbInfo,
                                securityKey: securityKey,
                                movieId: season.movieId.toString(),
                                details: seasonDetails
                            };
                        });
                    }
                }
                
                return Promise.resolve({
                    tmdbInfo: tmdbInfo,
                    securityKey: securityKey,
                    movieId: finalMovieId,
                    details: finalDetails
                });
            })
            .then(function(context) {
                const { tmdbInfo, securityKey, movieId, details } = context;
                
                // Step 6: Find episode ID
                const data = extractDataBlock(details);
                const episodes = data.episodes || [];
                
                let episodeId = null;
                if (mediaType === 'tv' && seasonNum && episodeNum) {
                    const episode = episodes.find(function(e) {
                        return e.number === episodeNum;
                    });
                    if (episode && episode.id) {
                        episodeId = episode.id.toString();
                    }
                } else if (episodes.length > 0) {
                    // For movies, use first episode if available
                    episodeId = episodes[0].id.toString();
                }
                
                if (!episodeId) {
                    throw new Error('Could not find episode ID');
                }
                
                // Step 7: Check for language-specific tracks
                const episode = episodes.find(function(e) {
                    return e.id.toString() === episodeId;
                });
                const tracks = (episode && episode.tracks) || [];
                const hasIndividualVideo = tracks.some(function(t) {
                    return t.existIndividualVideo === true;
                });
                
                // Step 8: Get video URLs for ALL available languages
                const resolution = 2; // Default to 720p
                const allStreams = [];
                
                // Process all language tracks
                const processLanguages = function(langIndex) {
                    if (langIndex >= tracks.length) {
                        // All languages processed, return combined streams
                        console.log(`[Castle] Total streams from all languages: ${allStreams.length}`);
                        return Promise.resolve(allStreams);
                    }
                    
                    const track = tracks[langIndex];
                    const langName = track.languageName || track.abbreviate || `Lang${langIndex + 1}`;
                    
                    if (track.existIndividualVideo && track.languageId) {
                        // Try v1 for this language
                        console.log(`[Castle] Fetching ${langName} (v1, languageId: ${track.languageId})`);
                        
                        return getVideoV1(securityKey, movieId, episodeId, track.languageId, resolution)
                            .then(function(videoData) {
                                const langStreams = processVideoResponse(
                                    videoData, 
                                    tmdbInfo, 
                                    seasonNum, 
                                    episodeNum, 
                                    resolution, 
                                    `[${langName}]`
                                );
                                
                                if (langStreams.length > 0) {
                                    console.log(`[Castle] ✅ ${langName}: Found ${langStreams.length} streams`);
                                    allStreams.push(...langStreams);
                                } else {
                                    console.log(`[Castle] ⚠️  ${langName}: v1 returned no streams`);
                                }
                                
                                return processLanguages(langIndex + 1);
                            })
                            .catch(function(error) {
                                console.log(`[Castle] ⚠️  ${langName}: v1 failed - ${error.message}`);
                                return processLanguages(langIndex + 1);
                            });
                    } else {
                        // No individual video, skip this language
                        console.log(`[Castle] ⏭️  ${langName}: No individual video available`);
                        return processLanguages(langIndex + 1);
                    }
                };
                
                return processLanguages(0)
                    .then(function(langStreams) {
                        if (langStreams.length > 0) {
                            return langStreams;
                        }
                        
                        // Fallback: Use shared stream (v2) if no individual videos worked
                        console.log(`[Castle] All individual videos failed, falling back to shared stream (v2)`);
                        return getVideo2(securityKey, movieId, episodeId, resolution)
                            .then(function(videoData) {
                                return processVideoResponse(videoData, tmdbInfo, seasonNum, episodeNum, resolution, '[Shared]');
                            });
                    });
            })
            .then(function(streams) {
                console.log(`[Castle] Total streams found: ${streams.length}`);

                // Sort streams by quality (highest first)
                streams.sort(function(a, b) {
                    const qualityA = getQualityValue(a.quality);
                    const qualityB = getQualityValue(b.quality);
                    return qualityB - qualityA; // Higher quality first
                });

                resolve(streams);
            })
            .catch(function(error) {
                console.error(`[Castle] Error: ${error.message}`);
                resolve([]); // Return empty array on error for Nuvio compatibility
            });
    });
}

// Export for React Native compatibility
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getStreams };
} else {
    global.getStreams = getStreams;
}
