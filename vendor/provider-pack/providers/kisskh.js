const cheerio = require('cheerio-without-node-native');

// Konstanta dari file Adicinemax21Extractor.kt
const MAIN_URL = (process.env.KISSKH_BASE_URL || "https://kisskh.nl").replace(/\/+$/, "");
// URL Google Script untuk generate key (PENTING)
const KISSKH_API = "https://script.google.com/macros/s/AKfycbzn8B31PuDxzaMa9_CQ0VGEDasFqfzI5bXvjaIZH4DM8DNq9q6xj1ALvZNz_JT3jF0suA/exec?id=";
const REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    "Accept": "application/json,text/plain,*/*"
};

function normalizeTitle(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\b(19|20)\d{2}\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function scoreTitleMatch(targetTitle, candidateTitle) {
    const target = normalizeTitle(targetTitle);
    const candidate = normalizeTitle(candidateTitle);

    if (!target || !candidate) return 0;
    if (target === candidate) return 100;
    if (candidate.includes(target) || target.includes(candidate)) return 90;

    const targetWords = new Set(target.split(/\s+/).filter(Boolean));
    const candidateWords = new Set(candidate.split(/\s+/).filter(Boolean));
    const overlap = [...targetWords].filter((word) => candidateWords.has(word)).length;

    if (!overlap) return 0;

    return Math.round((overlap / Math.max(targetWords.size, candidateWords.size)) * 80);
}

function extractSeasonHint(value) {
    const title = String(value || '');
    const patterns = [
        /\bseason\s+(\d+)\b/i,
        /\bseries\s+(\d+)\b/i,
        /\bpart\s+(\d+)\b/i,
        /\bbook\s+(\d+)\b/i,
        /(?:^|\s)(\d+)\s*$/
    ];

    for (const pattern of patterns) {
        const match = title.match(pattern);
        if (match) {
            const season = parseInt(match[1], 10);
            if (!Number.isNaN(season) && season > 0 && season < 100) {
                return season;
            }
        }
    }

    return null;
}

function scoreSearchCandidate(targetTitle, candidateTitle, mediaType, seasonNum, year) {
    let score = scoreTitleMatch(targetTitle, candidateTitle);
    const candidateSeason = extractSeasonHint(candidateTitle);
    const requestedSeason = parseInt(seasonNum, 10);
    const rawCandidate = String(candidateTitle || '').toLowerCase();

    if (mediaType === 'movie') {
        if (candidateSeason !== null) {
            score -= 120;
        }
    } else if (!Number.isNaN(requestedSeason) && requestedSeason > 0) {
        if (candidateSeason === requestedSeason) {
            score += 140;
        } else if (candidateSeason !== null) {
            score -= 180;
        } else if (requestedSeason === 1) {
            score += 20;
        } else {
            score -= 40;
        }
    }

    if (year && rawCandidate.includes(String(year))) {
        score += 10;
    }

    return score;
}

function fetchJson(url, options = {}, retries = 2) {
    const headers = Object.assign({}, REQUEST_HEADERS, options.headers || {});
    const timeoutMs = options.timeoutMs || 12000;
    const fetchOptions = Object.assign({}, options, { headers });
    delete fetchOptions.timeoutMs;

    const attempt = (remaining) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        return fetch(url, Object.assign({}, fetchOptions, { signal: controller.signal }))
            .then((res) => {
                clearTimeout(timeoutId);
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}`);
                }
                return res.json();
            })
            .catch((err) => {
                clearTimeout(timeoutId);
                if (remaining <= 0) {
                    throw err;
                }
                return new Promise((resolve) => setTimeout(resolve, (retries - remaining + 1) * 400))
                    .then(() => attempt(remaining - 1));
            });
    };

    return attempt(retries);
}

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
    return new Promise((resolve, reject) => {
        // Karena Kisskh butuh judul untuk mencari, kita gunakan placeholder atau fetch dari TMDB dulu jika perlu.
        // Di sini saya asumsikan Nuvio mengirim tmdbId, tapi Kisskh butuh "Query String" (Judul).
        // CATATAN: Karena kita tidak punya judul teks di parameter getStreams, 
        // kita harus fetch detail TMDB dulu.
        
        const tmdbUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=b030404650f279792a8d3287232358e3`; // API Key umum dari source code Kotlin

        fetchJson(tmdbUrl)
            .then(tmdbData => {
                const title = tmdbData.title || tmdbData.name || tmdbData.original_title;
                const year = (tmdbData.release_date || tmdbData.first_air_date || "").substring(0, 4);
                
                // 1. Cari Drama di Kisskh
                const searchUrl = `${MAIN_URL}/api/DramaList/Search?q=${encodeURIComponent(title)}&type=0`;
                
                return fetchJson(searchUrl)
                    .then(searchList => {
                        // Logika pencarian mirip Kotlin: Cek exact match, lalu fuzzy match
                        let matched = null;

                        if (Array.isArray(searchList) && searchList.length > 0) {
                            matched = [...searchList]
                                .map((item) => ({
                                    item,
                                    score: scoreSearchCandidate(
                                        title,
                                        item && item.title,
                                        mediaType,
                                        seasonNum,
                                        year
                                    )
                                }))
                                .sort((a, b) => b.score - a.score)[0]?.item || null;
                        }

                        if (!matched) throw new Error("Drama tidak ditemukan di Kisskh");
                        
                        return matched.id;
                    });
            })
            .then(dramaId => {
                // 2. Ambil Detail Drama untuk dapat List Episode
                return fetchJson(`${MAIN_URL}/api/DramaList/Drama/${dramaId}?isq=false`)
                    .then(detail => {
                        const episodes = detail.episodes;
                        if (!episodes || episodes.length === 0) throw new Error("Episode kosong");

                        // Tentukan target episode
                        // Jika movie, biasanya episode terakhir atau satu-satunya
                        let targetEp;
                        if (mediaType === 'movie') {
                            targetEp = episodes[episodes.length - 1];
                        } else {
                            // Jika TV, cari nomor episode yang pas
                            targetEp = episodes.find(ep => parseInt(ep.number) === parseInt(episodeNum));
                        }

                        if (!targetEp) throw new Error(`Episode ${episodeNum} tidak ditemukan`);
                        
                        return targetEp.id;
                    });
            })
            .then(epsId => {
                // 3. Ambil Kunci Video (Wajib untuk Kisskh)
                // Source: invokeKisskh di Kotlin
                const keyUrl = `${KISSKH_API}${epsId}&version=2.8.10`;
                
                return fetchJson(keyUrl)
                    .then(keyData => {
                        if (!keyData.key) throw new Error("Gagal mengambil kunci video");
                        
                        // 4. Ambil Source Video
                        const videoApi = `${MAIN_URL}/api/DramaList/Episode/${epsId}.png?err=false&ts=&time=&kkey=${keyData.key}`;
                        return fetchJson(videoApi, {
                            headers: {
                                "Origin": MAIN_URL,
                                "Referer": MAIN_URL + "/"
                            }
                        });
                    })
                    .then(sources => {
                        const streams = [];
                        
                        // Proses link video
                        const links = [sources.Video, sources.ThirdParty].filter(l => l);
                        
                        links.forEach(link => {
                            if (link.includes('.m3u8')) {
                                streams.push({
                                    name: "Kisskh HLS",
                                    title: `Kisskh Stream`,
                                    url: link,
                                    quality: "Auto",
                                    headers: { "Origin": MAIN_URL, "Referer": MAIN_URL },
                                    provider: "kisskh"
                                });
                            } else if (link.includes('.mp4')) {
                                streams.push({
                                    name: "Kisskh MP4",
                                    title: `Kisskh Stream`,
                                    url: link,
                                    quality: "Auto", // Biasanya 720p/1080p
                                    headers: { "Referer": MAIN_URL },
                                    provider: "kisskh"
                                });
                            }
                        });
                        
                        resolve(streams);
                    });
            })
            .catch(err => {
                console.error("Kisskh Error:", err);
                resolve([]); // Jangan reject, kembalikan array kosong
            });
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getStreams };
} else {
    global.getStreams = getStreams;
}
