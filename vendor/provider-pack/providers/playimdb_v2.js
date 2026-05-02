/**
 * PlayIMDb V2 - Shares the hardened core from playimdb.js
 *
 * Kept as a separate provider id so existing PROVIDER_PRIORITY/cache layouts
 * remain valid, but reuses the same robust extraction logic.
 */

const playimdb = require('./playimdb.js');

async function getStreams(tmdbId, type, season, episode) {
    const streams = await playimdb.getStreams(tmdbId, type, season, episode);
    // Tag streams with playimdb_v2 provider id for ranking / debugging
    return streams.map((stream) => ({ ...stream, provider: 'playimdb_v2' }));
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getStreams };
} else {
    global.getStreams = getStreams;
}
