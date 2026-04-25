import cheerio from 'cheerio-without-node-native';
import { getTMDBDetails, findBestTitleMatch } from './utils.js';
import { MAIN_URL, HEADERS } from './constants.js';

async function getStreams(tmdbId, mediaType = "movie", season = null, episode = null) {
    console.log(`[AllMovieLand] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);
    try {
        const mediaInfo = await getTMDBDetails(tmdbId, mediaType);
        console.log(`[AllMovieLand] TMDB Info: "${mediaInfo.title}" (${mediaInfo.year || "N/A"})`);
        
        const query = mediaInfo.title;
        const searchUrl = `${MAIN_URL}/index.php?story=${encodeURIComponent(query)}&do=search&subaction=search`;
        
        const res = await fetch(searchUrl, { headers: HEADERS });
        const html = await res.text();
        const $ = cheerio.load(html);
        
        const searchResults = [];
        $('article.short-mid').each((i, el) => {
            const title = $(el).find('a > h3').text().trim();
            const href = $(el).find('a').attr('href');
            
            const yearMatch = title.match(/(?<=\()[\d(\]]+(?=\))/);
            const year = yearMatch ? parseInt(yearMatch[0]) : null;

            searchResults.push({ title, href, year });
        });

        if (searchResults.length === 0) {
            console.log("[AllMovieLand] No search results found.");
            return [];
        }
        
        const bestMatch = findBestTitleMatch(mediaInfo, searchResults);
        const selectedMedia = bestMatch || searchResults[0];
        console.log(`[AllMovieLand] Selected: "${selectedMedia.title}" (${selectedMedia.href})`);
        
        const docRes = await fetch(selectedMedia.href, { headers: HEADERS });
        const docHtml = await docRes.text();
        const doc$ = cheerio.load(docHtml);
        
        const tabsContent = doc$('div.tabs__content script').html() || '';
        const playerScriptMatch = tabsContent.match(/const AwsIndStreamDomain\s*=\s*'([^']+)'/);
        const playerDomain = playerScriptMatch ? playerScriptMatch[1].replace(/\/$/, '') : null;
        const idMatch = tabsContent.match(/src:\s*'([^']+)'/);
        const id = idMatch ? idMatch[1] : null;

        if (!playerDomain || !id) {
            console.log("[AllMovieLand] Could not find player domain or ID.");
            return [];
        }

        const embedLink = `${playerDomain}/play/${id}`;
        const embedRes = await fetch(embedLink, { headers: { ...HEADERS, Referer: selectedMedia.href } });
        const embedHtml = await embedRes.text();
        const embed$ = cheerio.load(embedHtml);
        
        const lastScript = embed$('body > script').last().html() || '';
        const p3Match = lastScript.match(/let\s+p3\s*=\s*(\{.*\});/);
        
        if (!p3Match) {
            console.log("[AllMovieLand] No p3 JSON found in embed.");
            return [];
        }

        const json = JSON.parse(p3Match[1]);
        let fileUrl = json.file.replace(/\\\//g, '/');
        if (!fileUrl.startsWith('http')) fileUrl = `${playerDomain}${fileUrl}`;
        
        const fileRes = await fetch(fileUrl, {
            method: 'POST',
            headers: { ...HEADERS, 'X-CSRF-TOKEN': json.key, 'Referer': embedLink }
        });
        const fileText = await fileRes.text();
        
        let targetFiles = [];
        const parsedData = JSON.parse(fileText.replace(/,\]/g, ']'));

        if (mediaType === "movie") {
            targetFiles = parsedData.filter(s => s && s.file);
        } else if (mediaType === "tv") {
            const seasonData = parsedData.find(s => s.id == season);
            if (seasonData && seasonData.folder) {
                const episodeData = seasonData.folder.find(e => e.episode == episode);
                if (episodeData && episodeData.folder) {
                    targetFiles = episodeData.folder.filter(s => s && s.file);
                }
            }
        }

        if (targetFiles.length === 0) {
            console.log("[AllMovieLand] No streams found for the requested media.");
            return [];
        }

        const streams = [];

        await Promise.all(targetFiles.map(async (fileObj) => {
            try {
                const playlistFile = fileObj.file.replace(/^~/, '');
                const playlistUrl = `${playerDomain}/playlist/${playlistFile}.txt`;
                
                const postRes = await fetch(playlistUrl, {
                    method: 'POST',
                    headers: { ...HEADERS, 'X-CSRF-TOKEN': json.key, 'Referer': embedLink }
                });
                
                const m3u8Url = (await postRes.text()).trim();
                
                if (m3u8Url && m3u8Url.startsWith('http')) {
                    const qualityStr = fileObj.title || "Unknown";
                    streams.push({
                        name: "AllMovieLand",
                        title: `AllMovieLand - ${qualityStr}`,
                        url: m3u8Url,
                        quality: qualityStr,
                        headers: {
                            "Referer": `${playerDomain}/`,
                            "Origin": playerDomain,
                            "User-Agent": HEADERS["User-Agent"]
                        },
                        provider: "allmovieland"
                    });
                }
            } catch (e) {
                console.error(`[AllMovieLand] Failed to extract stream: ${e.message}`);
            }
        }));

        return streams;
    } catch (error) {
        console.error(`[AllMovieLand] Error: ${error.message}`);
        return [];
    }
}

module.exports = { getStreams };
