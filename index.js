import crypto from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import express from 'express';

import { config } from './config.js';
import { CacheManager } from './services/cacheManager.js';
import { HttpProxyService } from './services/httpProxy.js';
import { ImdbResolverService } from './services/imdbResolver.js';
import { ProviderService } from './services/providerService.js';
import { ReverseProxyService } from './services/reverseProxy.js';
import { SourceRegistry } from './services/sourceRegistry.js';
import { StreamManager, HttpError } from './services/streamManager.js';
import { TorrentEngineService } from './services/torrentEngine.js';
import { UserTrackerService } from './services/userTracker.js';
import { logger } from './utils/logger.js';

const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const ADMIN_COOKIE_NAME = 'nebulastreams_admin';
const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CPU_SAMPLE_WINDOW_MS = 200;
const { readFile } = fsPromises;

const sleep = (delayMs) => new Promise((resolve) => {
  const timer = setTimeout(resolve, delayMs);
  timer.unref?.();
});

const sampleCpuTimes = () => os.cpus().reduce((totals, cpu) => {
  const cpuTotal = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);

  return {
    idle: totals.idle + cpu.times.idle,
    total: totals.total + cpuTotal
  };
}, { idle: 0, total: 0 });

const getSystemMemorySnapshot = async () => {
  try {
    const meminfo = await readFile('/proc/meminfo', 'utf8');
    const values = Object.fromEntries(meminfo
      .split('\n')
      .map((line) => line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/u))
      .filter(Boolean)
      .map((match) => [match[1], Number.parseInt(match[2], 10) * 1024]));
    const totalMemoryBytes = values.MemTotal || os.totalmem();
    const availableMemoryBytes = values.MemAvailable || values.MemFree || os.freemem();

    return {
      totalMemoryBytes,
      availableMemoryBytes,
      freeMemoryBytes: values.MemFree || os.freemem()
    };
  } catch {
    return {
      totalMemoryBytes: os.totalmem(),
      availableMemoryBytes: os.freemem(),
      freeMemoryBytes: os.freemem()
    };
  }
};

const getSystemStats = async () => {
  const start = sampleCpuTimes();
  await sleep(CPU_SAMPLE_WINDOW_MS);
  const end = sampleCpuTimes();
  const totalDelta = Math.max(1, end.total - start.total);
  const idleDelta = Math.max(0, end.idle - start.idle);
  const cpuUsagePercent = Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
  const { totalMemoryBytes, availableMemoryBytes, freeMemoryBytes } = await getSystemMemorySnapshot();
  const usedMemoryBytes = Math.max(0, totalMemoryBytes - availableMemoryBytes);
  const processMemory = process.memoryUsage();

  return {
    cpuUsagePercent,
    cpuCount: os.cpus().length,
    loadAverage: os.loadavg(),
    totalMemoryBytes,
    freeMemoryBytes,
    availableMemoryBytes,
    usedMemoryBytes,
    memoryUsagePercent: totalMemoryBytes > 0 ? (usedMemoryBytes / totalMemoryBytes) * 100 : 0,
    processRssBytes: processMemory.rss,
    processHeapUsedBytes: processMemory.heapUsed
  };
};

const formatBytes = (bytes) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes || 0);
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
};

const formatPercent = (value) => `${Number(value || 0).toFixed(1)}%`;
const formatAdminTimestamp = (value) => {
  if (!value) {
    return 'never';
  }

  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) {
    return 'never';
  }

  return new Date(timestamp).toLocaleString('en-IN', {
    hour12: false,
    timeZone: 'Asia/Kolkata'
  });
};
const formatDurationMs = (value) => {
  const duration = Number(value);
  if (!Number.isFinite(duration)) {
    return '-';
  }

  if (duration >= 1000) {
    return `${(duration / 1000).toFixed(1)}s`;
  }

  return `${Math.round(duration)}ms`;
};
const renderProviderStatusRows = (providers = []) => providers.map((provider) => {
  const status = String(provider.status || 'idle');
  const statusClass = status.replace(/[^a-z0-9-]/giu, '');
  const cooldown = provider.cooldownUntil
    ? `${Math.max(0, Math.ceil((provider.cooldownUntil - Date.now()) / 1000))}s`
    : '-';
  const lastResult = provider.lastResultCount === null || provider.lastResultCount === undefined
    ? '-'
    : String(provider.lastResultCount);
  const lastError = provider.lastError
    ? `<span class="provider-error" title="${escapeHtml(provider.lastError)}">${escapeHtml(provider.lastError)}</span>`
    : '<span class="muted-inline">-</span>';

  return `
          <tr>
            <td><strong>${escapeHtml(provider.label || provider.id)}</strong><span class="provider-id">${escapeHtml(provider.id)}</span></td>
            <td><span class="status-pill status-${escapeHtml(statusClass)}">${escapeHtml(status)}</span></td>
            <td>${escapeHtml(String(provider.activeRequests || 0))}</td>
            <td>${escapeHtml(lastResult)}</td>
            <td>${escapeHtml(formatDurationMs(provider.lastDurationMs))}</td>
            <td>${escapeHtml(String(provider.consecutiveFailures || 0))}</td>
            <td>${escapeHtml(cooldown)}</td>
            <td>${escapeHtml(formatAdminTimestamp(provider.lastFinishedAt || provider.lastCacheHitAt || provider.lastStartedAt))}</td>
            <td>${lastError}</td>
          </tr>`;
}).join('');

const getPublicBaseUrl = (req) => {
  if (config.PUBLIC_BASE_URL) {
    return config.PUBLIC_BASE_URL;
  }

  const host = String(req?.get?.('host') || '').trim();

  if (host) {
    return `${req.protocol}://${host}`;
  }

  return `http://127.0.0.1:${config.PORT}`;
};

const renderConfigurePage = ({ baseUrl, providers }) => {
  const providerIds = providers.map((provider) => provider.id);
  const providerHints = providers
    .slice(0, 12)
    .map((provider) => escapeHtml(provider.id))
    .join(', ');
  const donationPrimaryUrl = escapeHtml(String(config.DONATION_PRIMARY_URL || '').trim());
  const nowPaymentsWidgetUrl = escapeHtml(String(config.DONATION_NOWPAYMENTS_WIDGET_URL || '').trim());
  const hasDonationSupport = Boolean(
    config.DONATION_CRYPTO_ADDRESS ||
    config.DONATION_PRIMARY_URL ||
    config.DONATION_SECONDARY_URL ||
    nowPaymentsWidgetUrl
  );

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>NebulaStreams Configure</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #090d14;
        --bg-2: #0d121c;
        --sidebar: rgba(8, 12, 18, 0.92);
        --panel: rgba(17, 22, 33, 0.92);
        --panel-soft: rgba(255,255,255,0.035);
        --panel-soft-2: rgba(255,255,255,0.055);
        --border: rgba(255,255,255,0.08);
        --border-strong: rgba(255,255,255,0.12);
        --text: #eef3ff;
        --muted: #97a4c0;
        --accent: #6aa7ff;
        --accent-2: #8a7cff;
        --accent-3: #46d7b7;
        --danger: #ff98a8;
        --shadow: 0 28px 90px rgba(0, 0, 0, 0.4);
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        background:
          radial-gradient(circle at top left, rgba(106, 167, 255, 0.14), transparent 24%),
          radial-gradient(circle at top right, rgba(138, 124, 255, 0.14), transparent 22%),
          linear-gradient(180deg, var(--bg), var(--bg-2));
        color: var(--text);
        font: 15px/1.55 "Segoe UI", "SF Pro Text", "Helvetica Neue", sans-serif;
      }

      main {
        width: min(1400px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 20px 0 28px;
      }

      .app-shell {
        display: grid;
        grid-template-columns: 252px minmax(0, 1fr);
        gap: 20px;
        min-height: calc(100vh - 48px);
      }

      .sidebar {
        position: sticky;
        top: 20px;
        align-self: start;
        display: flex;
        flex-direction: column;
        gap: 18px;
        min-height: calc(100vh - 48px);
        padding: 18px;
        border-radius: 24px;
        border: 1px solid var(--border);
        background: linear-gradient(180deg, rgba(7, 11, 17, 0.95), rgba(10, 14, 22, 0.92));
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 4px 2px;
      }

      .brand-mark {
        width: 52px;
        height: 52px;
        border-radius: 16px;
        overflow: hidden;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.04);
        flex-shrink: 0;
      }

      .brand-mark img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .brand-copy h1 {
        margin: 0;
        font-size: 20px;
        line-height: 1.1;
      }

      .brand-copy p {
        margin: 4px 0 0;
        color: var(--muted);
        font-size: 12px;
      }

      .sidebar-nav {
        display: grid;
        gap: 8px;
      }

      .nav-item {
        appearance: none;
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        border-radius: 16px;
        border: 1px solid transparent;
        background: transparent;
        color: #d7e1f8;
        text-align: left;
        cursor: pointer;
        font: inherit;
      }

      .nav-item:hover {
        background: rgba(255,255,255,0.04);
        border-color: rgba(255,255,255,0.06);
      }

      .nav-item.is-active {
        background: linear-gradient(135deg, rgba(106,167,255,0.18), rgba(138,124,255,0.12));
        border-color: rgba(106,167,255,0.2);
        color: #f5f8ff;
      }

      .nav-index {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: 999px;
        background: rgba(255,255,255,0.06);
        font-size: 12px;
      }

      .sidebar-footer {
        margin-top: auto;
        padding: 16px;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.03);
      }

      .sidebar-footer strong {
        display: block;
        font-size: 13px;
        color: #eef3ff;
      }

      .sidebar-footer p {
        margin: 8px 0 0;
        color: var(--muted);
        font-size: 13px;
      }

      .workspace {
        display: grid;
        gap: 18px;
      }

      .hero {
        padding: 28px;
        border-radius: 24px;
        border: 1px solid var(--border);
        background: linear-gradient(180deg, rgba(16, 21, 32, 0.94), rgba(12, 17, 27, 0.92));
        box-shadow: var(--shadow);
      }

      .hero-tag {
        display: flex;
        align-items: center;
        gap: 8px;
        width: fit-content;
        padding: 7px 12px;
        border-radius: 999px;
        border: 1px solid rgba(106,167,255,0.18);
        background: rgba(106,167,255,0.08);
        color: #d7e8ff;
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        font-weight: 700;
      }

      .hero h2 {
        margin: 16px 0 8px;
        font-size: clamp(34px, 6vw, 48px);
        line-height: 1.03;
      }

      .hero p {
        max-width: 760px;
        margin: 0;
        color: var(--muted);
        font-size: 16px;
      }

      .hero-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 14px;
        margin-top: 18px;
      }

      .hero-chip {
        padding: 10px 12px;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.03);
        color: #dbe5ff;
        font-size: 13px;
      }

      .content-grid {
        display: grid;
        gap: 18px;
      }

      .two-column {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 18px;
      }

      .settings-card {
        border-radius: 24px;
        border: 1px solid var(--border);
        background: linear-gradient(180deg, rgba(17, 22, 33, 0.96), rgba(14, 18, 28, 0.94));
        box-shadow: 0 18px 50px rgba(0,0,0,0.18);
        overflow: hidden;
      }

      .settings-card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 0 0 18px;
      }

      .settings-card-inner {
        padding: 22px;
      }

      .card-badge {
        display: inline-flex;
        width: fit-content;
        padding: 8px 14px;
        border-radius: 0 0 16px 0;
        border-right: 1px solid var(--border-strong);
        border-bottom: 1px solid var(--border-strong);
        background: linear-gradient(135deg, rgba(106,167,255,0.08), rgba(138,124,255,0.06));
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #dfe9ff;
      }

      .card-title {
        margin: 0;
        font-size: 21px;
        font-weight: 700;
      }

      .card-description {
        margin: 8px 0 0;
        color: var(--muted);
        font-size: 14px;
      }

      .manifest-box {
        padding: 16px;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.03);
      }

      .manifest-label {
        margin: 0 0 8px;
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .manifest-url {
        margin: 0;
        font-size: 14px;
        color: #edf2ff;
        word-break: break-word;
      }

      .overview-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.2fr) minmax(260px, 0.8fr);
        gap: 16px;
        margin-top: 16px;
      }

      .meta-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 12px;
      }

      .meta-card {
        padding: 14px;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.025);
      }

      .meta-label {
        margin: 0;
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      .meta-value {
        margin: 8px 0 0;
        color: #eef3ff;
        font-size: 18px;
        font-weight: 700;
      }

      .field {
        margin-top: 18px;
      }

      .field-label {
        display: block;
        margin-bottom: 10px;
        color: #dee6fc;
        font-size: 13px;
      }

      .field-input {
        width: 100%;
        padding: 14px 16px;
        border: 1px solid var(--border);
        border-radius: 16px;
        background: rgba(255,255,255,0.03);
        color: var(--text);
        font: inherit;
        outline: none;
      }

      .field-input:focus {
        border-color: rgba(106,167,255,0.5);
        box-shadow: 0 0 0 4px rgba(106,167,255,0.12);
      }

      select.field-input {
        color-scheme: dark;
        background-color: #111621;
        color: var(--text);
      }

      select.field-input option {
        background: #111621;
        color: #eef3ff;
      }

      .field-help {
        margin-top: 10px;
        color: var(--muted);
        font-size: 13px;
      }

      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 14px;
      }

      button,
      .support-link {
        appearance: none;
        border: 0;
        border-radius: 14px;
        padding: 13px 16px;
        font: inherit;
        cursor: pointer;
        text-decoration: none;
        color: var(--text);
      }

      .primary-button {
        background: linear-gradient(135deg, var(--accent), var(--accent-2));
        color: #f8fbff;
        box-shadow: 0 12px 28px rgba(106,167,255,0.2);
      }

      .secondary-button,
      .mini-button,
      .support-link {
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.04);
        color: #eef3ff;
      }

      .mini-button {
        border-radius: 999px;
        padding: 10px 14px;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 16px;
      }

      .provider-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 10px;
        margin-top: 16px;
        max-height: 340px;
        overflow: auto;
      }

      .provider-option {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 14px;
        border-radius: 16px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.03);
        cursor: pointer;
      }

      .provider-option input {
        accent-color: #8b5cf6;
      }

      .provider-name {
        font-size: 14px;
        word-break: break-word;
      }

      .empty-state {
        margin-top: 16px;
        padding: 14px;
        border-radius: 16px;
        background: rgba(255,255,255,0.025);
        color: var(--muted);
      }

      .summary-strip {
        margin-top: 14px;
        padding: 12px 14px;
        border-radius: 16px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.025);
        color: #e9eeff;
        font-size: 14px;
      }

      .quality-list {
        display: grid;
        gap: 10px;
        margin-top: 16px;
      }

      .quality-row {
        display: grid;
        grid-template-columns: auto 1fr auto;
        align-items: center;
        gap: 12px;
        padding: 12px 14px;
        border-radius: 16px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.03);
      }

      .quality-rank {
        width: 28px;
        height: 28px;
        display: grid;
        place-items: center;
        border-radius: 999px;
        background: rgba(255,255,255,0.08);
        color: #dce7ff;
        font-size: 13px;
      }

      .quality-actions {
        display: flex;
        gap: 8px;
      }

      .arrow-button {
        width: 34px;
        height: 34px;
        border-radius: 12px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.05);
        color: var(--text);
        cursor: pointer;
      }

      .arrow-button:disabled {
        opacity: 0.35;
        cursor: default;
      }

      .option-group {
        margin-top: 18px;
        display: grid;
        gap: 12px;
      }

      .choice-grid {
        display: grid;
        gap: 10px;
      }

      .choice-card {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 12px;
        align-items: start;
        padding: 14px;
        border-radius: 16px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.03);
      }

      .choice-card input {
        margin-top: 2px;
        accent-color: #8b5cf6;
      }

      .choice-title {
        margin: 0;
        font-size: 14px;
        color: #eef2ff;
      }

      .choice-copy {
        margin: 4px 0 0;
        color: var(--muted);
        font-size: 13px;
      }

      .choice-grid {
        display: grid;
        gap: 10px;
      }

      .preset-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px;
      }

      .preset-card {
        width: 100%;
        display: grid;
        gap: 8px;
        text-align: left;
        padding: 16px;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.03);
        color: var(--text);
      }

      .preset-card:hover {
        border-color: rgba(106,167,255,0.24);
        background: rgba(255,255,255,0.04);
      }

      .preset-card.is-active {
        border-color: rgba(106,167,255,0.28);
        background: linear-gradient(135deg, rgba(106,167,255,0.12), rgba(138,124,255,0.08));
        box-shadow: inset 0 0 0 1px rgba(106,167,255,0.08);
      }

      .preset-name {
        margin: 0;
        font-size: 15px;
        font-weight: 700;
        color: #eef3ff;
      }

      .preset-copy {
        margin: 0;
        color: var(--muted);
        font-size: 13px;
      }

      .preset-status {
        margin-top: 14px;
        padding: 12px 14px;
        border-radius: 16px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.025);
        color: #dde7ff;
        font-size: 14px;
      }

      .three-column {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
      }

      .preview-grid {
        display: grid;
        grid-template-columns: minmax(140px, 180px) minmax(0, 1fr) auto;
        gap: 12px;
        margin-top: 16px;
      }

      .preview-result {
        margin-top: 16px;
        padding: 16px;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.025);
      }

      .preview-empty {
        color: var(--muted);
        font-size: 14px;
      }

      .stat-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 10px;
      }

      .stat-card {
        padding: 12px;
        border-radius: 16px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.035);
      }

      .stat-label {
        margin: 0;
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      .stat-value {
        margin: 6px 0 0;
        color: #eef2ff;
        font-size: 22px;
        font-weight: 700;
      }

      .reason-list,
      .sample-list {
        display: grid;
        gap: 8px;
        margin-top: 14px;
      }

      .diagnostic-group {
        display: grid;
        gap: 8px;
      }

      .reason-row,
      .sample-row {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 12px;
        border-radius: 14px;
        background: rgba(255,255,255,0.035);
        color: #dde5ff;
        font-size: 13px;
      }

      .sample-row {
        align-items: start;
        flex-direction: column;
      }

      .diagnostic-examples {
        display: grid;
        gap: 8px;
        padding-left: 10px;
      }

      .diagnostic-example {
        padding: 10px 12px;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.02);
      }

      .diagnostic-example strong {
        display: block;
        color: #eef3ff;
        font-size: 13px;
      }

      .diagnostic-meta,
      .sample-meta {
        color: var(--muted);
        font-size: 12px;
        margin-top: 4px;
      }

      .support-shell {
        display: grid;
        gap: 14px;
      }

      .support-card {
        padding: 18px;
        border-radius: 20px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.03);
      }

      .support-card h3 {
        margin: 0;
        font-size: 17px;
      }

      .support-card p {
        margin: 8px 0 0;
        color: var(--muted);
        font-size: 14px;
      }

      .support-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 14px;
      }

      .donate-toggle {
        background: linear-gradient(135deg, rgba(70,215,183,0.9), rgba(106,167,255,0.85));
        color: #081018;
        font-weight: 700;
      }

      .widget-panel {
        display: none;
        padding: 18px;
        border-radius: 20px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.03);
      }

      .widget-panel.open {
        display: block;
      }

      .widget-frame {
        display: block;
        width: min(100%, 420px);
        min-height: 600px;
        margin: 0 auto;
        border: 0;
        border-radius: 16px;
        background: #ffffff;
      }

      .flash {
        min-height: 20px;
        color: #e4ebff;
        font-size: 13px;
      }

      .notes-list {
        display: grid;
        gap: 10px;
      }

      .note-item {
        margin: 0;
        padding: 12px 14px;
        border-radius: 16px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.025);
        color: var(--muted);
        font-size: 14px;
      }

      .note-item strong {
        color: #edf2ff;
      }

      .disclaimer {
        margin-top: 16px;
        padding: 16px;
        border-radius: 18px;
        border: 1px solid rgba(255,152,168,0.18);
        background: rgba(255,152,168,0.05);
      }

      .disclaimer-text {
        margin: 0;
        color: #d5ddef;
        font-size: 14px;
        line-height: 1.6;
      }

      .disclaimer-text strong {
        color: var(--danger);
      }

      @media (max-width: 1160px) {
        .app-shell {
          grid-template-columns: 220px minmax(0, 1fr);
        }

        .two-column,
        .overview-grid {
          grid-template-columns: 1fr;
        }

        .three-column {
          grid-template-columns: 1fr 1fr;
        }
      }

      @media (max-width: 920px) {
        main {
          width: min(100vw, calc(100vw - 24px));
          padding-top: 12px;
        }

        .app-shell {
          grid-template-columns: 1fr;
        }

        .sidebar {
          position: static;
          min-height: 0;
        }

        .sidebar-nav {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      @media (max-width: 640px) {
        main {
          width: calc(100vw - 20px);
        }

        .hero,
        .settings-card-inner {
          padding: 18px;
        }

        .sidebar {
          padding: 14px;
        }

        .sidebar-nav {
          grid-template-columns: 1fr;
        }

        .preview-grid,
        .three-column {
          grid-template-columns: 1fr;
        }

        .actions {
          flex-direction: column;
        }
      }

      /* Sootio-inspired configure flow:
         - centered single control surface
         - compact top navigation instead of heavy side rail
         - softer, form-first cards
         This keeps NebulaStreams branding and structure intact. */
      body {
        background:
          radial-gradient(circle at 20% 0%, rgba(80, 146, 255, 0.16), transparent 28%),
          radial-gradient(circle at 80% 0%, rgba(62, 222, 180, 0.12), transparent 24%),
          linear-gradient(180deg, #09111c 0%, #0a1422 55%, #0b1626 100%);
        font: 15px/1.6 "Open Sans", "Segoe UI", "Helvetica Neue", sans-serif;
      }

      main {
        width: min(980px, calc(100vw - 28px));
        padding: 20px 0 32px;
      }

      .app-shell {
        grid-template-columns: 1fr;
        gap: 12px;
        min-height: 0;
      }

      .sidebar {
        position: static;
        min-height: 0;
        padding: 16px 18px;
        border-radius: 22px;
        background:
          linear-gradient(180deg, rgba(8, 17, 29, 0.92), rgba(9, 20, 34, 0.9));
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: 0 20px 54px rgba(0, 0, 0, 0.24);
      }

      .brand {
        justify-content: flex-start;
        padding: 2px 0 4px;
      }

      .brand-mark {
        width: 56px;
        height: 56px;
        border-radius: 18px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.24);
      }

      .brand-copy {
        text-align: left;
      }

      .brand-copy h1 {
        font-size: 24px;
        letter-spacing: -0.02em;
      }

      .brand-copy p {
        font-size: 13px;
        color: #9eb0ca;
      }

      .sidebar-nav {
        display: flex;
        flex-wrap: nowrap;
        gap: 10px;
        margin-top: 12px;
        overflow-x: auto;
        padding-bottom: 4px;
        scrollbar-width: thin;
      }

      .nav-item {
        flex: 0 0 auto;
        min-width: 132px;
        min-height: 52px;
        padding: 12px 14px;
        border-radius: 16px;
        background: rgba(255,255,255,0.028);
        border: 1px solid rgba(255,255,255,0.055);
      }

      .nav-item:hover {
        background: rgba(255,255,255,0.05);
        border-color: rgba(100, 255, 218, 0.14);
      }

      .nav-item.is-active {
        background: linear-gradient(135deg, rgba(85, 161, 255, 0.18), rgba(72, 209, 174, 0.14));
        border-color: rgba(100, 255, 218, 0.2);
      }

      .nav-index {
        width: 24px;
        height: 24px;
        font-size: 11px;
        background: rgba(255,255,255,0.08);
      }

      .sidebar-footer {
        display: none;
      }

      .workspace {
        padding: 14px;
        border-radius: 22px;
        background:
          linear-gradient(180deg, rgba(10, 23, 38, 0.92), rgba(9, 18, 30, 0.9));
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: 0 24px 72px rgba(0, 0, 0, 0.28);
      }

      .hero {
        padding: 18px 18px 16px;
        border-radius: 18px;
        background:
          linear-gradient(180deg, rgba(13, 28, 45, 0.9), rgba(10, 20, 33, 0.86));
        box-shadow: none;
      }

      .hero-tag {
        background: rgba(100, 255, 218, 0.08);
        border-color: rgba(100, 255, 218, 0.16);
        color: #c7fff1;
      }

      .hero h2 {
        margin-top: 14px;
        font-size: clamp(28px, 5vw, 38px);
        letter-spacing: -0.03em;
      }

      .hero p {
        font-size: 14px;
        max-width: 620px;
      }

      .hero-meta {
        gap: 8px;
        margin-top: 12px;
      }

      .hero-chip {
        padding: 8px 12px;
        border-radius: 999px;
        font-size: 12px;
      }

      .content-grid {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .settings-card {
        border-radius: 18px;
        background: rgba(255,255,255,0.028);
        box-shadow: none;
      }

      .settings-card-inner {
        padding: 16px;
      }

      .card-badge {
        padding: 7px 12px;
        border-radius: 0 0 14px 0;
      }

      .settings-card-header {
        padding-bottom: 14px;
      }

      .card-title {
        font-size: 18px;
        letter-spacing: -0.01em;
      }

      .card-description {
        margin-top: 6px;
        font-size: 13px;
        color: #99abc4;
      }

      .overview-grid,
      .two-column {
        gap: 14px;
      }

      .manifest-box,
      .meta-card,
      .summary-strip,
      .preset-status,
      .support-card,
      .preview-result,
      .note-item,
      .disclaimer,
      .quality-row,
      .provider-option,
      .choice-card,
      .preset-card,
      .stat-card,
      .reason-row,
      .sample-row,
      .diagnostic-example {
        background: rgba(255,255,255,0.03);
        border-color: rgba(255,255,255,0.065);
      }

      .provider-grid {
        max-height: 420px;
      }

      section[id] {
        scroll-margin-top: 18px;
      }

      #overview-section { order: 1; }
      #presets-section { order: 2; }
      #providers-section { order: 3; }
      .two-column { order: 4; }
      #preview-section { order: 5; }
      #notes-section { order: 6; }
      #support-section { order: 7; }

      .provider-option {
        transition: border-color 0.18s ease, background-color 0.18s ease, transform 0.18s ease;
      }

      .provider-option:hover {
        border-color: rgba(100, 255, 218, 0.16);
        background: rgba(255,255,255,0.045);
        transform: translateY(-1px);
      }

      .field {
        margin-top: 16px;
      }

      .field-label {
        margin-bottom: 8px;
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: #d7e4ff;
      }

      .field-input {
        padding: 13px 14px;
        border-radius: 14px;
        background: rgba(255,255,255,0.025);
      }

      .field-help {
        font-size: 12px;
        line-height: 1.5;
      }

      .actions {
        gap: 10px;
      }

      .primary-button,
      .donate-toggle {
        background: linear-gradient(135deg, #6fe6c3, #5a95ff);
        color: #07111a;
        font-weight: 700;
      }

      .secondary-button,
      .mini-button,
      .support-link {
        background: rgba(255,255,255,0.04);
      }

      .mini-button {
        padding: 9px 13px;
      }

      #overview-section {
        position: static;
      }

      @media (max-width: 920px) {
        main {
          width: min(100vw, calc(100vw - 18px));
        }

        .workspace {
          padding: 14px;
          border-radius: 22px;
        }
      }

      @media (max-width: 640px) {
        body {
          font-size: 14px;
        }

        main {
          width: calc(100vw - 12px);
          padding-top: 10px;
        }

        .sidebar,
        .workspace {
          padding: 14px;
          border-radius: 18px;
        }

        .brand {
          justify-content: flex-start;
        }

        .brand-copy h1 {
          font-size: 21px;
        }

        .hero,
        .settings-card-inner {
          padding: 16px;
        }

        .hero-meta {
          display: none;
        }

        .sidebar-nav {
          gap: 8px;
        }

        .nav-item {
          min-width: 118px;
          min-height: 48px;
          padding: 10px 12px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="app-shell">
        <aside class="sidebar">
          <div class="brand">
            <div class="brand-mark">
              <img src="${escapeHtml(baseUrl)}/assets/nebulastreams-icon.jpg" alt="NebulaStreams">
            </div>
            <div class="brand-copy">
              <h1>NebulaStreams</h1>
              <p>Configure add-on</p>
            </div>
          </div>

          <nav class="sidebar-nav">
            <button type="button" class="nav-item is-active" data-section-target="overview-section"><span>Install</span><span class="nav-index">01</span></button>
            <button type="button" class="nav-item" data-section-target="presets-section"><span>Presets</span><span class="nav-index">02</span></button>
            <button type="button" class="nav-item" data-section-target="providers-section"><span>Providers</span><span class="nav-index">03</span></button>
            <button type="button" class="nav-item" data-section-target="sorting-section"><span>Quality</span><span class="nav-index">04</span></button>
            <button type="button" class="nav-item" data-section-target="filters-section"><span>Filters</span><span class="nav-index">05</span></button>
            <button type="button" class="nav-item" data-section-target="preview-section"><span>Preview</span><span class="nav-index">06</span></button>
            <button type="button" class="nav-item" data-section-target="notes-section"><span>Notes</span><span class="nav-index">07</span></button>
            <button type="button" class="nav-item" data-section-target="support-section"><span>Support</span><span class="nav-index">08</span></button>
          </nav>

          <div class="sidebar-footer">
            <strong>Live manifest builder</strong>
            <p>Every provider, sorting, and filter change updates the install URL immediately.</p>
          </div>
        </aside>

        <section class="workspace">
          <section class="hero">
            <div class="hero-tag">NebulaStreams Config</div>
            <h2>Set it up fast and install it clean.</h2>
            <p>Choose providers, set quality order, apply a few practical filters, and install the manifest.</p>
            <div class="hero-meta">
              <div class="hero-chip">Install-first flow</div>
              <div class="hero-chip">Live manifest</div>
              <div class="hero-chip">Quick preview</div>
            </div>
          </section>

          <div class="content-grid">
            <section class="settings-card" id="support-section">
              <div class="card-badge">Support</div>
              <div class="settings-card-inner">
                <div class="settings-card-header">
                  <div>
                    <h3 class="card-title">Support NebulaStreams</h3>
                    <p class="card-description">The addon is free. If it makes your setup easier, support helps keep the backend stable and maintained.</p>
                  </div>
                </div>

                <div class="support-shell">
                  ${hasDonationSupport ? `
                    <div class="support-card">
                      <h3>This addon is completely free.</h3>
                      <p>If NebulaStreams has made your setup easier, support helps keep the servers online for everyone using it right now. Traffic has grown a lot, and keeping it alive now means paying for hosting, tunnels, and the time spent fixing crashes when providers break.</p>
                      <div class="support-actions">
                        <button type="button" class="donate-toggle" id="donate-toggle">Support</button>
                        ${donationPrimaryUrl ? `<a class="support-link" href="${donationPrimaryUrl}" target="_blank" rel="noopener">Support on Ko-fi</a>` : ''}
                        <a class="support-link" href="${escapeHtml(baseUrl)}/donate">More ways to support</a>
                      </div>
                    </div>
                  ` : `
                    <div class="support-card">
                      <h3>Feeling generous?</h3>
                      <p>If NebulaStreams has made your setup easier, support helps keep the backend stable for everyone using it right now. Traffic has grown a lot, and keeping it alive now means paying for hosting, tunnels, and the time spent fixing crashes when providers break.</p>
                      <div class="support-actions">
                        ${donationPrimaryUrl ? `<a class="support-link" href="${donationPrimaryUrl}" target="_blank" rel="noopener">Support on Ko-fi</a>` : ''}
                        <a class="support-link" href="${escapeHtml(baseUrl)}/donate">Support</a>
                      </div>
                    </div>
                  `}

                  ${nowPaymentsWidgetUrl ? `
                    <div class="widget-panel" id="donation-widget-panel">
                      <iframe
                        class="widget-frame"
                        src="${nowPaymentsWidgetUrl}"
                        loading="lazy"
                        scrolling="no"
                        title="NOWPayments donation widget"
                      >
                        Can't load widget
                      </iframe>
                    </div>
                  ` : ''}
                </div>
              </div>
            </section>

            <section class="settings-card" id="overview-section">
              <div class="card-badge">Save & Install</div>
              <div class="settings-card-inner">
                <div class="settings-card-header">
                  <div>
                    <h3 class="card-title">Install URL</h3>
                    <p class="card-description">This is the manifest NebulaStreams will generate from the current provider, ranking, and filter settings.</p>
                  </div>
                </div>

                <div class="overview-grid">
                  <div>
                    <div class="manifest-box">
                      <div class="manifest-label">Manifest URL</div>
                      <p class="manifest-url" id="manifest-url">${escapeHtml(baseUrl)}/manifest.json</p>
                    </div>

                    <div class="actions">
                      <button type="button" class="primary-button" id="install-addon">Install Add-on</button>
                      <button type="button" class="secondary-button" id="copy-url">Copy URL</button>
                    </div>

                    <div class="flash" id="flash" aria-live="polite"></div>
                  </div>

                  <div class="meta-grid">
                    <div class="meta-card">
                      <p class="meta-label">Providers</p>
                      <p class="meta-value" id="overview-provider-count">${providers.length}</p>
                    </div>
                    <div class="meta-card">
                      <p class="meta-label">Quality Order</p>
                      <p class="meta-value">Custom</p>
                    </div>
                    <div class="meta-card">
                      <p class="meta-label">Preview</p>
                      <p class="meta-value">Built in</p>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section class="settings-card" id="presets-section">
              <div class="card-badge">Presets</div>
              <div class="settings-card-inner">
                <div class="settings-card-header">
                  <div>
                    <h3 class="card-title">One-Click Presets</h3>
                    <p class="card-description">Apply a ready-made profile for common playback goals, then adjust anything manually if you want.</p>
                  </div>
                </div>

                <div class="preset-grid">
                  <button type="button" class="preset-card" data-preset-id="web-fast">
                    <p class="preset-name">Web Fast</p>
                    <p class="preset-copy">Simple direct-friendly playback with lighter formats, H.264 preference, and aggressive dedupe.</p>
                  </button>
                  <button type="button" class="preset-card" data-preset-id="mobile-data">
                    <p class="preset-name">Mobile Data</p>
                    <p class="preset-copy">Smaller files, smaller resolutions, direct hosts, and tighter caps for low-bandwidth usage.</p>
                  </button>
                  <button type="button" class="preset-card" data-preset-id="4k-hdr">
                    <p class="preset-name">4K HDR</p>
                    <p class="preset-copy">Favor top-end quality and HDR releases without applying size or format restrictions.</p>
                  </button>
                  <button type="button" class="preset-card" data-preset-id="anime">
                    <p class="preset-name">Anime</p>
                    <p class="preset-copy">Focus the provider mix on anime sources and prefer Japanese audio when it is labeled.</p>
                  </button>
                  <button type="button" class="preset-card" data-preset-id="indian-content">
                    <p class="preset-name">Indian Content</p>
                    <p class="preset-copy">Bias toward Indian-focused providers with direct-host preference and practical dedupe.</p>
                  </button>
                  <button type="button" class="preset-card" data-preset-id="turkish-content">
                    <p class="preset-name">Turkish Content</p>
                    <p class="preset-copy">Use Turkish-focused providers first for Turkish movies and series.</p>
                  </button>
                  <button type="button" class="preset-card" data-preset-id="italian-content">
                    <p class="preset-name">Italian Content</p>
                    <p class="preset-copy">Use Italian-focused providers first for Italian movies, series, and anime.</p>
                  </button>
                  <button type="button" class="preset-card" data-preset-id="latino-content">
                    <p class="preset-name">Latino Content</p>
                    <p class="preset-copy">Use Latino-focused providers first for Spanish and Latino movies and series.</p>
                  </button>
                  <button type="button" class="preset-card" data-preset-id="arabic-content">
                    <p class="preset-name">Arabic Content</p>
                    <p class="preset-copy">Use Arabic-focused providers first for Arabic movies, series, and anime.</p>
                  </button>
                </div>

                <div class="preset-status" id="preset-status">Preset: Custom</div>
              </div>
            </section>

            <section class="settings-card" id="providers-section">
              <div class="card-badge">Providers</div>
              <div class="settings-card-inner">
                <div class="settings-card-header">
                  <div>
                    <h3 class="card-title">Provider Selection</h3>
                    <p class="card-description">Select any number of providers. Leaving everything unchecked falls back to the default all-provider install.</p>
                  </div>
                </div>

                <div class="field">
                  <label class="field-label" for="provider-search">Filter providers</label>
                  <input
                    id="provider-search"
                    class="field-input"
                    type="text"
                    placeholder="Search providers"
                    spellcheck="false"
                    autocomplete="off"
                  >
                  <div class="field-help">Examples: ${providerHints || '4khdhub, cinestream, streamflix'}</div>
                </div>

                <div class="toolbar">
                  <button type="button" class="mini-button" id="select-all-providers">Select all</button>
                  <button type="button" class="mini-button" id="clear-providers">Clear</button>
                </div>

                <div class="summary-strip" id="provider-summary">All providers selected</div>
                <div class="provider-grid" id="provider-grid"></div>
              </div>
            </section>

            <div class="two-column">
              <section class="settings-card" id="sorting-section">
                <div class="card-badge">Sorting</div>
                <div class="settings-card-inner">
                  <div class="settings-card-header">
                    <div>
                      <h3 class="card-title">Quality Priority</h3>
                      <p class="card-description">Move your preferred qualities to the top. NebulaStreams uses this order when ranking results.</p>
                    </div>
                  </div>

                  <div class="toolbar">
                    <button type="button" class="mini-button" id="reset-quality-order">Reset order</button>
                  </div>

                  <div class="quality-list" id="quality-list"></div>
                </div>
              </section>

              <section class="settings-card" id="filters-section">
                <div class="card-badge">Filters</div>
                <div class="settings-card-inner">
                  <div class="settings-card-header">
                    <div>
                      <h3 class="card-title">Playback Filters</h3>
                      <p class="card-description">Filter noisy results and add ranking hints without losing unknown or unlabeled streams unnecessarily.</p>
                    </div>
                  </div>

                  <div class="choice-grid">
                    <label class="choice-card">
                      <input type="checkbox" id="web-ready-only">
                      <div>
                        <p class="choice-title">Web-ready only (Not recommended)</p>
                        <p class="choice-copy">Keep only simple MP4-style links that need no proxy headers. This is strict and can reduce result count heavily.</p>
                      </div>
                    </label>

                    <label class="choice-card">
                      <input type="checkbox" id="hide-heavy-formats">
                      <div>
                        <p class="choice-title">Hide HEVC / HDR / 10-bit</p>
                        <p class="choice-copy">Useful for lighter playback devices and players that struggle with heavier formats.</p>
                      </div>
                    </label>
                  </div>

                  <div class="field">
                    <label class="field-label" for="preferred-audio-language">Preferred audio language</label>
                    <select id="preferred-audio-language" class="field-input">
                      <option value="">Any language</option>
                      <option value="Hindi">Hindi</option>
                      <option value="English">English</option>
                      <option value="Tamil">Tamil</option>
                      <option value="Telugu">Telugu</option>
                      <option value="Malayalam">Malayalam</option>
                      <option value="Kannada">Kannada</option>
                      <option value="Japanese">Japanese</option>
                      <option value="Korean">Korean</option>
                      <option value="Turkish">Turkish</option>
                      <option value="Italian">Italian</option>
                      <option value="Latino">Latino</option>
                      <option value="Spanish">Spanish</option>
                      <option value="Arabic">Arabic</option>
                    </select>
                    <div class="field-help">Keeps matching streams and unknown-language streams. Only clearly different labeled audio gets filtered out.</div>
                  </div>

                  <div class="field">
                    <label class="field-label" for="max-size-gb">Maximum file size</label>
                    <select id="max-size-gb" class="field-input">
                      <option value="0">No limit</option>
                      <option value="1.5">1.5 GB</option>
                      <option value="3">3 GB</option>
                      <option value="5">5 GB</option>
                      <option value="10">10 GB</option>
                      <option value="20">20 GB</option>
                    </select>
                    <div class="field-help">Hide oversized files when you want lighter playback or smaller downloads.</div>
                  </div>

                  <div class="field">
                    <label class="field-label" for="blocked-hosts">Blocked hosts</label>
                    <input
                      id="blocked-hosts"
                      class="field-input"
                      type="text"
                      placeholder="pixeldrain.dev, hub.toxix.buzz"
                      spellcheck="false"
                      autocomplete="off"
                    >
                    <div class="field-help">Comma-separated host fragments to hide. Useful for mirrors you do not want to see.</div>
                  </div>

                  <div class="field">
                    <label class="field-label" for="custom-proxy-url">Custom proxy URL</label>
                    <input
                      id="custom-proxy-url"
                      class="field-input"
                      type="text"
                      placeholder="Optional. Example: https://your-proxy.example/?url={url}&headers={headers}"
                      spellcheck="false"
                      autocomplete="off"
                    >
                    <div class="field-help">Optional. If set, HTTP streams are rewritten through your proxy. Supports <code>{url}</code> and <code>{headers}</code> placeholders. If you only provide a base URL, NebulaStreams appends <code>?url=...</code> and <code>&headers=...</code> automatically. Stored behind a private config id.</div>
                  </div>

                  <div class="field">
                    <label class="field-label" for="febbox-ui-cookie">Febbox UI cookie for ShowBox</label>
                    <input
                      id="febbox-ui-cookie"
                      class="field-input"
                      type="password"
                      placeholder="Optional personal token"
                      spellcheck="false"
                      autocomplete="off"
                    >
                    <div class="field-help">Optional. This enables ShowBox with your own Febbox UI cookie and is stored behind a private config id instead of being exposed in the manifest URL.</div>
                  </div>

                  <div class="field">
                    <label class="field-label" for="dedupe-mode">Deduplication mode</label>
                    <select id="dedupe-mode" class="field-input">
                      <option value="off">Off</option>
                      <option value="smart">Smart (Recommended)</option>
                      <option value="filename">By filename</option>
                      <option value="host-quality">By host + quality</option>
                    </select>
                    <div class="field-help">Collapse repeated streams after ranking so the best-scored duplicate stays visible.</div>
                  </div>
                </div>
              </section>
            </div>

            <section class="settings-card">
              <div class="card-badge">Ranking</div>
              <div class="settings-card-inner">
                <div class="settings-card-header">
                  <div>
                    <h3 class="card-title">Preference Boosts</h3>
                    <p class="card-description">These do not remove streams. They only push matching streams higher in the final list.</p>
                  </div>
                </div>

                <div class="three-column">
                  <label class="choice-card">
                    <input type="checkbox" id="prefer-hdr">
                    <div>
                      <p class="choice-title">Prefer HDR</p>
                      <p class="choice-copy">Push HDR and Dolby Vision releases higher without hiding SDR.</p>
                    </div>
                  </label>

                  <label class="choice-card">
                    <input type="checkbox" id="prefer-h264">
                    <div>
                      <p class="choice-title">Prefer H.264 / x264</p>
                      <p class="choice-copy">Useful when your player behaves better with H.264 than HEVC.</p>
                    </div>
                  </label>

                  <label class="choice-card">
                    <input type="checkbox" id="prefer-smaller-files">
                    <div>
                      <p class="choice-title">Prefer smaller files</p>
                      <p class="choice-copy">Push lighter files upward when speed matters more than maximum quality.</p>
                    </div>
                  </label>

                  <label class="choice-card">
                    <input type="checkbox" id="prefer-direct-hosts">
                    <div>
                      <p class="choice-title">Prefer direct hosts</p>
                      <p class="choice-copy">Push cleaner direct HTTP hosts above streams that need extra request headers.</p>
                    </div>
                  </label>
                </div>
              </div>
            </section>

            <section class="settings-card" id="preview-section">
              <div class="card-badge">Preview</div>
              <div class="settings-card-inner">
                <div class="settings-card-header">
                  <div>
                    <h3 class="card-title">Filter Preview</h3>
                    <p class="card-description">Test the current configuration against a title and see how many streams each rule removes.</p>
                  </div>
                </div>

                <div class="preview-grid">
                  <select id="preview-type" class="field-input">
                    <option value="movie">Movie</option>
                    <option value="series">Series</option>
                  </select>
                  <input
                    id="preview-id"
                    class="field-input"
                    type="text"
                    value="tt0133093"
                    placeholder="tt0133093 or tt0944947:1:1"
                    spellcheck="false"
                    autocomplete="off"
                  >
                  <button type="button" class="secondary-button" id="run-preview">Run Preview</button>
                </div>

                <div class="preview-result" id="preview-result">
                  <div class="preview-empty">Use an IMDb id to preview the current provider and filter settings.</div>
                </div>
              </div>
            </section>

            <section class="settings-card" id="notes-section">
              <div class="card-badge">Notes</div>
              <div class="settings-card-inner">
                <div class="settings-card-header">
                  <div>
                    <h3 class="card-title">Operational Notes</h3>
                    <p class="card-description">A few practical details about how the generated addon behaves.</p>
                  </div>
                </div>

                <div class="notes-list">
                  <p class="note-item"><strong>Quality order:</strong> this only affects ranking. It does not invent missing qualities from providers that have no match for a title.</p>
                  <p class="note-item"><strong>Web-ready mode:</strong> this deliberately filters hard. Use it only if you want the safest direct-play subset.</p>
                  <p class="note-item"><strong>Cold starts:</strong> the first request can take longer while the hosted backend wakes up and providers are queried in parallel.</p>
                  <p class="note-item"><strong>Media hosting:</strong> NebulaStreams does not store the media files themselves. It discovers external links and passes them through the configured playback flow.</p>
                </div>

                <div class="disclaimer">
                  <p class="disclaimer-text"><strong>Disclaimer:</strong> NebulaStreams is a stream discovery tool. It does not host, upload, or own the media itself. It should not be used to view copyrighted material without permission. The developer assumes no responsibility for how this tool is utilized.</p>
                </div>
              </div>
            </section>
          </div>
        </section>
      </div>
    </main>
    <script>
      const origin = ${JSON.stringify(baseUrl)};
      const providerData = ${JSON.stringify(providerIds)};
      const defaultQualityPriority = ['2160p', '1440p', '1080p', '720p', '480p', '360p', 'auto', 'unknown'];
      const selectedProviders = new Set();
      let qualityPriority = [...defaultQualityPriority];
      let activePresetId = null;

      providerData.forEach((providerId) => selectedProviders.add(providerId));

      const providerSearch = document.getElementById('provider-search');
      const providerGrid = document.getElementById('provider-grid');
      const providerSummary = document.getElementById('provider-summary');
      const manifestUrl = document.getElementById('manifest-url');
      const flash = document.getElementById('flash');
      const copyButton = document.getElementById('copy-url');
      const installButton = document.getElementById('install-addon');
      const qualityList = document.getElementById('quality-list');
      const selectAllProvidersButton = document.getElementById('select-all-providers');
      const clearProvidersButton = document.getElementById('clear-providers');
      const resetQualityOrderButton = document.getElementById('reset-quality-order');
      const webReadyOnly = document.getElementById('web-ready-only');
      const hideHeavyFormats = document.getElementById('hide-heavy-formats');
      const preferHdr = document.getElementById('prefer-hdr');
      const preferH264 = document.getElementById('prefer-h264');
      const preferSmallerFiles = document.getElementById('prefer-smaller-files');
      const preferDirectHosts = document.getElementById('prefer-direct-hosts');
      const preferredAudioLanguage = document.getElementById('preferred-audio-language');
      const maxSizeGb = document.getElementById('max-size-gb');
      const blockedHosts = document.getElementById('blocked-hosts');
      const customProxyUrl = document.getElementById('custom-proxy-url');
      const febboxUiCookie = document.getElementById('febbox-ui-cookie');
      const dedupeMode = document.getElementById('dedupe-mode');
      const overviewProviderCount = document.getElementById('overview-provider-count');
      const presetStatus = document.getElementById('preset-status');
      const presetButtons = Array.from(document.querySelectorAll('[data-preset-id]'));
      const donateToggle = document.getElementById('donate-toggle');
      const donationWidgetPanel = document.getElementById('donation-widget-panel');
      const previewType = document.getElementById('preview-type');
      const previewId = document.getElementById('preview-id');
      const runPreviewButton = document.getElementById('run-preview');
      const previewResult = document.getElementById('preview-result');
      const navItems = Array.from(document.querySelectorAll('[data-section-target]'));
      let latestManifestPath = '/manifest.json';
      let manifestResolveNonce = 0;

      const escapeHtmlClient = (value) => String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');

      const showFlash = (text, isError = false) => {
        flash.textContent = text;
        flash.style.color = isError ? '#ff98a8' : '#dce7ff';
        clearTimeout(flash._timer);
        flash._timer = setTimeout(() => { flash.textContent = ''; }, 2200);
      };

      const copyText = async (value, successMessage) => {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
          } else {
            const textarea = document.createElement('textarea');
            textarea.value = value;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
          }

          showFlash(successMessage);
        } catch (error) {
          console.error('Copy failed', error);
          showFlash('Copy failed. Please copy manually.', true);
        }
      };

      const isDefaultQualityOrder = () =>
        qualityPriority.length === defaultQualityPriority.length &&
        qualityPriority.every((quality, index) => quality === defaultQualityPriority[index]);

      const presetDefinitions = {
        'web-fast': {
          label: 'Web Fast',
          code: 'WF',
          providers: 'all',
          qualityPriority: ['1080p', '720p', '480p', '360p', '2160p', '1440p', 'auto', 'unknown'],
          webReadyOnly: true,
          hideHeavyFormats: true,
          preferHdr: false,
          preferH264: true,
          preferSmallerFiles: true,
          preferDirectHosts: true,
          customProxyUrl: '',
          preferredAudioLanguage: '',
          maxSizeGb: '5',
          blockedHosts: '',
          dedupeMode: 'host-quality'
        },
        'mobile-data': {
          label: 'Mobile Data',
          code: 'MD',
          providers: 'all',
          qualityPriority: ['720p', '480p', '360p', '1080p', '2160p', '1440p', 'auto', 'unknown'],
          webReadyOnly: false,
          hideHeavyFormats: true,
          preferHdr: false,
          preferH264: true,
          preferSmallerFiles: true,
          preferDirectHosts: true,
          customProxyUrl: '',
          preferredAudioLanguage: '',
          maxSizeGb: '3',
          blockedHosts: '',
          dedupeMode: 'host-quality'
        },
        '4k-hdr': {
          label: '4K HDR',
          code: '4K',
          providers: 'all',
          qualityPriority: ['2160p', '1440p', '1080p', '720p', '480p', '360p', 'auto', 'unknown'],
          webReadyOnly: false,
          hideHeavyFormats: false,
          preferHdr: true,
          preferH264: false,
          preferSmallerFiles: false,
          preferDirectHosts: false,
          customProxyUrl: '',
          preferredAudioLanguage: '',
          maxSizeGb: '0',
          blockedHosts: '',
          dedupeMode: 'smart'
        },
        anime: {
          label: 'Anime',
          code: 'AN',
          providers: ['anime-sama', 'animekai', 'animesalt', 'animeworld', '4khdhub_tv', '4khdhub', 'hdhub4u', 'kisskh', 'vidlink', 'videasy'],
          qualityPriority: ['1080p', '720p', '1440p', '2160p', '480p', '360p', 'auto', 'unknown'],
          webReadyOnly: false,
          hideHeavyFormats: false,
          preferHdr: false,
          preferH264: false,
          preferSmallerFiles: false,
          preferDirectHosts: true,
          customProxyUrl: '',
          preferredAudioLanguage: 'Japanese',
          maxSizeGb: '0',
          blockedHosts: '',
          dedupeMode: 'smart'
        },
        'indian-content': {
          label: 'Indian Content',
          code: 'IN',
          providers: ['4khdhub', '4khdhub_tv', 'hdhub4u', 'flixindia', 'hindmoviez', 'isaidub', 'tamilian', 'streamflix', 'streamflix_eng', 'allwish', 'moviesmod'],
          qualityPriority: ['1080p', '720p', '2160p', '480p', '360p', '1440p', 'auto', 'unknown'],
          webReadyOnly: false,
          hideHeavyFormats: false,
          preferHdr: false,
          preferH264: false,
          preferSmallerFiles: false,
          preferDirectHosts: true,
          customProxyUrl: '',
          preferredAudioLanguage: '',
          maxSizeGb: '0',
          blockedHosts: '',
          dedupeMode: 'host-quality'
        },
        'turkish-content': {
          label: 'Turkish Content',
          code: 'TR',
          providers: ['vidmody-tr', 'turkish-m3u', 'rectv-tr', 'diziyou', 'sinemacx', 'cinemacity', 'vidlink', 'videasy'],
          qualityPriority: ['1080p', '720p', '2160p', '480p', '360p', '1440p', 'auto', 'unknown'],
          webReadyOnly: false,
          hideHeavyFormats: false,
          preferHdr: false,
          preferH264: false,
          preferSmallerFiles: false,
          preferDirectHosts: true,
          customProxyUrl: '',
          preferredAudioLanguage: 'Turkish',
          maxSizeGb: '0',
          blockedHosts: '',
          dedupeMode: 'host-quality'
        },
        'italian-content': {
          label: 'Italian Content',
          code: 'IT',
          providers: ['it-streamingcommunity', 'it-guardahd', 'it-guardaserie', 'it-guardoserie', 'it-cc', 'it-animeunity', 'it-animeworld', 'it-animesaturn', 'vidlink', 'videasy'],
          qualityPriority: ['1080p', '720p', '2160p', '480p', '360p', '1440p', 'auto', 'unknown'],
          webReadyOnly: false,
          hideHeavyFormats: false,
          preferHdr: false,
          preferH264: false,
          preferSmallerFiles: false,
          preferDirectHosts: true,
          customProxyUrl: '',
          preferredAudioLanguage: 'Italian',
          maxSizeGb: '0',
          blockedHosts: '',
          dedupeMode: 'host-quality'
        },
        'latino-content': {
          label: 'Latino Content',
          code: 'LA',
          providers: ['latino-lamovie', 'latino-embed69', 'latino-cinecalidad', 'latino-xupalace', 'latino-seriesmetro', 'lamovie', 'purstream', 'vidlink', 'videasy'],
          qualityPriority: ['1080p', '720p', '2160p', '480p', '360p', '1440p', 'auto', 'unknown'],
          webReadyOnly: false,
          hideHeavyFormats: false,
          preferHdr: false,
          preferH264: false,
          preferSmallerFiles: false,
          preferDirectHosts: true,
          customProxyUrl: '',
          preferredAudioLanguage: 'Latino',
          maxSizeGb: '0',
          blockedHosts: '',
          dedupeMode: 'host-quality'
        },
        'arabic-content': {
          label: 'Arabic Content',
          code: 'AR',
          providers: ['arabic-faselhd', 'arabic-cineby', 'arabic-witanime', 'arabic-animecloud', 'arabic-kirmzi', 'vidlink', 'videasy'],
          qualityPriority: ['1080p', '720p', '2160p', '480p', '360p', '1440p', 'auto', 'unknown'],
          webReadyOnly: false,
          hideHeavyFormats: false,
          preferHdr: false,
          preferH264: false,
          preferSmallerFiles: false,
          preferDirectHosts: true,
          customProxyUrl: '',
          preferredAudioLanguage: 'Arabic',
          maxSizeGb: '0',
          blockedHosts: '',
          dedupeMode: 'host-quality'
        }
      };

      const getOrderedProviders = () =>
        providerData.filter((providerId) => selectedProviders.has(providerId));

      const setSelectedProviders = (providersOrAll) => {
        selectedProviders.clear();

        if (providersOrAll === 'all') {
          providerData.forEach((providerId) => selectedProviders.add(providerId));
          return;
        }

        const allowedProviders = Array.isArray(providersOrAll)
          ? providersOrAll.filter((providerId) => providerData.includes(providerId))
          : [];

        allowedProviders.forEach((providerId) => selectedProviders.add(providerId));
      };

      const updatePresetUi = () => {
        presetButtons.forEach((button) => {
          button.classList.toggle('is-active', button.dataset.presetId === activePresetId);
        });

        if (presetStatus) {
          const presetLabel = activePresetId && presetDefinitions[activePresetId]
            ? presetDefinitions[activePresetId].label
            : 'Custom';
          presetStatus.textContent = 'Preset: ' + presetLabel;
        }
      };

      const markPresetAsCustom = () => {
        if (!activePresetId) {
          return;
        }

        activePresetId = null;
        updatePresetUi();
      };

      const applyPreset = (presetId) => {
        const preset = presetDefinitions[presetId];

        if (!preset) {
          return;
        }

        setSelectedProviders(preset.providers);
        qualityPriority = [...preset.qualityPriority];
        webReadyOnly.checked = Boolean(preset.webReadyOnly);
        hideHeavyFormats.checked = Boolean(preset.hideHeavyFormats);
        preferHdr.checked = Boolean(preset.preferHdr);
        preferH264.checked = Boolean(preset.preferH264);
        preferSmallerFiles.checked = Boolean(preset.preferSmallerFiles);
        preferDirectHosts.checked = Boolean(preset.preferDirectHosts);
        customProxyUrl.value = preset.customProxyUrl || '';
        preferredAudioLanguage.value = preset.preferredAudioLanguage || '';
        maxSizeGb.value = preset.maxSizeGb || '0';
        blockedHosts.value = preset.blockedHosts || '';
        dedupeMode.value = preset.dedupeMode || 'off';
        activePresetId = presetId;
        renderProviderOptions();
        renderQualityList();
        updateManifest();
        updatePresetUi();
        showFlash(preset.label + ' preset applied.');
      };

      const getOptionTokens = () => {
        const tokens = [];
        const activePreset = activePresetId ? presetDefinitions[activePresetId] : null;

        if (activePreset?.code) {
          tokens.push('profile=' + activePreset.code.toLowerCase());
        }

        if (webReadyOnly.checked) {
          tokens.push('web-ready-only');
        }

        if (hideHeavyFormats.checked) {
          tokens.push('hide-heavy-formats');
        }

        if (preferHdr.checked) {
          tokens.push('prefer-hdr');
        }

        if (preferH264.checked) {
          tokens.push('prefer-h264');
        }

        if (preferSmallerFiles.checked) {
          tokens.push('prefer-smaller-files');
        }

        if (preferDirectHosts.checked) {
          tokens.push('prefer-direct-hosts');
        }

        if (preferredAudioLanguage.value) {
          tokens.push('preferred-audio=' + preferredAudioLanguage.value.toLowerCase());
        }

        if (dedupeMode.value && dedupeMode.value !== 'off') {
          tokens.push('dedupe=' + dedupeMode.value);
        }

        if (Number.parseFloat(maxSizeGb.value) > 0) {
          tokens.push('max-size-gb=' + Number.parseFloat(maxSizeGb.value));
        }

        const blockedHostTokens = blockedHosts.value
          .split(/[,\\n]/)
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
          .filter((value, index, values) => values.indexOf(value) === index);

        if (blockedHostTokens.length > 0) {
          tokens.push('block-hosts=' + blockedHostTokens.join('|'));
        }

        return tokens;
      };

      const buildManifestPath = () => {
        const orderedProviders = getOrderedProviders();
        const providerSegment = orderedProviders.length > 0 && orderedProviders.length < providerData.length
          ? encodeURIComponent(orderedProviders.join(','))
          : 'all';
        const qualitySegment = isDefaultQualityOrder()
          ? 'default'
          : encodeURIComponent(qualityPriority.join(','));
        const optionTokens = getOptionTokens();

        if (providerSegment === 'all' && qualitySegment === 'default' && optionTokens.length === 0) {
          return '/manifest.json';
        }

        if (optionTokens.length === 0 && qualitySegment === 'default') {
          return '/configured/' + providerSegment + '/manifest.json';
        }

        if (optionTokens.length === 0) {
          return '/configured/' + providerSegment + '/' + qualitySegment + '/manifest.json';
        }

        return '/configured/' + providerSegment + '/' + qualitySegment + '/' + encodeURIComponent(optionTokens.join(',')) + '/manifest.json';
      };

      const buildPrivateConfigPayload = () => {
        const orderedProviders = getOrderedProviders();

        return {
        providers: orderedProviders.length === 0 || orderedProviders.length === providerData.length
          ? []
          : orderedProviders,
        qualityPriority: [...qualityPriority],
        streamOptions: {
          webReadyOnly: webReadyOnly.checked,
          hideHeavyFormats: hideHeavyFormats.checked,
          maxSizeGb: Number.parseFloat(maxSizeGb.value) > 0 ? Number.parseFloat(maxSizeGb.value) : 0,
          blockHosts: blockedHosts.value
            .split(/[,\\n]/)
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean)
            .filter((value, index, values) => values.indexOf(value) === index),
          preferredAudioLanguage: preferredAudioLanguage.value || null,
          dedupeMode: dedupeMode.value || 'off',
          preferHdr: preferHdr.checked,
          preferH264: preferH264.checked,
          preferSmallerFiles: preferSmallerFiles.checked,
          preferDirectHosts: preferDirectHosts.checked,
          customProxyUrl: customProxyUrl.value.trim() || null
        },
        privateProviderSettings: {
          febboxUiCookie: febboxUiCookie.value.trim()
        },
        profileCode: activePresetId && presetDefinitions[activePresetId]?.code
          ? presetDefinitions[activePresetId].code.toLowerCase()
          : null
        };
      };

      const resolveManifestPath = async () => {
        const privateCookie = febboxUiCookie.value.trim();
        const configuredProxyUrl = customProxyUrl.value.trim();

        if (!privateCookie && !configuredProxyUrl) {
          return buildManifestPath();
        }

        const response = await fetch(origin + '/configure/private-config', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(buildPrivateConfigPayload())
        });

        if (!response.ok) {
          throw new Error('Private config request failed');
        }

        const payload = await response.json();

        if (!payload || typeof payload.manifestPath !== 'string' || !payload.manifestPath) {
          throw new Error('Private config response was invalid');
        }

        return payload.manifestPath;
      };

      const updateProviderSummary = () => {
        const orderedProviders = getOrderedProviders();

        if (overviewProviderCount) {
          overviewProviderCount.textContent = orderedProviders.length === 0
            ? String(providerData.length)
            : String(orderedProviders.length);
        }

        if (orderedProviders.length === providerData.length) {
          providerSummary.textContent = 'All providers selected';
          return;
        }

        if (orderedProviders.length === 0) {
          providerSummary.textContent = 'No providers checked. Falling back to all providers.';
          return;
        }

        providerSummary.textContent = orderedProviders.length + ' provider' + (orderedProviders.length === 1 ? '' : 's') + ' selected: ' + orderedProviders.join(', ');
      };

      const renderProviderOptions = () => {
        const filter = providerSearch.value.trim().toLowerCase();
        const visibleProviders = providerData.filter((providerId) => providerId.includes(filter));

        if (visibleProviders.length === 0) {
          providerGrid.innerHTML = '<div class="empty-state">No providers match that filter.</div>';
          return;
        }

        providerGrid.innerHTML = visibleProviders.map((providerId) =>
          '<label class="provider-option">' +
            '<input type="checkbox" data-provider-id="' + escapeHtmlClient(providerId) + '" ' + (selectedProviders.has(providerId) ? 'checked' : '') + '>' +
            '<span class="provider-name">' + escapeHtmlClient(providerId) + '</span>' +
          '</label>'
        ).join('');
      };

      const renderQualityList = () => {
        qualityList.innerHTML = qualityPriority.map((quality, index) =>
          '<div class="quality-row">' +
            '<div class="quality-rank">' + (index + 1) + '</div>' +
            '<div>' + escapeHtmlClient(quality.toUpperCase()) + '</div>' +
            '<div class="quality-actions">' +
              '<button type="button" class="arrow-button" data-quality-index="' + index + '" data-quality-move="-1" ' + (index === 0 ? 'disabled' : '') + '>↑</button>' +
              '<button type="button" class="arrow-button" data-quality-index="' + index + '" data-quality-move="1" ' + (index === qualityPriority.length - 1 ? 'disabled' : '') + '>↓</button>' +
            '</div>' +
          '</div>'
        ).join('');
      };

      const updateManifest = async () => {
        updateProviderSummary();
        const requestNonce = ++manifestResolveNonce;
        const fallbackPath = buildManifestPath();

        latestManifestPath = fallbackPath;
        manifestUrl.textContent = febboxUiCookie.value.trim()
          ? 'Preparing private manifest...'
          : origin + fallbackPath;

        try {
          const resolvedPath = await resolveManifestPath();

          if (requestNonce !== manifestResolveNonce) {
            return;
          }

          latestManifestPath = resolvedPath;
          manifestUrl.textContent = origin + resolvedPath;
        } catch (error) {
          console.error('Manifest resolution failed', error);

          if (requestNonce !== manifestResolveNonce) {
            return;
          }

          latestManifestPath = fallbackPath;
          manifestUrl.textContent = origin + fallbackPath;
          showFlash('Private manifest setup failed.', true);
        }
      };

      const buildPreviewPath = async () => {
        const rawId = previewId.value.trim();

        if (!rawId) {
          return null;
        }

        const manifestPath = await resolveManifestPath();
        const prefix = manifestPath.replace(/\\/manifest\\.json$/u, '');
        return (prefix || '') + '/preview/' + encodeURIComponent(previewType.value) + '/' + encodeURIComponent(rawId) + '.json';
      };

      const renderPreviewResult = (payload) => {
        if (!payload || payload.resolved === false) {
          previewResult.innerHTML = '<div class="preview-empty">Preview failed. Check the IMDb id and try again.</div>';
          return;
        }

        const diagnostics = payload.diagnostics || {};
        const reasons = diagnostics.reasons || {};
        const examples = diagnostics.examples || {};
        const finalTotal = Math.max(0, Number(diagnostics.keptTotal || 0) - Number(diagnostics.dedupedTotal || 0));
        const reasonLabels = {
          nonHttp: 'Non-HTTP streams',
          notWebReady: 'Not web-ready',
          heavyFormat: 'Heavy formats',
          tooLarge: 'Too large',
          blockedHost: 'Blocked hosts',
          languageMismatch: 'Different audio language',
          duplicate: 'Collapsed duplicates'
        };
        const reasonRows = Object.entries(reasonLabels)
          .filter(([key]) => Number(reasons[key] || 0) > 0)
          .sort((left, right) => Number(reasons[right[0]] || 0) - Number(reasons[left[0]] || 0))
          .map(([key, label]) => {
            const exampleRows = Array.isArray(examples[key]) && examples[key].length > 0
              ? '<div class="diagnostic-examples">' + examples[key].map((stream) =>
                  '<div class="diagnostic-example">' +
                    '<strong>' + escapeHtmlClient(stream.name || 'Untitled stream') + '</strong>' +
                    '<div class="diagnostic-meta">' + escapeHtmlClient([
                      stream.quality || 'Unknown',
                      stream.host || 'Unknown host',
                      stream.size || 'Unknown size'
                    ].join(' • ')) + '</div>' +
                  '</div>'
                ).join('') + '</div>'
              : '';

            return '<div class="diagnostic-group">' +
              '<div class="reason-row"><span>' + label + '</span><strong>' + Number(reasons[key] || 0) + '</strong></div>' +
              exampleRows +
            '</div>';
          })
          .join('');
        const sampleRows = Array.isArray(payload.sample) && payload.sample.length > 0
          ? payload.sample.map((stream) =>
              '<div class="sample-row">' +
                '<strong>' + escapeHtmlClient(stream.name || 'Untitled stream') + '</strong>' +
                '<div class="sample-meta">' +
                  escapeHtmlClient([
                    stream.quality || 'Unknown',
                    stream.host || 'Unknown host',
                    stream.size || 'Unknown size'
                  ].join(' • ')) +
                '</div>' +
              '</div>'
            ).join('')
          : '<div class="preview-empty">No streams survived the current filters for this title.</div>';

        previewResult.innerHTML =
          '<div class="stat-grid">' +
            '<div class="stat-card"><p class="stat-label">Before</p><p class="stat-value">' + Number(diagnostics.inputTotal || 0) + '</p></div>' +
            '<div class="stat-card"><p class="stat-label">Filtered</p><p class="stat-value">' + Number(diagnostics.filteredTotal || 0) + '</p></div>' +
            '<div class="stat-card"><p class="stat-label">Deduped</p><p class="stat-value">' + Number(diagnostics.dedupedTotal || 0) + '</p></div>' +
            '<div class="stat-card"><p class="stat-label">Final</p><p class="stat-value">' + finalTotal + '</p></div>' +
          '</div>' +
          (reasonRows ? '<div class="reason-list">' + reasonRows + '</div>' : '<div class="preview-empty" style="margin-top:14px;">No filter or dedupe rules changed this title.</div>') +
          '<div class="sample-list">' + sampleRows + '</div>';
      };

      const runPreview = async () => {
        const previewPath = await buildPreviewPath();

        if (!previewPath) {
          showFlash('Enter an IMDb id first.', true);
          return;
        }

        previewResult.innerHTML = '<div class="preview-empty">Running preview...</div>';

        try {
          const response = await fetch(origin + previewPath);

          if (!response.ok) {
            throw new Error('Preview request failed');
          }

          const payload = await response.json();
          renderPreviewResult(payload);
        } catch (error) {
          console.error('Preview failed', error);
          previewResult.innerHTML = '<div class="preview-empty">Preview request failed. Try again in a moment.</div>';
        }
      };

      providerSearch.addEventListener('input', () => {
        renderProviderOptions();
      });

      providerGrid.addEventListener('change', (event) => {
        const providerId = event.target?.dataset?.providerId;

        if (!providerId) {
          return;
        }

        if (event.target.checked) {
          selectedProviders.add(providerId);
        } else {
          selectedProviders.delete(providerId);
        }

        markPresetAsCustom();
        updateManifest();
      });

      selectAllProvidersButton.addEventListener('click', () => {
        providerData.forEach((providerId) => selectedProviders.add(providerId));
        markPresetAsCustom();
        renderProviderOptions();
        updateManifest();
      });

      clearProvidersButton.addEventListener('click', () => {
        selectedProviders.clear();
        markPresetAsCustom();
        renderProviderOptions();
        updateManifest();
      });

      resetQualityOrderButton.addEventListener('click', () => {
        qualityPriority = [...defaultQualityPriority];
        markPresetAsCustom();
        renderQualityList();
        updateManifest();
      });

      qualityList.addEventListener('click', (event) => {
        const index = Number.parseInt(event.target?.dataset?.qualityIndex || '', 10);
        const move = Number.parseInt(event.target?.dataset?.qualityMove || '', 10);

        if (!Number.isInteger(index) || !Number.isInteger(move)) {
          return;
        }

        const nextIndex = index + move;

        if (nextIndex < 0 || nextIndex >= qualityPriority.length) {
          return;
        }

        const reordered = [...qualityPriority];
        const [movedQuality] = reordered.splice(index, 1);
        reordered.splice(nextIndex, 0, movedQuality);
        qualityPriority = reordered;
        markPresetAsCustom();
        renderQualityList();
        updateManifest();
      });

      const optionInputs = [
        webReadyOnly,
        hideHeavyFormats,
        preferHdr,
        preferH264,
        preferSmallerFiles,
        preferDirectHosts,
        preferredAudioLanguage,
        maxSizeGb,
        dedupeMode
      ];

      optionInputs.forEach((input) => {
        input.addEventListener('change', () => {
          markPresetAsCustom();
          updateManifest();
        });
      });

      blockedHosts.addEventListener('input', () => {
        markPresetAsCustom();
        updateManifest();
      });

      customProxyUrl.addEventListener('input', () => {
        markPresetAsCustom();
        updateManifest();
      });

      febboxUiCookie.addEventListener('input', () => {
        markPresetAsCustom();
        updateManifest();
      });

      presetButtons.forEach((button) => {
        button.addEventListener('click', () => {
          applyPreset(button.dataset.presetId);
        });
      });

      runPreviewButton.addEventListener('click', runPreview);
      previewId.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          runPreview();
        }
      });

      installButton.addEventListener('click', async () => {
        try {
          const manifestPath = await resolveManifestPath();
          window.location.href = 'stremio://addon-install?addon=' + encodeURIComponent(origin + manifestPath);
        } catch (error) {
          console.error('Install manifest resolution failed', error);
          showFlash('Install URL could not be prepared.', true);
        }
      });

      copyButton.addEventListener('click', async () => {
        try {
          const manifestPath = await resolveManifestPath();
          copyText(origin + manifestPath, 'Manifest URL copied.');
        } catch (error) {
          console.error('Copy manifest resolution failed', error);
          showFlash('Manifest URL could not be prepared.', true);
        }
      });

      if (donateToggle && donationWidgetPanel) {
        donateToggle.addEventListener('click', () => {
          donationWidgetPanel.classList.toggle('open');
        });
      }

      navItems.forEach((item) => {
        item.addEventListener('click', () => {
          const target = document.getElementById(item.dataset.sectionTarget || '');

          if (!target) {
            return;
          }

          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });

      const sectionObserver = new IntersectionObserver((entries) => {
        const visibleEntry = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];

        if (!visibleEntry) {
          return;
        }

        const activeId = visibleEntry.target.id;
        navItems.forEach((item) => {
          item.classList.toggle('is-active', item.dataset.sectionTarget === activeId);
        });
      }, {
        rootMargin: '-18% 0px -55% 0px',
        threshold: [0.1, 0.35, 0.6]
      });

      ['support-section', 'overview-section', 'presets-section', 'providers-section', 'sorting-section', 'filters-section', 'preview-section', 'notes-section']
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .forEach((section) => sectionObserver.observe(section));

      renderProviderOptions();
      renderQualityList();
      updateManifest();
      updatePresetUi();
    </script>
  </body>
</html>`;
};

const renderAdminPage = ({ stats }) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>NebulaStreams Admin</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0a0f19;
        --panel: #141b2a;
        --panel-2: #1a2335;
        --text: #eef3ff;
        --muted: #98a7c7;
        --accent: #66b6ff;
        --border: rgba(255,255,255,0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background:
          radial-gradient(circle at top left, rgba(102,182,255,0.18), transparent 24%),
          radial-gradient(circle at top right, rgba(123,112,255,0.18), transparent 20%),
          var(--bg);
        color: var(--text);
        font: 15px/1.5 system-ui, sans-serif;
      }
      main {
        max-width: 1180px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 34px;
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
      }
      p {
        margin: 0;
        color: var(--muted);
      }
      .logout-form {
        margin: 0;
      }
      .logout-form button {
        appearance: none;
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 10px 14px;
        background: var(--panel);
        color: var(--text);
        cursor: pointer;
        font: inherit;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
        gap: 16px;
        margin-top: 24px;
      }
      .card {
        padding: 18px;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015));
      }
      .label {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .value {
        margin-top: 8px;
        font-size: 28px;
        font-weight: 700;
      }
      .section {
        margin-top: 28px;
        padding: 22px;
        border-radius: 22px;
        border: 1px solid var(--border);
        background: var(--panel);
      }
      .meta-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 14px;
        margin-top: 16px;
      }
      .table-wrap {
        width: 100%;
        overflow-x: auto;
        margin-top: 16px;
        border: 1px solid var(--border);
        border-radius: 16px;
        background: rgba(0,0,0,0.18);
      }
      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 940px;
      }
      th, td {
        padding: 11px 12px;
        border-bottom: 1px solid var(--border);
        text-align: left;
        vertical-align: top;
      }
      th {
        color: var(--muted);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        background: rgba(255,255,255,0.03);
      }
      tr:last-child td {
        border-bottom: 0;
      }
      .provider-id {
        display: block;
        margin-top: 2px;
        color: var(--muted);
        font-size: 12px;
      }
      .status-pill {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 4px 9px;
        border: 1px solid var(--border);
        color: var(--text);
        background: rgba(255,255,255,0.06);
        font-size: 12px;
        font-weight: 700;
        text-transform: capitalize;
      }
      .status-ok,
      .status-cache-hit {
        border-color: rgba(76, 217, 160, 0.35);
        background: rgba(76, 217, 160, 0.12);
        color: #aef4d7;
      }
      .status-running {
        border-color: rgba(102, 182, 255, 0.42);
        background: rgba(102, 182, 255, 0.14);
        color: #bfe3ff;
      }
      .status-intermittent {
        border-color: rgba(255, 201, 92, 0.38);
        background: rgba(255, 201, 92, 0.12);
        color: #ffe4a3;
      }
      .status-empty,
      .status-idle {
        border-color: rgba(255,255,255,0.10);
        background: rgba(255,255,255,0.04);
        color: var(--muted);
      }
      .status-failing,
      .status-cooldown {
        border-color: rgba(255, 123, 138, 0.45);
        background: rgba(255, 123, 138, 0.14);
        color: #ffc3cb;
      }
      .provider-error {
        display: inline-block;
        max-width: 320px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: #ffc3cb;
      }
      .muted-inline {
        color: var(--muted);
      }
      code {
        display: inline-block;
        margin-top: 6px;
        padding: 8px 10px;
        border-radius: 12px;
        background: var(--panel-2);
        color: #dff1ff;
        word-break: break-word;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="header">
        <div>
          <h1>NebulaStreams Admin</h1>
          <p>Private runtime dashboard for service health, usage, cache, provider state, and source registry.</p>
        </div>
        <form class="logout-form" method="post" action="/admin/logout">
          <button type="submit">Sign out</button>
        </form>
      </div>

      <section class="grid">
        <div class="card"><div class="label">Uptime</div><div class="value">${stats.runtime.uptimeSeconds}s</div></div>
        <div class="card"><div class="label">System CPU</div><div class="value">${formatPercent(stats.system.cpuUsagePercent)}</div></div>
        <div class="card"><div class="label">System Memory</div><div class="value">${formatPercent(stats.system.memoryUsagePercent)}</div></div>
        <div class="card"><div class="label">Process RSS</div><div class="value">${formatBytes(stats.system.processRssBytes)}</div></div>
        <div class="card"><div class="label">Active Streams</div><div class="value">${stats.runtime.activeStreams}/${stats.runtime.maxActiveStreams}</div></div>
        <div class="card"><div class="label">Stream Searches</div><div class="value">${stats.runtime.streamSearchesInFlight}/${stats.runtime.maxStreamSearchesInFlight}</div></div>
        <div class="card"><div class="label">Active Torrents</div><div class="value">${stats.runtime.activeTorrentEngines}</div></div>
        <div class="card"><div class="label">Human Users</div><div class="value">${stats.users.totalUsers}</div></div>
        <div class="card"><div class="label">Users 24h</div><div class="value">${stats.users.activeUsers24h}</div></div>
        <div class="card"><div class="label">Configure Users</div><div class="value">${stats.users.configureUsers}</div></div>
        <div class="card"><div class="label">Stream Users</div><div class="value">${stats.users.streamUsers}</div></div>
        <div class="card"><div class="label">Human Requests</div><div class="value">${stats.users.totalTrackedRequests}</div></div>
      </section>

      <section class="section">
        <h2>System</h2>
        <div class="meta-grid">
          <div><div class="label">CPU Usage</div><code>${escapeHtml(formatPercent(stats.system.cpuUsagePercent))}</code></div>
          <div><div class="label">CPU Cores</div><code>${escapeHtml(String(stats.system.cpuCount))}</code></div>
          <div><div class="label">Load Average</div><code>${escapeHtml(stats.system.loadAverage.map((value) => value.toFixed(2)).join(' / '))}</code></div>
          <div><div class="label">Memory Used</div><code>${escapeHtml(formatBytes(stats.system.usedMemoryBytes))}</code></div>
          <div><div class="label">Memory Available</div><code>${escapeHtml(formatBytes(stats.system.availableMemoryBytes))}</code></div>
          <div><div class="label">Memory Free</div><code>${escapeHtml(formatBytes(stats.system.freeMemoryBytes))}</code></div>
          <div><div class="label">Memory Total</div><code>${escapeHtml(formatBytes(stats.system.totalMemoryBytes))}</code></div>
          <div><div class="label">Process RSS</div><code>${escapeHtml(formatBytes(stats.system.processRssBytes))}</code></div>
          <div><div class="label">Process Heap Used</div><code>${escapeHtml(formatBytes(stats.system.processHeapUsedBytes))}</code></div>
        </div>
      </section>

      <section class="section">
        <h2>Traffic</h2>
        <div class="meta-grid">
          <div><div class="label">Raw Unique Clients</div><code>${escapeHtml(String(stats.users.rawUniqueClients))}</code></div>
          <div><div class="label">Raw Requests</div><code>${escapeHtml(String(stats.users.rawTrackedRequests))}</code></div>
          <div><div class="label">Bot Clients</div><code>${escapeHtml(String(stats.users.botClients))}</code></div>
          <div><div class="label">Bot Requests</div><code>${escapeHtml(String(stats.users.botRequests))}</code></div>
          <div><div class="label">Mixed Clients</div><code>${escapeHtml(String(stats.users.mixedClients))}</code></div>
          <div><div class="label">Configure Users</div><code>${escapeHtml(String(stats.users.configureUsers))}</code></div>
          <div><div class="label">Configure Requests</div><code>${escapeHtml(String(stats.users.configureRequests))}</code></div>
          <div><div class="label">Manifest Requests</div><code>${escapeHtml(String(stats.users.manifestRequests))}</code></div>
          <div><div class="label">Stream Requests</div><code>${escapeHtml(String(stats.users.streamRequests))}</code></div>
        </div>
      </section>

      <section class="section">
        <h2>Stream Search</h2>
        <div class="meta-grid">
          <div><div class="label">Searches In Flight</div><code>${escapeHtml(`${stats.runtime.streamSearchesInFlight}/${stats.runtime.maxStreamSearchesInFlight}`)}</code></div>
          <div><div class="label">Background Refresh</div><code>${escapeHtml(`${stats.runtime.stremioBackgroundRefreshActive}/${stats.runtime.stremioBackgroundRefreshQueued}`)}</code></div>
          <div><div class="label">Stremio Result Cache</div><code>${escapeHtml(String(stats.runtime.stremioResultCacheEntries))}</code></div>
          <div><div class="label">Redis Result Cache</div><code>${escapeHtml(stats.runtime.redisStreamResultCache?.enabled ? (stats.runtime.redisStreamResultCache.available ? 'connected' : 'unavailable') : 'disabled')}</code></div>
          <div><div class="label">HubCloud Cache</div><code>${escapeHtml(String(stats.runtime.hubCloudCacheEntries))}</code></div>
          <div><div class="label">Popular Searches</div><code>${escapeHtml(String(stats.users.popularStreamSearches))}</code></div>
          <div><div class="label">Popular Prewarm</div><code>${escapeHtml(stats.runtime.popularStreamPrewarm?.enabled ? (stats.runtime.popularStreamPrewarm.running ? 'running' : 'enabled') : 'disabled')}</code></div>
          <div><div class="label">Last Prewarm</div><code>${escapeHtml(stats.runtime.popularStreamPrewarm?.lastFinishedAt || 'never')}</code></div>
          <div><div class="label">Last Prewarm Refreshed</div><code>${escapeHtml(String(stats.runtime.popularStreamPrewarm?.lastResultCount ?? 0))}</code></div>
        </div>
      </section>

      <section class="section">
        <h2>Cache</h2>
        <div class="meta-grid">
          <div><div class="label">Cache Dir</div><code>${escapeHtml(stats.cache.cacheDir)}</code></div>
          <div><div class="label">Current Size</div><code>${escapeHtml(String(stats.cache.currentCacheSizeBytes))}</code></div>
          <div><div class="label">Max Size</div><code>${escapeHtml(String(stats.cache.maxCacheSizeBytes))}</code></div>
          <div><div class="label">HTTP Entries</div><code>${escapeHtml(String(stats.cache.httpEntries))}</code></div>
          <div><div class="label">Provider Entries</div><code>${escapeHtml(String(stats.cache.providerEntries))}</code></div>
          <div><div class="label">Torrent Entries</div><code>${escapeHtml(String(stats.cache.torrentEntries))}</code></div>
        </div>
      </section>

      <section class="section">
        <h2>Providers</h2>
        <div class="meta-grid">
          <div><div class="label">Discovered</div><code>${escapeHtml(String(stats.providers.discoveredProviders))}</code></div>
          <div><div class="label">Memory Cache Entries</div><code>${escapeHtml(String(stats.providers.inMemoryCacheEntries))}</code></div>
          <div><div class="label">In-Flight Requests</div><code>${escapeHtml(String(stats.providers.inFlightRequests))}</code></div>
          <div><div class="label">Active Executions</div><code>${escapeHtml(String(stats.providers.activeProviderExecutions))}</code></div>
          <div><div class="label">Providers Cooling Down</div><code>${escapeHtml(String(stats.providers.coolingDownProviders))}</code></div>
          <div><div class="label">Hosts Cooling Down</div><code>${escapeHtml(String(stats.providers.coolingDownHosts))}</code></div>
          <div><div class="label">Provider Cache Dir</div><code>${escapeHtml(stats.providers.providerCacheDir)}</code></div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Status</th>
                <th>Active</th>
                <th>Last Streams</th>
                <th>Last Time</th>
                <th>Failures</th>
                <th>Cooldown</th>
                <th>Last Seen</th>
                <th>Last Error</th>
              </tr>
            </thead>
            <tbody>
              ${renderProviderStatusRows(stats.providers.providers)}
            </tbody>
          </table>
        </div>
      </section>

      <section class="section">
        <h2>Registry</h2>
        <div class="meta-grid">
          <div><div class="label">Source Entries</div><code>${escapeHtml(String(stats.sourceRegistry.entries))}</code></div>
          <div><div class="label">Fallback Entries</div><code>${escapeHtml(String(stats.sourceRegistry.activeFallbackEntries))}</code></div>
          <div><div class="label">TTL (ms)</div><code>${escapeHtml(String(stats.sourceRegistry.ttlMs))}</code></div>
        </div>
      </section>
    </main>
  </body>
</html>`;

const renderAdminLoginPage = ({ errorMessage = '' } = {}) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>NebulaStreams Admin Login</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0a0f19;
        --panel: #141b2a;
        --text: #eef3ff;
        --muted: #98a7c7;
        --accent: #66b6ff;
        --danger: #ff7b8a;
        --border: rgba(255,255,255,0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top left, rgba(102,182,255,0.18), transparent 24%),
          radial-gradient(circle at top right, rgba(123,112,255,0.18), transparent 20%),
          var(--bg);
        color: var(--text);
        font: 15px/1.5 system-ui, sans-serif;
      }
      .panel {
        width: min(420px, calc(100vw - 32px));
        padding: 28px;
        border-radius: 22px;
        border: 1px solid var(--border);
        background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015));
        box-shadow: 0 20px 60px rgba(0,0,0,0.35);
      }
      h1 {
        margin: 0 0 8px;
        font-size: 30px;
      }
      p {
        margin: 0;
        color: var(--muted);
      }
      form {
        display: grid;
        gap: 14px;
        margin-top: 22px;
      }
      label {
        display: grid;
        gap: 8px;
      }
      input {
        width: 100%;
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: var(--panel);
        color: var(--text);
        font: inherit;
      }
      button {
        appearance: none;
        border: 0;
        border-radius: 999px;
        padding: 12px 16px;
        background: linear-gradient(135deg, var(--accent), #7b70ff);
        color: #081018;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }
      .error {
        margin-top: 14px;
        color: var(--danger);
      }
    </style>
  </head>
  <body>
    <main class="panel">
      <h1>NebulaStreams Admin</h1>
      <p>Sign in to view private runtime stats and usage data.</p>
      ${errorMessage ? `<div class="error">${escapeHtml(errorMessage)}</div>` : ''}
      <form method="post" action="/admin/login">
        <label>
          <span>Username</span>
          <input name="username" type="text" autocomplete="username" required>
        </label>
        <label>
          <span>Password</span>
          <input name="password" type="password" autocomplete="current-password" required>
        </label>
        <button type="submit">Sign in</button>
      </form>
    </main>
  </body>
</html>`;

const renderDonatePage = ({ baseUrl }) => {
  const donationPrimaryUrl = String(config.DONATION_PRIMARY_URL || '').trim();
  const primarySection = donationPrimaryUrl
    ? `
      <div class="support-card">
        <div class="support-label">Ko-fi</div>
        <div class="support-value">Support the project with Ko-fi.</div>
        <a class="copy-button" href="${escapeHtml(donationPrimaryUrl)}" target="_blank" rel="noopener">Open Ko-fi</a>
      </div>
    `
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>NebulaStreams Donate</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0f0f0f;
        --card-bg: rgba(255, 255, 255, 0.07);
        --card-border: rgba(255, 255, 255, 0.12);
        --text: #f5f7ff;
        --muted: #a7afc6;
        --accent-start: #8b5cf6;
        --accent-end: #3b82f6;
        --surface: rgba(255, 255, 255, 0.05);
        --shadow: 0 28px 80px rgba(0, 0, 0, 0.42);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background:
          radial-gradient(circle at top left, rgba(139, 92, 246, 0.22), transparent 26%),
          radial-gradient(circle at top right, rgba(59, 130, 246, 0.18), transparent 28%),
          radial-gradient(circle at bottom center, rgba(99, 102, 241, 0.14), transparent 32%),
          var(--bg);
        color: var(--text);
        font: 15px/1.5 system-ui, sans-serif;
      }
      main {
        width: min(100%, 680px);
      }
      .shell {
        position: relative;
        overflow: hidden;
        padding: 34px 28px 26px;
        border-radius: 30px;
        border: 1px solid var(--card-border);
        background: linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.04));
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
      }
      .shell::before {
        content: '';
        position: absolute;
        inset: -2px;
        background: linear-gradient(135deg, rgba(139, 92, 246, 0.18), rgba(59, 130, 246, 0.14), transparent 70%);
        pointer-events: none;
        z-index: 0;
      }
      .content {
        position: relative;
        z-index: 1;
      }
      .logo-wrap {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 82px;
        height: 82px;
        border-radius: 24px;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 12px 38px rgba(99, 102, 241, 0.18);
      }
      .logo-wrap img {
        width: 62px;
        height: 62px;
        object-fit: cover;
        border-radius: 18px;
      }
      h1 {
        margin: 18px 0 10px;
        font-size: clamp(34px, 8vw, 52px);
        line-height: 1.04;
      }
      .subtitle {
        margin: 0;
        color: var(--muted);
        font-size: 17px;
        max-width: 560px;
      }
      .blurb {
        margin-top: 22px;
        padding: 18px;
        border-radius: 20px;
        background: rgba(12, 14, 22, 0.45);
        border: 1px solid rgba(255,255,255,0.08);
      }
      .blurb p {
        margin: 0;
        color: #dbe4ff;
      }
      .button, .copy-button {
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 54px;
        border-radius: 999px;
        padding: 14px 18px;
        font: inherit;
        text-decoration: none;
        cursor: pointer;
        transition: transform 140ms ease, box-shadow 160ms ease, opacity 140ms ease;
      }
      .button:hover, .copy-button:hover {
        transform: translateY(-1px);
      }
      .button:active, .copy-button:active {
        transform: translateY(0);
      }
      .button-primary {
        border: 0;
        background: linear-gradient(135deg, var(--accent-start), var(--accent-end));
        color: #f8fbff;
        box-shadow: 0 12px 30px rgba(99, 102, 241, 0.28);
      }
      .button-secondary, .copy-button {
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.06);
        color: var(--text);
      }
      .support-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 14px;
        margin-top: 22px;
      }
      .support-card {
        padding: 18px;
        border-radius: 22px;
        background: rgba(255,255,255,0.045);
        border: 1px solid rgba(255,255,255,0.08);
      }
      .support-label {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .support-value {
        margin-top: 8px;
        font-size: 18px;
        color: #eef2ff;
        word-break: break-word;
      }
      .copy-button {
        margin-top: 14px;
        width: 100%;
        text-decoration: none;
      }
      .copy-actions {
        display: grid;
        gap: 10px;
      }
      .footer-note {
        margin-top: 18px;
        color: var(--muted);
        font-size: 13px;
      }
      .footer-note a {
        color: #cfd8ff;
      }
      .flash {
        min-height: 20px;
        margin-top: 12px;
        color: #dce7ff;
        font-size: 13px;
      }
      @media (max-width: 560px) {
        body {
          padding: 16px;
        }
        .shell {
          padding: 28px 20px 22px;
          border-radius: 24px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="shell">
        <div class="content">
          <div class="logo-wrap">
            <img src="${escapeHtml(baseUrl)}/assets/nebulastreams-icon.jpg" alt="NebulaStreams">
          </div>
          <h1>Support NebulaStreams</h1>
          <p class="subtitle">Help keep the self-hosted streaming backend online, maintained, and improving over time.</p>

          <div class="blurb">
            <p>If NebulaStreams is useful to you, your support helps cover hosting, testing, and new provider work. Every contribution keeps the project more reliable.</p>
          </div>
          ${primarySection ? `<div class="support-grid">${primarySection}</div>` : ''}

          <div class="flash" id="flash" aria-live="polite"></div>
          <p class="footer-note">Main site: <a href="${escapeHtml(baseUrl)}" target="_blank" rel="noopener">${escapeHtml(baseUrl)}</a></p>
        </div>
      </section>
    </main>
    <script>
      const flash = document.getElementById('flash');
      const copyText = async (value, successMessage) => {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
          } else {
            const textarea = document.createElement('textarea');
            textarea.value = value;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
          }

          flash.textContent = successMessage;
          clearTimeout(flash._timer);
          flash._timer = setTimeout(() => { flash.textContent = ''; }, 2200);
        } catch {
          flash.textContent = 'Copy failed. Please copy manually.';
        }
      };

      const copyCryptoButton = document.getElementById('copy-crypto');
      const cryptoValue = document.getElementById('crypto-value');
      const qrImage = document.getElementById('crypto-qr');

      if (copyCryptoButton && cryptoValue) {
        copyCryptoButton.addEventListener('click', () => {
          void copyText(cryptoValue.textContent.trim(), 'Wallet address copied.');
        });
      }

      if (qrImage && cryptoValue) {
        const qrPayload = encodeURIComponent('https://link.trustwallet.com/send?asset=c195_tTR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t&address=' + cryptoValue.textContent.trim());
        qrImage.src = 'https://api.qrserver.com/v1/create-qr-code/?size=280x280&margin=8&data=' + qrPayload;
      }
    </script>
  </body>
</html>`;
};

const parseBasicAuth = (headerValue) => {
  if (!headerValue || !headerValue.startsWith('Basic ')) {
    return null;
  }

  try {
    const decoded = Buffer.from(headerValue.slice(6), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');

    if (separatorIndex === -1) {
      return null;
    }

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1)
    };
  } catch {
    return null;
  }
};

const parseCookies = (cookieHeader) => {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf('=');

      if (separatorIndex === -1) {
        return cookies;
      }

      const key = part.slice(0, separatorIndex);
      const value = part.slice(separatorIndex + 1);
      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
};

const createAdminSessionToken = () => {
  const payload = Buffer.from(JSON.stringify({
    username: config.ADMIN_USERNAME,
    expiresAt: Date.now() + ADMIN_SESSION_TTL_MS
  })).toString('base64url');
  const signature = crypto
    .createHmac('sha256', `${config.ADMIN_USERNAME}:${config.ADMIN_PASSWORD}`)
    .update(payload)
    .digest('base64url');

  return `${payload}.${signature}`;
};

const verifyAdminSessionToken = (token) => {
  if (!token || !token.includes('.')) {
    return false;
  }

  const [payload, signature] = token.split('.', 2);
  const expectedSignature = crypto
    .createHmac('sha256', `${config.ADMIN_USERNAME}:${config.ADMIN_PASSWORD}`)
    .update(payload)
    .digest('base64url');

  if (signature.length !== expectedSignature.length) {
    return false;
  }

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return false;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return decoded.username === config.ADMIN_USERNAME && Number(decoded.expiresAt) > Date.now();
  } catch {
    return false;
  }
};

const setAdminSessionCookie = (req, res) => {
  const cookieParts = [
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(createAdminSessionToken())}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`
  ];

  if (req.secure) {
    cookieParts.push('Secure');
  }

  res.setHeader('Set-Cookie', cookieParts.join('; '));
};

const clearAdminSessionCookie = (res) => {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
};

const getClientAddress = (req) => {
  const forwarded = req.headers?.['x-forwarded-for'];

  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return String(req.ip || req.socket?.remoteAddress || 'unknown').trim();
};

const createRateLimiter = ({ windowMs, limit, name, matcher }) => {
  if (!Number.isFinite(windowMs) || windowMs <= 0 || !Number.isFinite(limit) || limit <= 0) {
    return (_req, _res, next) => {
      next();
    };
  }

  const buckets = new Map();
  let requestCount = 0;

  const pruneBuckets = (now) => {
    for (const [key, bucket] of buckets.entries()) {
      if (bucket.resetAt <= now) {
        buckets.delete(key);
      }
    }

    if (buckets.size <= config.RATE_LIMIT_MAX_BUCKETS) {
      return;
    }

    const overflowCount = buckets.size - config.RATE_LIMIT_MAX_BUCKETS;
    const oldestKeys = Array.from(buckets.entries())
      .sort((left, right) => left[1].resetAt - right[1].resetAt)
      .slice(0, overflowCount)
      .map(([key]) => key);

    for (const key of oldestKeys) {
      buckets.delete(key);
    }
  };

  return (req, res, next) => {
    if (!matcher(req)) {
      next();
      return;
    }

    const now = Date.now();
    requestCount += 1;

    if (requestCount % 100 === 0 || buckets.size > config.RATE_LIMIT_MAX_BUCKETS) {
      pruneBuckets(now);
    }

    const key = `${name}:${getClientAddress(req)}`;
    const current = buckets.get(key);

    if (!current || current.resetAt <= now) {
      buckets.set(key, {
        count: 1,
        resetAt: now + windowMs
      });
      next();
      return;
    }

    current.count += 1;

    if (current.count <= limit) {
      next();
      return;
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));

    logger.warn('request rate limited', {
      limiter: name,
      path: req.path,
      ip: getClientAddress(req),
      retryAfterSeconds
    });

    const acceptsHtml = String(req.headers.accept || '').includes('text/html');

    if (acceptsHtml) {
      res.status(429).type('html').send('Too many requests. Please try again shortly.');
      return;
    }

    res.status(429).json({
      error: 'Too many requests',
      retryAfterSeconds
    });
  };
};

const BOT_USER_AGENT_PATTERN = /\b(?:ahrefs|aiohttp|axios|baiduspider|bingbot|bot|bytespider|claudebot|crawler|curl|discordbot|facebookexternalhit|googlebot|gptbot|go-http-client|headless|httpx|insomnia|libwww-perl|node-fetch|petalbot|phantomjs|playwright|postmanruntime|puppeteer|python-requests|python-urllib|scraper|selenium|semrush|slackbot|spider|undici|wget|yandex)\b/iu;
const BOT_STRICT_USER_AGENT_PATTERN = /(?:headless|phantomjs|playwright|puppeteer|selenium)/iu;
const BOT_SOFT_CLIENT_USER_AGENT_PATTERN = /\b(?:aiohttp|aiostreams|axios|curl|go-http-client|httpx|insomnia|libwww-perl|node-fetch|okhttp|postmanruntime|python-requests|python-urllib|stremioshell|stremio-apple|strmr|undici|wget)\b/iu;

const isPublicInstallInfoPath = (pathName) =>
  pathName === '/'
  || pathName === '/configure'
  || pathName === '/donate'
  || pathName === '/providers'
  || pathName === '/manifest.json'
  || pathName === '/stremio/manifest.json'
  || pathName.endsWith('/manifest.json');

const isBotProtectionIgnoredPath = (pathName) =>
  pathName === '/health'
  || isPublicInstallInfoPath(pathName)
  || pathName.startsWith('/admin')
  || pathName.startsWith('/assets/')
  || pathName === '/favicon.ico';

const isExpensiveBotProtectionPath = (pathName) =>
  pathName === '/stream'
  || pathName === '/http-stream'
  || pathName === '/stream/http'
  || pathName === '/stream/torrent'
  || pathName.startsWith('/stream/')
  || pathName.startsWith('/stremio/stream/')
  || pathName.startsWith('/preview/')
  || pathName.startsWith('/stremio/preview/')
  || (pathName.startsWith('/configured/') && (pathName.includes('/stream/') || pathName.includes('/preview/')))
  || (pathName.startsWith('/private/') && (pathName.includes('/stream/') || pathName.includes('/preview/')))
  || pathName.startsWith('/providers/');

const isAllowedBotProtectionClient = (userAgent) => {
  const normalized = String(userAgent || '').toLowerCase();

  return normalized.includes('stremio')
    || normalized.includes('stremioshell')
    || normalized.includes('stremio-apple')
    || normalized.includes('aiostreams')
    || normalized.includes('okhttp/')
    || normalized.includes('strmr/')
    || normalized.includes('qtwebengine/')
    || normalized.includes('tizen')
    || normalized.includes('mozilla/')
    || normalized.includes('applewebkit/')
    || normalized.includes('chrome/')
    || normalized.includes('safari/')
    || normalized.includes('firefox/');
};

const isLikelyAddonDataClient = (req, pathName, userAgent) => {
  if ((req.method || 'GET').toUpperCase() !== 'GET' || !isExpensiveBotProtectionPath(pathName)) {
    return false;
  }

  const normalizedUserAgent = String(userAgent || '').trim().toLowerCase();
  const accepts = String(req.headers.accept || '').toLowerCase();
  const fetchDest = String(req.headers['sec-fetch-dest'] || '').toLowerCase();
  const knownPlaybackClient = normalizedUserAgent.includes('stremio')
    || normalizedUserAgent.includes('stremioshell')
    || normalizedUserAgent.includes('stremio-apple')
    || normalizedUserAgent.includes('aiostreams')
    || normalizedUserAgent.includes('okhttp/')
    || normalizedUserAgent.includes('strmr/')
    || normalizedUserAgent.includes('qtwebengine/')
    || normalizedUserAgent.includes('webappmanager')
    || normalizedUserAgent.includes('tizen')
    || normalizedUserAgent.includes('web0s');
  const isAddonDataPath = pathName.endsWith('.json')
    || pathName.includes('/stream/')
    || pathName.includes('/preview/')
    || pathName.endsWith('/manifest.json');
  const wantsStructuredResponse = accepts.includes('application/json')
    || accepts.includes('text/plain')
    || accepts.includes('*/*')
    || (!accepts && isAddonDataPath)
    || knownPlaybackClient;
  const isHtmlNavigation = accepts.includes('text/html') && !wantsStructuredResponse;

  return wantsStructuredResponse
    && !isHtmlNavigation
    && isAddonDataPath
    && fetchDest !== 'document'
    && !normalizedUserAgent.includes('mozilla/5.0 (compatible;');
};

const sendBotProtectionResponse = (req, res, retryAfterSeconds) => {
  if (retryAfterSeconds) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
  }

  const acceptsHtml = String(req.headers.accept || '').includes('text/html');

  if (acceptsHtml) {
    res.status(403).type('html').send('Access blocked.');
    return;
  }

  res.status(403).json({
    error: 'Forbidden'
  });
};

const sendBotThrottleResponse = (req, res, retryAfterSeconds) => {
  if (retryAfterSeconds) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
  }

  const acceptsHtml = String(req.headers.accept || '').includes('text/html');

  if (acceptsHtml) {
    res.status(429).type('html').send('Too many requests. Try again shortly.');
    return;
  }

  res.status(429).json({
    error: 'Too Many Requests'
  });
};

const createBotProtection = () => {
  const clients = new Map();
  let requestCount = 0;

  const windowMs = config.BOT_PROTECTION_WINDOW_SECONDS * 1000;
  const blockMs = config.BOT_PROTECTION_BLOCK_SECONDS * 1000;

  const pruneClients = (now) => {
    for (const [key, state] of clients.entries()) {
      if (state.resetAt <= now && state.blockedUntil <= now) {
        clients.delete(key);
      }
    }

    if (clients.size <= config.BOT_PROTECTION_MAX_TRACKED_CLIENTS) {
      return;
    }

    const overflowCount = clients.size - config.BOT_PROTECTION_MAX_TRACKED_CLIENTS;
    const oldestKeys = Array.from(clients.entries())
      .sort((left, right) => Math.min(left[1].resetAt, left[1].blockedUntil) - Math.min(right[1].resetAt, right[1].blockedUntil))
      .slice(0, overflowCount)
      .map(([key]) => key);

    for (const key of oldestKeys) {
      clients.delete(key);
    }
  };

  const getClientState = (key, now) => {
    const current = clients.get(key);

    if (current && current.resetAt > now) {
      return current;
    }

    const nextState = {
      expensiveCount: 0,
      suspiciousCount: 0,
      resetAt: now + windowMs,
      blockedUntil: current?.blockedUntil && current.blockedUntil > now ? current.blockedUntil : 0
    };

    clients.set(key, nextState);
    return nextState;
  };

  return (req, res, next) => {
    if (!config.BOT_PROTECTION_ENABLED || req.method === 'OPTIONS' || isBotProtectionIgnoredPath(req.path)) {
      next();
      return;
    }

    const pathName = req.path || '';
    const isExpensivePath = isExpensiveBotProtectionPath(pathName);
    const userAgent = String(req.headers['user-agent'] || '').trim();
    const normalizedUserAgent = userAgent.toLowerCase();
    const trustedStremioClient = normalizedUserAgent.includes('stremio/');
    const likelyAddonDataClient = isLikelyAddonDataClient(req, pathName, userAgent);
    const strictSuspiciousUserAgent = BOT_STRICT_USER_AGENT_PATTERN.test(userAgent);
    const suspiciousUserAgent = strictSuspiciousUserAgent
      || (BOT_USER_AGENT_PATTERN.test(userAgent) && !isAllowedBotProtectionClient(userAgent));
    const softClientUserAgent = BOT_SOFT_CLIENT_USER_AGENT_PATTERN.test(userAgent);
    const softAddonClient = likelyAddonDataClient && softClientUserAgent && !strictSuspiciousUserAgent;
    const shouldTreatAsSuspicious = suspiciousUserAgent && !softAddonClient;

    if (trustedStremioClient && !suspiciousUserAgent) {
      next();
      return;
    }

    if (!isExpensivePath && !suspiciousUserAgent) {
      next();
      return;
    }

    const now = Date.now();
    requestCount += 1;

    if (requestCount % 100 === 0 || clients.size > config.BOT_PROTECTION_MAX_TRACKED_CLIENTS) {
      pruneClients(now);
    }

    const ip = getClientAddress(req);
    const state = getClientState(ip, now);

    if (state.blockedUntil > now) {
      const retryAfterSeconds = Math.max(1, Math.ceil((state.blockedUntil - now) / 1000));
      if (likelyAddonDataClient && !strictSuspiciousUserAgent) {
        const shortenedBlockedUntil = Math.min(state.blockedUntil, now + 30_000);
        if (shortenedBlockedUntil !== state.blockedUntil) {
          state.blockedUntil = shortenedBlockedUntil;
        }

        logger.warn('bot protection rate limited request', {
          reason: 'temporary-ip-throttle',
          path: pathName,
          ip,
          retryAfterSeconds: Math.max(5, Math.min(30, Math.ceil((state.blockedUntil - now) / 1000))),
          userAgent: userAgent.slice(0, 160)
        });
        sendBotThrottleResponse(req, res, Math.max(5, Math.min(30, Math.ceil((state.blockedUntil - now) / 1000))));
        return;
      }

      logger.warn('bot protection blocked request', {
        reason: 'temporary-ip-block',
        path: pathName,
        ip,
        retryAfterSeconds,
        userAgent: userAgent.slice(0, 160)
      });
      sendBotProtectionResponse(req, res, retryAfterSeconds);
      return;
    }

    if (isExpensivePath) {
      state.expensiveCount += 1;
    }

    if (shouldTreatAsSuspicious) {
      state.suspiciousCount += 1;
    }

    const expensiveRequestLimit = likelyAddonDataClient
      ? Math.max(config.BOT_PROTECTION_EXPENSIVE_REQUEST_LIMIT * 8, config.BOT_PROTECTION_EXPENSIVE_REQUEST_LIMIT + 60)
      : config.BOT_PROTECTION_EXPENSIVE_REQUEST_LIMIT;
    const overExpensiveLimit = state.expensiveCount > expensiveRequestLimit;
    const overSuspiciousLimit = state.suspiciousCount > config.BOT_PROTECTION_SUSPICIOUS_REQUEST_LIMIT;
    const instantScraperBlock = shouldTreatAsSuspicious && isExpensivePath;

    if (!overExpensiveLimit && !overSuspiciousLimit && !instantScraperBlock) {
      next();
      return;
    }

    if (likelyAddonDataClient && !strictSuspiciousUserAgent && (overExpensiveLimit || overSuspiciousLimit)) {
      const retryAfterSeconds = Math.max(5, Math.min(30, Math.ceil((state.resetAt - now) / 1000)));
      logger.warn('bot protection rate limited request', {
        reason: overSuspiciousLimit ? 'suspicious-client-throttle' : 'expensive-request-throttle',
        path: pathName,
        ip,
        expensiveCount: state.expensiveCount,
        expensiveRequestLimit,
        retryAfterSeconds,
        userAgent: userAgent.slice(0, 160)
      });
      sendBotThrottleResponse(req, res, retryAfterSeconds);
      return;
    }

    state.blockedUntil = now + blockMs;
    const reason = instantScraperBlock
      ? 'scraper-user-agent-on-expensive-route'
      : overSuspiciousLimit
        ? 'suspicious-user-agent-limit'
        : 'expensive-request-limit';

    logger.warn('bot protection blocked request', {
      reason,
      path: pathName,
      ip,
      expensiveCount: state.expensiveCount,
      suspiciousCount: state.suspiciousCount,
      retryAfterSeconds: config.BOT_PROTECTION_BLOCK_SECONDS,
      userAgent: userAgent.slice(0, 160)
    });

    sendBotProtectionResponse(req, res, config.BOT_PROTECTION_BLOCK_SECONDS);
  };
};

const startMemoryGuard = ({
  streamManager,
  providerService,
  imdbResolver,
  userTracker,
  sourceRegistry
}) => {
  if (!config.MEMORY_GUARD_ENABLED) {
    return null;
  }

  let running = false;
  let criticalStrikes = 0;
  const runCleanup = async () => {
    if (running) {
      return;
    }

    running = true;

    try {
      const memory = await getSystemMemorySnapshot();
      const usagePercent = memory.totalMemoryBytes > 0
        ? ((memory.totalMemoryBytes - memory.availableMemoryBytes) / memory.totalMemoryBytes) * 100
        : 0;

      if (usagePercent < config.MEMORY_GUARD_PRESSURE_PERCENT) {
        criticalStrikes = 0;
        return;
      }

      const critical = usagePercent >= config.MEMORY_GUARD_CRITICAL_PERCENT;
      criticalStrikes = critical ? criticalStrikes + 1 : 0;
      const before = {
        availableMemoryBytes: memory.availableMemoryBytes,
        usagePercent,
        processMemory: process.memoryUsage(),
        streams: streamManager.getStats(),
        providers: providerService.getStats(),
        users: userTracker.getStats(),
        sourceRegistry: sourceRegistry.getStats()
      };

      streamManager.handleMemoryPressure({ critical });
      streamManager.enableLoadShedding({
        durationMs: config.MEMORY_GUARD_SHED_SECONDS * 1000,
        reason: critical ? 'critical-memory-pressure' : 'memory-pressure'
      });
      providerService.handleMemoryPressure({ critical });
      imdbResolver.handleMemoryPressure({ critical });
      userTracker.handleMemoryPressure({ critical });
      sourceRegistry.handleMemoryPressure({ critical });

      logger.warn('memory guard trimmed runtime caches', {
        critical,
        pressurePercent: Number(usagePercent.toFixed(1)),
        thresholdPercent: config.MEMORY_GUARD_PRESSURE_PERCENT,
        criticalPercent: config.MEMORY_GUARD_CRITICAL_PERCENT,
        availableMemoryBytes: memory.availableMemoryBytes,
        processRssBytes: before.processMemory.rss,
        stremioResultCacheEntries: before.streams.stremioResultCacheEntries,
        hubCloudCacheEntries: before.streams.hubCloudCacheEntries,
        providerCacheEntries: before.providers.inMemoryCacheEntries,
        rawUniqueClients: before.users.rawUniqueClients,
        sourceRegistryEntries: before.sourceRegistry.entries
      });

      const restartRequired = usagePercent >= config.MEMORY_GUARD_RESTART_PERCENT
        || criticalStrikes >= config.MEMORY_GUARD_RESTART_AFTER_CRITICAL
        || memory.availableMemoryBytes <= config.MEMORY_GUARD_MIN_AVAILABLE_MB * 1024 * 1024;

      if (restartRequired) {
        logger.error('memory guard restarting process before system lockup', {
          criticalStrikes,
          pressurePercent: Number(usagePercent.toFixed(1)),
          restartPercent: config.MEMORY_GUARD_RESTART_PERCENT,
          availableMemoryBytes: memory.availableMemoryBytes,
          minAvailableBytes: config.MEMORY_GUARD_MIN_AVAILABLE_MB * 1024 * 1024,
          processRssBytes: before.processMemory.rss
        });

        await Promise.race([
          userTracker.flush(),
          sleep(1000)
        ]).catch((error) => {
          logger.warn('memory guard analytics flush before restart failed', { error });
        });
        process.exit(1);
      }
    } catch (error) {
      logger.warn('memory guard cleanup failed', { error });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(runCleanup, config.MEMORY_GUARD_INTERVAL_SECONDS * 1000);
  timer.unref();
  return timer;
};

const hasValidAdminSession = (req) => {
  const cookies = parseCookies(req.headers.cookie);
  return verifyAdminSessionToken(cookies[ADMIN_COOKIE_NAME]);
};

const requireAdminAuth = (req, res, next) => {
  if (hasValidAdminSession(req)) {
    next();
    return;
  }

  const credentials = parseBasicAuth(req.headers.authorization);

  if (!credentials || credentials.username !== config.ADMIN_USERNAME || credentials.password !== config.ADMIN_PASSWORD) {
    res.redirect(302, '/admin/login');
    return;
  }

  setAdminSessionCookie(req, res);
  next();
};

const bootstrap = async () => {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  if (config.REVERSE_PROXY_TARGET) {
    const reverseProxy = new ReverseProxyService({
      targetBaseUrl: config.REVERSE_PROXY_TARGET,
      timeoutSeconds: config.REVERSE_PROXY_TIMEOUT_SECONDS
    });

    app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        mode: 'reverse-proxy',
        target: config.REVERSE_PROXY_TARGET
      });
    });

    app.use((req, res, next) => {
      reverseProxy.handle(req, res, next).catch(next);
    });

    app.use((error, _req, res, _next) => {
      logger.error('reverse proxy request failed', { error });
      res.status(502).json({
        error: 'Reverse proxy request failed',
        details: error?.message || 'unknown error'
      });
    });

    const proxyServer = app.listen(config.PORT, () => {
      logger.info('reverse proxy started', {
        port: config.PORT,
        target: config.REVERSE_PROXY_TARGET
      });
    });
    proxyServer.keepAliveTimeout = 65_000;
    proxyServer.headersTimeout = 66_000;
    return;
  }

  const cacheManager = new CacheManager();

  await cacheManager.initialize();

  const sourceRegistry = new SourceRegistry();
  const imdbResolver = new ImdbResolverService();
  const providerService = new ProviderService();
  await providerService.initialize();
  const userTracker = new UserTrackerService();
  await userTracker.initialize();
  const torrentEngine = new TorrentEngineService({ cacheManager });
  const httpProxy = new HttpProxyService({ cacheManager, torrentEngine });
  const streamManager = new StreamManager({
    torrentEngine,
    httpProxy,
    cacheManager,
    sourceRegistry,
    providerService,
    imdbResolver,
    userTracker
  });
  await streamManager.initialize();

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Accept, Origin, User-Agent');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });
  app.use(createBotProtection());
  app.use((req, _res, next) => {
    userTracker.trackRequest(req);
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: false, limit: '8kb' }));
  app.use('/assets', express.static('assets', {
    maxAge: '7d',
    immutable: true
  }));
  app.use(createRateLimiter({
    name: 'public',
    windowMs: config.PUBLIC_RATE_LIMIT_WINDOW_SECONDS * 1000,
    limit: config.PUBLIC_RATE_LIMIT_MAX_REQUESTS,
    matcher: (req) => {
      if (req.path.startsWith('/admin')) {
        return false;
      }

      return req.path === '/'
        || req.path === '/configure'
        || req.path === '/manifest.json'
        || req.path === '/stremio/manifest.json'
        || req.path.startsWith('/preview/')
        || req.path.startsWith('/stremio/preview/')
        || req.path.startsWith('/configured/')
        || req.path.startsWith('/private/');
    }
  }));
  app.use(createRateLimiter({
    name: 'streams',
    windowMs: config.STREAM_RATE_LIMIT_WINDOW_SECONDS * 1000,
    limit: config.STREAM_RATE_LIMIT_MAX_REQUESTS,
    matcher: (req) => req.path.startsWith('/stream/')
      || req.path === '/stream'
      || req.path === '/http-stream'
      || req.path === '/stream/http'
      || req.path === '/stream/torrent'
      || req.path.startsWith('/stremio/stream/')
  }));
  app.use(createRateLimiter({
    name: 'providers',
    windowMs: config.PROVIDER_RATE_LIMIT_WINDOW_SECONDS * 1000,
    limit: config.PROVIDER_RATE_LIMIT_MAX_REQUESTS,
    matcher: (req) => req.path.startsWith('/providers')
  }));

  app.get('/health', async (_req, res, next) => {
    try {
      const cacheStats = await cacheManager.getCacheStats(torrentEngine.getActiveCachePaths());
      const streamStats = streamManager.getStats();
      const memory = await getSystemMemorySnapshot();
      const memoryUsagePercent = memory.totalMemoryBytes > 0
        ? ((memory.totalMemoryBytes - memory.availableMemoryBytes) / memory.totalMemoryBytes) * 100
        : 0;
      const {
        configureUsers: _configureUsers,
        configureRequests: _configureRequests,
        ...publicUserStats
      } = userTracker.getStats();

      res.json({
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
        activeTorrentEngines: torrentEngine.getActiveCachePaths().length,
        activeStreams: streamStats.activeStreams,
        maxActiveStreams: streamStats.maxActiveStreams,
        streams: streamStats,
        memory: {
          totalMemoryBytes: memory.totalMemoryBytes,
          availableMemoryBytes: memory.availableMemoryBytes,
          freeMemoryBytes: memory.freeMemoryBytes,
          usagePercent: memoryUsagePercent,
          guardEnabled: config.MEMORY_GUARD_ENABLED,
          guardPressurePercent: config.MEMORY_GUARD_PRESSURE_PERCENT,
          guardCriticalPercent: config.MEMORY_GUARD_CRITICAL_PERCENT
        },
        users: publicUserStats,
        cache: cacheStats
      });
    } catch (error) {
      next(error);
    }
  });

  const renderConfigureResponse = (req, res) => {
    res
      .status(200)
      .type('html')
      .send(renderConfigurePage({
        baseUrl: getPublicBaseUrl(req),
        providers: providerService.listProviders()
      }));
  };

  app.get('/', renderConfigureResponse);
  app.get('/configure', renderConfigureResponse);

  app.get('/donate', (req, res) => {
    res
      .status(200)
      .type('html')
      .send(renderDonatePage({
        baseUrl: getPublicBaseUrl(req)
      }));
  });

  app.get('/admin/login', (req, res) => {
    if (hasValidAdminSession(req)) {
      res.redirect(302, '/admin');
      return;
    }

    res.status(200).type('html').send(renderAdminLoginPage({
      errorMessage: req.query.error === 'invalid' ? 'Invalid admin credentials.' : ''
    }));
  });

  app.post('/admin/login', (req, res) => {
    const { username = '', password = '' } = req.body ?? {};

    if (username !== config.ADMIN_USERNAME || password !== config.ADMIN_PASSWORD) {
      clearAdminSessionCookie(res);
      res.redirect(302, '/admin/login?error=invalid');
      return;
    }

    setAdminSessionCookie(req, res);
    res.redirect(302, '/admin');
  });

  app.post('/admin/logout', (req, res) => {
    clearAdminSessionCookie(res);
    res.redirect(302, '/admin/login');
  });

  app.get('/admin', requireAdminAuth, async (req, res, next) => {
    try {
      const systemStats = await getSystemStats();
      const cacheStats = await cacheManager.getCacheStats(torrentEngine.getActiveCachePaths());
      const streamStats = streamManager.getStats();
      const stats = {
        runtime: {
          uptimeSeconds: Math.round(process.uptime()),
          activeTorrentEngines: torrentEngine.getActiveCachePaths().length,
          activeStreams: streamStats.activeStreams,
          maxActiveStreams: streamStats.maxActiveStreams,
          streamSearchesInFlight: streamStats.stremioResultInFlight,
          maxStreamSearchesInFlight: streamStats.maxStremioResultInFlight,
          stremioResultCacheEntries: streamStats.stremioResultCacheEntries,
          stremioBackgroundRefreshActive: streamStats.stremioBackgroundRefreshActive,
          stremioBackgroundRefreshQueued: streamStats.stremioBackgroundRefreshQueued,
          redisStreamResultCache: streamStats.redisStreamResultCache,
          hubCloudCacheEntries: streamStats.hubCloudCacheEntries,
          popularStreamPrewarm: streamStats.popularStreamPrewarm
        },
        system: systemStats,
        users: userTracker.getStats(),
        cache: cacheStats,
        providers: providerService.getStats(),
        sourceRegistry: sourceRegistry.getStats()
      };

      res.status(200).type('html').send(renderAdminPage({ stats }));
    } catch (error) {
      next(error);
    }
  });

  app.get('/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/stremio/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.post('/configure/private-config', streamManager.handleCreatePrivateConfig.bind(streamManager));
  app.get('/configured/:providerConfig/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/stremio/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stremio/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/stremio/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/private/:privateConfigId/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/private/:privateConfigId/stremio/manifest.json', streamManager.handleStremioManifest.bind(streamManager));
  app.get('/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/stremio/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/stremio/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/private/:privateConfigId/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/private/:privateConfigId/stremio/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/private/:privateConfigId/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/private/:privateConfigId/stremio/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/configured/:providerConfig/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/stremio/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/configured/:providerConfig/stremio/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stremio/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/stremio/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/stremio/stream/:type/:id.json', streamManager.handleStremioStreams.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/configured/:providerConfig/:qualityConfig/:optionConfig/stremio/preview/:type/:id.json', streamManager.handleStremioPreview.bind(streamManager));
  app.get('/providers', (_req, res) => {
    res.json({
      providers: providerService.listProviders()
    });
  });
  app.get('/providers/aggregate/streams', streamManager.handleAggregateProviderStreams.bind(streamManager));
  app.get('/providers/:provider/streams', streamManager.handleProviderStreams.bind(streamManager));
  app.get('/cache/stats', streamManager.handleCacheStats.bind(streamManager));
  app.post('/add-source', streamManager.handleAddSource.bind(streamManager));
  app.get('/stream', streamManager.handleUnifiedStream.bind(streamManager));
  app.get('/http-stream', streamManager.handleHttpStream.bind(streamManager));
  app.get('/stream/http', streamManager.handleHttpStream.bind(streamManager));
  app.get('/stream/torrent/:infoHash/:filename', streamManager.handleTorrentFileStream.bind(streamManager));
  app.get('/stream/torrent', streamManager.handleTorrentStream.bind(streamManager));

  app.use((_req, _res, next) => {
    next(new HttpError(404, 'Route not found'));
  });

  app.use((error, _req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }

    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    const message = error instanceof HttpError ? error.message : 'Internal server error';

    if (statusCode >= 500) {
      logger.error('request failed', {
        error
      });
    }

    res.status(statusCode).json({
      error: message,
      ...(error instanceof HttpError && error.details ? { details: error.details } : {})
    });
  });

  const server = app.listen(config.PORT, () => {
    logger.info('server started', {
      port: config.PORT,
      maxActiveTorrents: config.MAX_ACTIVE_TORRENTS,
      torrentConnections: config.TORRENT_CONNECTIONS
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  const memoryGuardTimer = startMemoryGuard({
    streamManager,
    providerService,
    imdbResolver,
    userTracker,
    sourceRegistry
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info('server shutting down', { signal });

    const closeActiveConnectionsTimer = setTimeout(() => {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    }, 5_000);

    const forceExitTimer = setTimeout(() => {
      process.exit(0);
    }, 20_000);

    closeActiveConnectionsTimer.unref();
    forceExitTimer.unref();

    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    if (memoryGuardTimer) {
      clearInterval(memoryGuardTimer);
    }

    await torrentEngine.close();
    await streamManager.close();
    sourceRegistry.close();
    await userTracker.close();
    clearTimeout(closeActiveConnectionsTimer);
    clearTimeout(forceExitTimer);
    process.exit(0);
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((error) => {
      logger.error('shutdown failed', { error });
      process.exit(1);
    });
  });

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((error) => {
      logger.error('shutdown failed', { error });
      process.exit(1);
    });
  });

  process.on('unhandledRejection', (error) => {
    logger.error('unhandled rejection', { error });
  });

  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { error });
  });
};

bootstrap().catch((error) => {
  logger.error('server bootstrap failed', { error });
  process.exit(1);
});
