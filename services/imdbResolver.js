import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import axios from 'axios';

import { config } from '../config.js';
import { createHttpError } from './streamManager.js';
import { logger } from '../utils/logger.js';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const STALE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [250, 750, 1500, 3000];
const { mkdir, readFile, writeFile } = fsPromises;

const sleep = (delayMs) => new Promise((resolve) => {
  const timer = setTimeout(resolve, delayMs);
  timer.unref?.();
});

const touchMapEntry = (map, key, value) => {
  map.delete(key);
  map.set(key, value);
};

const pruneMapByMaxEntries = (map, maxEntries) => {
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    return;
  }

  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;

    if (oldestKey === undefined) {
      break;
    }

    map.delete(oldestKey);
  }
};

export class ImdbResolverService {
  constructor() {
    this.cache = new Map();
    this.inFlight = new Map();
    this.cacheDir = path.join(config.CACHE_DIR, 'imdb-resolver');
    this.client = axios.create({
      baseURL: 'https://api.themoviedb.org/3',
      timeout: 12_000,
      headers: {
        Connection: 'close'
      },
      validateStatus: (status) => status >= 200 && status < 300
    });
  }

  getOverrideTmdbId(imdbId) {
    const rawOverride = config.IMDB_TMDB_OVERRIDES?.[imdbId];

    return Number.isInteger(rawOverride) && rawOverride > 0
      ? rawOverride
      : null;
  }

  handleMemoryPressure({ critical = false } = {}) {
    if (critical) {
      this.cache.clear();
      return;
    }

    pruneMapByMaxEntries(this.cache, Math.max(50, Math.floor(config.IMDB_RESOLVER_MEMORY_CACHE_MAX_ENTRIES / 4)));
  }

  async resolve({ imdbId, mediaType }) {
    const normalizedImdbId = String(imdbId || '').trim();
    const normalizedMediaType = mediaType === 'series' ? 'series' : 'movie';
    const cacheKey = `${normalizedMediaType}:${normalizedImdbId}`;
    const overrideTmdbId = this.getOverrideTmdbId(normalizedImdbId);

    if (overrideTmdbId) {
      await this.setCachedEntry(cacheKey, overrideTmdbId);
      return overrideTmdbId;
    }

    const cached = await this.getCachedEntry(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.tmdbId;
    }

    if (!/^tt\d+$/u.test(normalizedImdbId)) {
      throw createHttpError(400, 'Stremio id must use an IMDb tt prefix');
    }

    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey);
    }

    const resolution = this.resolveUncached({
      cacheKey,
      normalizedImdbId,
      normalizedMediaType,
      cached
    });

    this.inFlight.set(cacheKey, resolution);

    try {
      return await resolution;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  async resolveUncached({
    cacheKey,
    normalizedImdbId,
    normalizedMediaType,
    cached
  }) {
    let response = null;
    let lastError = null;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        response = await this.client.get(`/find/${normalizedImdbId}`, {
          params: {
            api_key: config.TMDB_API_KEY,
            external_source: 'imdb_id'
          }
        });
        break;
      } catch (error) {
        lastError = error;

        if (attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
        }
      }
    }

    if (!response) {
      if (cached?.tmdbId && cached.staleExpiresAt > Date.now()) {
        logger.warn('using stale imdb resolver cache entry', {
          imdbId: normalizedImdbId,
          mediaType: normalizedMediaType,
          tmdbId: cached.tmdbId,
          error: lastError
        });
        return cached.tmdbId;
      }

      throw createHttpError(502, `Failed to resolve IMDb id through TMDB: ${lastError?.message || 'unknown error'}`);
    }

    const results = normalizedMediaType === 'series'
      ? response.data?.tv_results
      : response.data?.movie_results;
    let tmdbId = Array.isArray(results) && results[0]?.id ? results[0].id : null;

    if (!tmdbId) {
      try {
        tmdbId = await this.resolveViaImdbTitleSearch({
          imdbId: normalizedImdbId,
          mediaType: normalizedMediaType
        });
      } catch (error) {
        logger.warn('imdb resolver fallback search failed', {
          imdbId: normalizedImdbId,
          mediaType: normalizedMediaType,
          error
        });
      }
    }

    if (!tmdbId) {
      return null;
    }

    await this.setCachedEntry(cacheKey, tmdbId);

    return tmdbId;
  }

  async resolveViaImdbTitleSearch({ imdbId, mediaType }) {
    const titleMeta = await this.fetchImdbTitleMetadata(imdbId);

    if (!titleMeta?.title) {
      return null;
    }

    const searchPath = mediaType === 'series' ? '/search/tv' : '/search/movie';
    const yearParamName = mediaType === 'series' ? 'first_air_date_year' : 'primary_release_year';
    const params = {
      api_key: config.TMDB_API_KEY,
      query: titleMeta.title
    };

    if (titleMeta.year) {
      params[yearParamName] = titleMeta.year;
    }

    const response = await this.client.get(searchPath, { params });
    const results = Array.isArray(response.data?.results) ? response.data.results : [];

    if (!results.length) {
      return null;
    }

    const normalizedWantedTitle = this.normalizeTitle(titleMeta.title);
    const wantedYear = titleMeta.year || null;
    const sorted = results
      .map((result) => {
        const title = mediaType === 'series'
          ? result.name || result.original_name || ''
          : result.title || result.original_title || '';
        const dateValue = mediaType === 'series' ? result.first_air_date : result.release_date;
        const year = typeof dateValue === 'string' && dateValue.length >= 4
          ? Number.parseInt(dateValue.slice(0, 4), 10)
          : null;
        const normalizedResultTitle = this.normalizeTitle(title);
        const titleMatches = normalizedResultTitle === normalizedWantedTitle;
        const yearDistance = wantedYear && year ? Math.abs(year - wantedYear) : 999;

        return {
          id: result.id,
          titleMatches,
          yearDistance,
          popularity: Number(result.popularity || 0)
        };
      })
      .filter((result) => Number.isInteger(result.id) && result.id > 0)
      .sort((left, right) => {
        if (left.titleMatches !== right.titleMatches) {
          return left.titleMatches ? -1 : 1;
        }

        if (left.yearDistance !== right.yearDistance) {
          return left.yearDistance - right.yearDistance;
        }

        return right.popularity - left.popularity;
      });

    return sorted[0]?.id || null;
  }

  async fetchImdbTitleMetadata(imdbId) {
    const response = await axios.get(`https://www.imdb.com/title/${imdbId}/`, {
      timeout: 12_000,
      headers: {
        Connection: 'close',
        'User-Agent': 'Mozilla/5.0'
      },
      validateStatus: (status) => status >= 200 && status < 300
    });
    const html = String(response.data || '');
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/u);

    if (nextDataMatch) {
      try {
        const payload = JSON.parse(nextDataMatch[1]);
        const titleText = payload?.props?.pageProps?.aboveTheFoldData?.titleText?.text
          || payload?.props?.pageProps?.mainColumnData?.titleText?.text
          || '';
        const yearValue = payload?.props?.pageProps?.aboveTheFoldData?.releaseYear?.year
          || payload?.props?.pageProps?.mainColumnData?.releaseYear?.year
          || null;

        if (titleText) {
          return {
            title: titleText.trim(),
            year: Number.isInteger(yearValue) ? yearValue : null
          };
        }
      } catch (error) {
        logger.warn('imdb resolver next-data parse failed', {
          imdbId,
          error
        });
      }
    }

    const titleMatch = html.match(/<title>\s*([^<]+?)\s*\((\d{4})\)\s*- IMDb\s*<\/title>/iu)
      || html.match(/<title>\s*([^<]+?)\s*- IMDb\s*<\/title>/iu);

    if (!titleMatch) {
      return null;
    }

    return {
      title: String(titleMatch[1] || '').trim(),
      year: titleMatch[2] ? Number.parseInt(titleMatch[2], 10) : null
    };
  }

  normalizeTitle(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, ' ')
      .trim();
  }

  getCacheFilePath(cacheKey) {
    return path.join(this.cacheDir, `${cacheKey.replaceAll(':', '__')}.json`);
  }

  async getCachedEntry(cacheKey) {
    const memoryEntry = this.cache.get(cacheKey);

    if (memoryEntry && memoryEntry.staleExpiresAt > Date.now()) {
      touchMapEntry(this.cache, cacheKey, memoryEntry);
      return memoryEntry;
    }

    const diskEntry = await this.getDiskCachedEntry(cacheKey);

    if (diskEntry) {
      this.cache.set(cacheKey, diskEntry);
      pruneMapByMaxEntries(this.cache, config.IMDB_RESOLVER_MEMORY_CACHE_MAX_ENTRIES);
      return diskEntry;
    }

    if (memoryEntry) {
      this.cache.delete(cacheKey);
    }

    return null;
  }

  async getDiskCachedEntry(cacheKey) {
    try {
      const payload = JSON.parse(await readFile(this.getCacheFilePath(cacheKey), 'utf8'));

      if (!payload || !payload.tmdbId || payload.staleExpiresAt <= Date.now()) {
        return null;
      }

      return {
        tmdbId: payload.tmdbId,
        expiresAt: payload.expiresAt,
        staleExpiresAt: payload.staleExpiresAt
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn('imdb resolver disk cache read failed', {
          cacheKey,
          error
        });
      }

      return null;
    }
  }

  async setCachedEntry(cacheKey, tmdbId) {
    const entry = {
      tmdbId,
      expiresAt: Date.now() + CACHE_TTL_MS,
      staleExpiresAt: Date.now() + STALE_CACHE_TTL_MS
    };

    touchMapEntry(this.cache, cacheKey, entry);
    pruneMapByMaxEntries(this.cache, config.IMDB_RESOLVER_MEMORY_CACHE_MAX_ENTRIES);

    try {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(this.getCacheFilePath(cacheKey), JSON.stringify(entry));
    } catch (error) {
      logger.warn('imdb resolver disk cache write failed', {
        cacheKey,
        error
      });
    }
  }
}
