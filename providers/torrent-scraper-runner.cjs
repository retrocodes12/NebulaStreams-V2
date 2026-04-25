const provider = require('./torrent-scraper.cjs');

async function main() {
  const [, , tmdbId, mediaType = 'movie', season = '', episode = ''] = process.argv;

  try {
    const result = await provider.getStreams(
      Number.parseInt(tmdbId, 10),
      mediaType,
      season ? Number.parseInt(season, 10) : null,
      episode ? Number.parseInt(episode, 10) : null
    );

    process.stdout.write(JSON.stringify(Array.isArray(result) ? result : []));
  } catch {
    process.stdout.write('[]');
    process.exitCode = 1;
  }
}

main();
