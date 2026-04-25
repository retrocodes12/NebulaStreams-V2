import axios from 'axios';

const DEFAULT_INTERVAL_MINUTES = 14;
const DEFAULT_TIMEOUT_MS = 10_000;

const parseUrls = () => {
  const rawUrls = process.env.KEEP_ALIVE_URLS || process.env.URLS || '';

  return rawUrls
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
};

const parseIntervalMinutes = () => {
  const value = Number(process.env.KEEP_ALIVE_INTERVAL_MINUTES || DEFAULT_INTERVAL_MINUTES);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_INTERVAL_MINUTES;
};

const parseTimeoutMs = () => {
  const value = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
};

const formatNow = () => new Date().toISOString();

const urls = parseUrls();
const intervalMinutes = parseIntervalMinutes();
const timeoutMs = parseTimeoutMs();

if (urls.length === 0) {
  console.error('[keep-alive] No URLs configured. Set KEEP_ALIVE_URLS or URLS.');
  process.exit(1);
}

const pingUrl = async (url) => {
  try {
    const response = await axios.get(url, {
      timeout: timeoutMs,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        'User-Agent': 'NebulaStreams-KeepAlive/1.0'
      }
    });

    console.log(`[keep-alive] ${formatNow()} status=${response.status} url=${url}`);
  } catch (error) {
    console.error(`[keep-alive] ${formatNow()} failed url=${url} error=${error.message}`);
  }
};

const runCycle = async () => {
  await Promise.all(urls.map((url) => pingUrl(url)));
};

console.log(
  `[keep-alive] starting interval=${intervalMinutes}m timeoutMs=${timeoutMs} urls=${urls.length}`
);

await runCycle();

const timer = setInterval(() => {
  void runCycle();
}, intervalMinutes * 60 * 1000);

const shutdown = (signal) => {
  clearInterval(timer);
  console.log(`[keep-alive] stopping signal=${signal}`);
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
