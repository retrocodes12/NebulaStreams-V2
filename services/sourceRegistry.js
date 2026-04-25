import crypto from 'node:crypto';

import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

export class SourceRegistry {
  constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
    this.cleanupTimer = setInterval(() => {
      this.removeExpired();
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  register({ type, source, headers = null, metadata = null, fallback = null }) {
    const id = crypto.randomBytes(12).toString('hex');
    const expiresAt = Date.now() + this.ttlMs;

    this.entries.set(id, {
      type,
      source,
      headers: headers && Object.keys(headers).length > 0 ? { ...headers } : null,
      metadata: metadata ? { ...metadata } : null,
      fallback: fallback ? {
        type: fallback.type,
        source: fallback.source,
        headers: fallback.headers && Object.keys(fallback.headers).length > 0 ? { ...fallback.headers } : null,
        metadata: fallback.metadata ? { ...fallback.metadata } : null
      } : null,
      expiresAt,
      createdAt: Date.now(),
      lastAccessedAt: Date.now()
    });
    this.pruneEntries();

    return id;
  }

  get(id) {
    const entry = this.entries.get(id);

    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(id);
      return null;
    }

    entry.lastAccessedAt = Date.now();
    return {
      ...entry,
      headers: entry.headers ? { ...entry.headers } : null,
      metadata: entry.metadata ? { ...entry.metadata } : null,
      fallback: entry.fallback ? {
        type: entry.fallback.type,
        source: entry.fallback.source,
        headers: entry.fallback.headers ? { ...entry.fallback.headers } : null,
        metadata: entry.fallback.metadata ? { ...entry.fallback.metadata } : null
      } : null
    };
  }

  close() {
    clearInterval(this.cleanupTimer);
    this.entries.clear();
  }

  removeExpired() {
    const now = Date.now();

    for (const [id, entry] of this.entries.entries()) {
      if (entry.expiresAt <= now) {
        this.entries.delete(id);
      }
    }
  }

  pruneEntries(maxEntries = config.SOURCE_REGISTRY_MAX_ENTRIES) {
    this.removeExpired();

    if (this.entries.size <= maxEntries) {
      return;
    }

    const overflowCount = this.entries.size - maxEntries;
    const oldestIds = Array.from(this.entries.entries())
      .sort((left, right) => (left[1].lastAccessedAt || left[1].createdAt || 0) - (right[1].lastAccessedAt || right[1].createdAt || 0))
      .slice(0, overflowCount)
      .map(([id]) => id);

    for (const id of oldestIds) {
      this.entries.delete(id);
    }
  }

  handleMemoryPressure({ critical = false } = {}) {
    const targetEntries = critical
      ? Math.max(100, Math.floor(config.SOURCE_REGISTRY_MAX_ENTRIES / 4))
      : Math.max(100, Math.floor(config.SOURCE_REGISTRY_MAX_ENTRIES / 2));

    this.pruneEntries(targetEntries);
  }

  getStats() {
    return {
      entries: this.entries.size,
      ttlMs: this.ttlMs,
      activeFallbackEntries: Array.from(this.entries.values()).filter((entry) => entry.fallback).length
    };
  }
}
