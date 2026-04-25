import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const { copyFile, mkdir, readFile, rename, rm, writeFile } = fsPromises;

const FLUSH_DELAY_MS = 5000;
const USERS_FILE = path.join(config.CACHE_DIR, 'analytics', 'users.json');
const USERS_BACKUP_FILE = `${USERS_FILE}.bak`;
const USERS_TEMP_FILE = `${USERS_FILE}.tmp`;
const BOT_USER_AGENT_PATTERN = /\b(bot|crawler|spider|validator|preview|headless|curl|wget|python-requests|go-http-client|facebookexternalhit|slackbot|discordbot)\b/i;

const nowIso = () => new Date().toISOString();

const getClientIp = (headers, fallbackIp) => {
  const forwarded = headers['x-forwarded-for'];

  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return String(fallbackIp || '').trim();
};

const getTrackedPathType = (pathname) => {
  if (pathname === '/' || pathname === '/configure') {
    return 'configure';
  }

  if (
    pathname === '/manifest.json'
    || pathname === '/stremio/manifest.json'
    || pathname.endsWith('/manifest.json')
  ) {
    return 'manifest';
  }

  if (
    pathname === '/stream'
    || pathname === '/http-stream'
    || pathname === '/stream/http'
    || pathname === '/stream/torrent'
    || pathname.startsWith('/stream/')
    || pathname.startsWith('/stremio/stream/')
    || pathname.includes('/stream/')
  ) {
    return 'stream';
  }

  return null;
};

const isObviousBot = (headers) => {
  const userAgent = String(headers?.['user-agent'] || '').trim();

  if (!userAgent) {
    return false;
  }

  return BOT_USER_AGENT_PATTERN.test(userAgent);
};

const createEmptyEntry = () => ({
  firstSeenAt: nowIso(),
  lastSeenAt: nowIso(),
  hits: 0,
  humanHits: 0,
  botHits: 0,
  streamHits: 0,
  manifestHits: 0,
  configureHits: 0
});

const getEntryLastSeenMs = (entry) => Date.parse(entry?.lastSeenAt || '') || 0;
const classifyEntry = (entry = {}) => {
  const humanOnly = entry.humanHits > 0 && entry.botHits === 0;
  const botOnly = entry.botHits > 0 && entry.humanHits === 0;
  const mixed = entry.botHits > 0 && entry.humanHits > 0;

  return {
    humanOnly,
    botOnly,
    mixed,
    streamUser: humanOnly && entry.streamHits > 0,
    configureUser: humanOnly && entry.configureHits > 0
  };
};

const createEmptyBaseline = () => ({
  totalUsers: 0,
  activeUsers24h: 0,
  activeUsers7d: 0,
  totalTrackedRequests: 0,
  rawUniqueClients: 0,
  rawTrackedRequests: 0,
  botClients: 0,
  botRequests: 0,
  mixedClients: 0,
  streamUsers: 0,
  streamRequests: 0,
  manifestRequests: 0,
  configureUsers: 0,
  configureRequests: 0
});

const MONOTONIC_STAT_KEYS = Object.freeze([
  'totalUsers',
  'totalTrackedRequests',
  'rawUniqueClients',
  'rawTrackedRequests',
  'botClients',
  'botRequests',
  'mixedClients',
  'streamUsers',
  'streamRequests',
  'manifestRequests',
  'configureUsers',
  'configureRequests'
]);

const toSafeInteger = (value) => Number.isInteger(value) && value > 0 ? value : 0;
const toPositiveNumberOrNull = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const normalizeStringArray = (value) => Array.isArray(value)
  ? value.map((item) => String(item || '').trim()).filter(Boolean)
  : [];

const normalizePlainObject = (value, fallback) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : fallback;

const createStreamSearchKey = ({
  tmdbId,
  mediaType,
  season = null,
  episode = null,
  providers = [],
  qualityPriority = [],
  streamOptions = {}
}) => JSON.stringify({
  tmdbId,
  mediaType,
  season,
  episode,
  providers,
  qualityPriority,
  streamOptions
});

const normalizeStreamSearchInput = (input = {}) => {
  const tmdbId = toPositiveNumberOrNull(input.tmdbId);
  const mediaType = String(input.mediaType || '').trim().toLowerCase();

  if (!tmdbId || !['movie', 'series'].includes(mediaType)) {
    return null;
  }

  const season = input.season === null || input.season === undefined
    ? null
    : toPositiveNumberOrNull(input.season);
  const episode = input.episode === null || input.episode === undefined
    ? null
    : toPositiveNumberOrNull(input.episode);

  if (mediaType === 'series' && (!season || !episode)) {
    return null;
  }

  return {
    imdbId: String(input.imdbId || '').trim(),
    tmdbId,
    mediaType,
    season,
    episode,
    providers: normalizeStringArray(input.providers),
    qualityPriority: normalizeStringArray(input.qualityPriority),
    streamOptions: normalizePlainObject(input.streamOptions, {})
  };
};

const normalizeStreamSearchEntry = (entry = {}) => {
  const input = normalizeStreamSearchInput(entry);

  if (!input) {
    return null;
  }

  return {
    ...input,
    firstSeenAt: entry.firstSeenAt || nowIso(),
    lastSeenAt: entry.lastSeenAt || nowIso(),
    hits: Number.isInteger(entry.hits) ? entry.hits : 0,
    uniqueUsers: Number.isInteger(entry.uniqueUsers) ? entry.uniqueUsers : 0,
    recentUserFingerprints: normalizeStringArray(entry.recentUserFingerprints)
      .slice(-config.POPULAR_STREAM_SEARCH_MAX_USERS_PER_ENTRY)
  };
};

const normalizeBaseline = (baseline = {}) => {
  const normalized = createEmptyBaseline();

  if (!baseline || typeof baseline !== 'object') {
    return normalized;
  }

  for (const key of Object.keys(normalized)) {
    normalized[key] = toSafeInteger(baseline[key]);
  }

  return normalized;
};

const createEmptyStatsFloor = () => Object.fromEntries(
  MONOTONIC_STAT_KEYS.map((key) => [key, 0])
);

const normalizeStatsFloor = (statsFloor = {}) => {
  const normalized = createEmptyStatsFloor();

  if (!statsFloor || typeof statsFloor !== 'object') {
    return normalized;
  }

  for (const key of MONOTONIC_STAT_KEYS) {
    normalized[key] = toSafeInteger(statsFloor[key]);
  }

  return normalized;
};

const parseEnvBaseline = () => {
  const raw = String(config.USER_TRACKER_BASELINE_JSON || '').trim();

  if (!raw) {
    return createEmptyBaseline();
  }

  try {
    return normalizeBaseline(JSON.parse(raw));
  } catch (error) {
    logger.warn('user tracker env baseline parse failed', { error });
    return createEmptyBaseline();
  }
};

const readJsonFile = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));

export class UserTrackerService {
  constructor() {
    this.entries = new Map();
    this.totalRequests = 0;
    this.totalHumanRequests = 0;
    this.totalBotRequests = 0;
    this.totalStreamRequests = 0;
    this.totalManifestRequests = 0;
    this.totalConfigureRequests = 0;
    this.baseline = createEmptyBaseline();
    this.statsFloor = createEmptyStatsFloor();
    this.streamSearches = new Map();
    this.flushTimer = null;
    this.flushInFlight = null;
  }

  async initialize() {
    await mkdir(path.dirname(USERS_FILE), { recursive: true });
    this.applyConfiguredBaselineFloor();

    setTimeout(() => {
      this.loadPersistedStateInBackground().catch((error) => {
        logger.warn('user tracker background state load failed', { error });
      });
    }, 0).unref?.();
  }

  async loadPersistedStateInBackground() {
    const payload = await this.readPersistedState();

    if (!payload) {
      return;
    }

    try {
      this.totalRequests = Number.isInteger(payload.totalRequests) ? payload.totalRequests : 0;
      this.totalHumanRequests = Number.isInteger(payload.totalHumanRequests) ? payload.totalHumanRequests : 0;
      this.totalBotRequests = Number.isInteger(payload.totalBotRequests) ? payload.totalBotRequests : 0;
      this.totalStreamRequests = Number.isInteger(payload.totalStreamRequests) ? payload.totalStreamRequests : 0;
      this.totalManifestRequests = Number.isInteger(payload.totalManifestRequests) ? payload.totalManifestRequests : 0;
      this.totalConfigureRequests = Number.isInteger(payload.totalConfigureRequests) ? payload.totalConfigureRequests : 0;
      this.baseline = normalizeBaseline(payload.baseline);
      this.statsFloor = normalizeStatsFloor(payload.statsFloor);

      if (payload.users && typeof payload.users === 'object') {
        for (const [fingerprint, user] of Object.entries(payload.users)) {
          this.entries.set(fingerprint, {
            firstSeenAt: user.firstSeenAt || nowIso(),
            lastSeenAt: user.lastSeenAt || nowIso(),
            hits: Number.isInteger(user.hits) ? user.hits : 0,
            humanHits: Number.isInteger(user.humanHits) ? user.humanHits : 0,
            botHits: Number.isInteger(user.botHits) ? user.botHits : 0,
            streamHits: Number.isInteger(user.streamHits) ? user.streamHits : 0,
            manifestHits: Number.isInteger(user.manifestHits) ? user.manifestHits : 0,
            configureHits: Number.isInteger(user.configureHits) ? user.configureHits : 0
          });
        }
      }

      if (payload.streamSearches && typeof payload.streamSearches === 'object') {
        for (const [key, entry] of Object.entries(payload.streamSearches)) {
          const normalizedEntry = normalizeStreamSearchEntry(entry);

          if (normalizedEntry) {
            this.streamSearches.set(key, normalizedEntry);
          }
        }
      }

      this.pruneEntries();
      this.pruneStreamSearches();
      this.migrateStatsFloorToBaseline();
      this.applyConfiguredBaselineFloor();
    } catch (error) {
      logger.warn('user tracker state load failed', { error });
    }
  }

  async readPersistedState() {
    try {
      return await readJsonFile(USERS_FILE);
    } catch (primaryError) {
      if (primaryError.code !== 'ENOENT') {
        logger.warn('user tracker primary state load failed', { error: primaryError });
      }

      try {
        return await readJsonFile(USERS_BACKUP_FILE);
      } catch (backupError) {
        if (backupError.code !== 'ENOENT') {
          logger.warn('user tracker backup state load failed', { error: backupError });
        }

        return null;
      }
    }
  }

  trackRequest(req) {
    const pathname = req.path || '';
    const trackedPathType = getTrackedPathType(pathname);

    if (!trackedPathType) {
      return;
    }

    const fingerprint = this.getFingerprint(req);
    const entry = this.entries.get(fingerprint) || createEmptyEntry();
    const botRequest = isObviousBot(req.headers || {});

    entry.lastSeenAt = nowIso();
    entry.hits += 1;

    if (botRequest) {
      entry.botHits += 1;
      this.totalBotRequests += 1;
    } else {
      entry.humanHits += 1;
      this.totalHumanRequests += 1;
    }

    if (trackedPathType === 'stream') {
      entry.streamHits += 1;
      this.totalStreamRequests += 1;
    } else if (trackedPathType === 'manifest') {
      entry.manifestHits += 1;
      this.totalManifestRequests += 1;
    } else if (trackedPathType === 'configure') {
      entry.configureHits += 1;
      this.totalConfigureRequests += 1;
    }

    this.entries.set(fingerprint, entry);
    this.pruneEntries();
    this.totalRequests += 1;
    this.scheduleFlush();
  }

  trackStreamSearch(req, input) {
    const normalizedInput = normalizeStreamSearchInput(input);

    if (!normalizedInput || isObviousBot(req.headers || {})) {
      return;
    }

    const fingerprint = this.getFingerprint(req);
    const key = createStreamSearchKey(normalizedInput);
    const entry = this.streamSearches.get(key) || {
      ...normalizedInput,
      firstSeenAt: nowIso(),
      lastSeenAt: nowIso(),
      hits: 0,
      uniqueUsers: 0,
      recentUserFingerprints: []
    };

    entry.lastSeenAt = nowIso();
    entry.hits += 1;

    if (!entry.recentUserFingerprints.includes(fingerprint)) {
      entry.uniqueUsers += 1;
      entry.recentUserFingerprints.push(fingerprint);

      if (entry.recentUserFingerprints.length > config.POPULAR_STREAM_SEARCH_MAX_USERS_PER_ENTRY) {
        entry.recentUserFingerprints = entry.recentUserFingerprints.slice(-config.POPULAR_STREAM_SEARCH_MAX_USERS_PER_ENTRY);
      }
    }

    this.streamSearches.set(key, entry);
    this.pruneStreamSearches();
    this.scheduleFlush();
  }

  pruneEntries(maxEntries = config.USER_TRACKER_MAX_ENTRIES) {
    if (this.entries.size <= maxEntries) {
      return;
    }

    const overflowCount = this.entries.size - maxEntries;
    const oldestFingerprints = Array.from(this.entries.entries())
      .sort((left, right) => getEntryLastSeenMs(left[1]) - getEntryLastSeenMs(right[1]))
      .slice(0, overflowCount)
      .map(([fingerprint]) => fingerprint);

    for (const fingerprint of oldestFingerprints) {
      const entry = this.entries.get(fingerprint);

      if (entry) {
        this.promoteEntryToBaseline(entry);
      }

      this.entries.delete(fingerprint);
    }
  }

  handleMemoryPressure({ critical = false } = {}) {
    const targetEntries = critical
      ? Math.max(1000, Math.floor(config.USER_TRACKER_MAX_ENTRIES / 4))
      : Math.max(1000, Math.floor(config.USER_TRACKER_MAX_ENTRIES / 2));

    this.pruneEntries(targetEntries);
    this.pruneStreamSearches(critical
      ? Math.max(25, Math.floor(config.POPULAR_STREAM_SEARCH_MAX_ENTRIES / 4))
      : Math.max(50, Math.floor(config.POPULAR_STREAM_SEARCH_MAX_ENTRIES / 2)));
  }

  pruneStreamSearches(maxEntries = config.POPULAR_STREAM_SEARCH_MAX_ENTRIES) {
    if (this.streamSearches.size <= maxEntries) {
      return;
    }

    const overflowCount = this.streamSearches.size - maxEntries;
    const oldestKeys = Array.from(this.streamSearches.entries())
      .sort((left, right) => Date.parse(left[1].lastSeenAt || '') - Date.parse(right[1].lastSeenAt || ''))
      .slice(0, overflowCount)
      .map(([key]) => key);

    for (const key of oldestKeys) {
      this.streamSearches.delete(key);
    }
  }

  getPopularStreamSearches({ limit = config.POPULAR_STREAM_PREWARM_LIMIT, maxAgeHours = config.POPULAR_STREAM_PREWARM_MAX_AGE_HOURS } = {}) {
    const cutoffMs = Date.now() - (maxAgeHours * 60 * 60 * 1000);

    return Array.from(this.streamSearches.entries())
      .filter(([, entry]) => (Date.parse(entry.lastSeenAt || '') || 0) >= cutoffMs)
      .sort((left, right) =>
        (right[1].uniqueUsers - left[1].uniqueUsers)
        || (right[1].hits - left[1].hits)
        || ((Date.parse(right[1].lastSeenAt || '') || 0) - (Date.parse(left[1].lastSeenAt || '') || 0)))
      .slice(0, limit)
      .map(([key, entry]) => ({
        key,
        imdbId: entry.imdbId,
        tmdbId: entry.tmdbId,
        mediaType: entry.mediaType,
        season: entry.season,
        episode: entry.episode,
        providers: [...entry.providers],
        qualityPriority: [...entry.qualityPriority],
        streamOptions: { ...entry.streamOptions },
        hits: entry.hits,
        uniqueUsers: entry.uniqueUsers,
        lastSeenAt: entry.lastSeenAt
      }));
  }

  getStats() {
    return this.computeStatsRaw();
  }

  computeStatsRaw() {
    const now = Date.now();
    let active24h = 0;
    let active7d = 0;
    let totalHumanUsers = 0;
    let streamUsers = 0;
    let configureUsers = 0;
    let botClients = 0;
    let mixedClients = 0;

    for (const entry of this.entries.values()) {
      const lastSeenMs = Date.parse(entry.lastSeenAt || '');
      const { humanOnly, botOnly, mixed, streamUser, configureUser } = classifyEntry(entry);

      if (humanOnly) {
        totalHumanUsers += 1;

        if (streamUser) {
          streamUsers += 1;
        }

        if (configureUser) {
          configureUsers += 1;
        }
      } else if (botOnly) {
        botClients += 1;
      } else if (mixed) {
        mixedClients += 1;
      }

      if (!humanOnly || !Number.isFinite(lastSeenMs)) {
        continue;
      }

      if (now - lastSeenMs <= 24 * 60 * 60 * 1000) {
        active24h += 1;
      }

      if (now - lastSeenMs <= 7 * 24 * 60 * 60 * 1000) {
        active7d += 1;
      }
    }

    return {
      totalUsers: this.baseline.totalUsers + totalHumanUsers,
      activeUsers24h: active24h,
      activeUsers7d: active7d,
      totalTrackedRequests: this.baseline.totalTrackedRequests + this.totalHumanRequests,
      rawUniqueClients: this.baseline.rawUniqueClients + this.entries.size,
      rawTrackedRequests: this.baseline.rawTrackedRequests + this.totalRequests,
      botClients: this.baseline.botClients + botClients,
      botRequests: this.baseline.botRequests + this.totalBotRequests,
      mixedClients: this.baseline.mixedClients + mixedClients,
      streamUsers: this.baseline.streamUsers + streamUsers,
      streamRequests: this.baseline.streamRequests + this.totalStreamRequests,
      manifestRequests: this.baseline.manifestRequests + this.totalManifestRequests,
      configureUsers: this.baseline.configureUsers + configureUsers,
      configureRequests: this.baseline.configureRequests + this.totalConfigureRequests,
      popularStreamSearches: this.streamSearches.size
    };
  }

  promoteEntryToBaseline(entry) {
    const { humanOnly, botOnly, mixed, streamUser, configureUser } = classifyEntry(entry);

    this.baseline.rawUniqueClients += 1;

    if (humanOnly) {
      this.baseline.totalUsers += 1;

      if (streamUser) {
        this.baseline.streamUsers += 1;
      }

      if (configureUser) {
        this.baseline.configureUsers += 1;
      }

      return;
    }

    if (botOnly) {
      this.baseline.botClients += 1;
      return;
    }

    if (mixed) {
      this.baseline.mixedClients += 1;
    }
  }

  migrateStatsFloorToBaseline() {
    const hasFloor = MONOTONIC_STAT_KEYS.some((key) => toSafeInteger(this.statsFloor[key]) > 0);

    this.baseline.activeUsers24h = 0;
    this.baseline.activeUsers7d = 0;

    if (!hasFloor) {
      this.statsFloor = createEmptyStatsFloor();
      return;
    }

    const currentStats = this.computeStatsRaw();
    let migrated = false;

    for (const key of MONOTONIC_STAT_KEYS) {
      const floorValue = toSafeInteger(this.statsFloor[key]);
      const currentValue = toSafeInteger(currentStats[key]);

      if (floorValue > currentValue) {
        this.baseline[key] += floorValue - currentValue;
        migrated = true;
      }
    }

    this.statsFloor = createEmptyStatsFloor();

    if (migrated) {
      this.scheduleFlush();
    }
  }

  applyConfiguredBaselineFloor() {
    const configuredBaseline = parseEnvBaseline();
    const currentStats = this.computeStatsRaw();
    let raised = false;

    for (const key of MONOTONIC_STAT_KEYS) {
      const targetValue = toSafeInteger(configuredBaseline[key]);
      const currentValue = toSafeInteger(currentStats[key]);

      if (targetValue > currentValue) {
        this.baseline[key] += targetValue - currentValue;
        raised = true;
      }
    }

    if (raised) {
      this.scheduleFlush();
    }
  }

  async close() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    await this.flush();
  }

  getFingerprint(req) {
    const ip = getClientIp(req.headers || {}, req.ip);
    const userAgent = String(req.headers?.['user-agent'] || '').trim();
    const language = String(req.headers?.['accept-language'] || '').trim();
    const payload = `${ip}|${userAgent}|${language}`;

    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  scheduleFlush() {
    if (this.flushTimer || this.flushInFlight) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((error) => {
        logger.warn('user tracker flush failed', { error });
      });
    }, FLUSH_DELAY_MS);

    this.flushTimer.unref();
  }

  async flush() {
    if (this.flushInFlight) {
      await this.flushInFlight;
      return;
    }

    const payload = {
      totalRequests: this.totalRequests,
      totalHumanRequests: this.totalHumanRequests,
      totalBotRequests: this.totalBotRequests,
      totalStreamRequests: this.totalStreamRequests,
      totalManifestRequests: this.totalManifestRequests,
      totalConfigureRequests: this.totalConfigureRequests,
      baseline: this.baseline,
      statsFloor: this.statsFloor,
      users: Object.fromEntries(this.entries.entries()),
      streamSearches: Object.fromEntries(this.streamSearches.entries())
    };

    this.flushInFlight = this.writePersistedState(payload);

    try {
      await this.flushInFlight;
    } finally {
      this.flushInFlight = null;
    }
  }

  async writePersistedState(payload) {
    await mkdir(path.dirname(USERS_FILE), { recursive: true });
    await writeFile(USERS_TEMP_FILE, JSON.stringify(payload));
    await copyFile(USERS_FILE, USERS_BACKUP_FILE).catch((error) => {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    });
    await rename(USERS_TEMP_FILE, USERS_FILE);
    await rm(USERS_TEMP_FILE, { force: true }).catch(() => {});
  }
}
