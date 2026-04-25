import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';

import axios from 'axios';

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { createHttpError, parseRangeHeader } from './streamManager.js';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

const SYSTEM_CA_PATHS = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/ca-bundle.pem'
];

const isPrivateIPv4 = (address) => {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));

  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return true;
  }

  const [first, second] = parts;

  return first === 10
    || first === 127
    || first === 0
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first >= 224;
};

const isPrivateIPv6 = (address) => {
  const normalized = address.toLowerCase();

  return normalized === '::1'
    || normalized === '::'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
    || normalized.startsWith('::ffff:127.')
    || normalized.startsWith('::ffff:10.')
    || normalized.startsWith('::ffff:192.168.')
    || /^::ffff:172\.(1[6-9]|2\d|3[0-1])\./u.test(normalized);
};

const isPublicAddress = (address) => {
  const version = net.isIP(address);

  if (version === 4) {
    return !isPrivateIPv4(address);
  }

  if (version === 6) {
    return !isPrivateIPv6(address);
  }

  return false;
};

const loadSystemCaBundle = () => {
  for (const certificatePath of SYSTEM_CA_PATHS) {
    if (existsSync(certificatePath)) {
      return readFileSync(certificatePath, 'utf8');
    }
  }

  return null;
};

export class HttpProxyService {
  constructor({ cacheManager, torrentEngine }) {
    this.cacheManager = cacheManager;
    this.torrentEngine = torrentEngine;
    this.caBundle = loadSystemCaBundle();

    this.client = axios.create({
      httpAgent: new http.Agent({
        keepAlive: true,
        keepAliveMsecs: config.HTTP_KEEP_ALIVE_MILLISECONDS,
        maxSockets: config.HTTP_MAX_SOCKETS,
        maxFreeSockets: config.HTTP_MAX_FREE_SOCKETS,
        scheduling: 'lifo'
      }),
      httpsAgent: new https.Agent({
        keepAlive: true,
        keepAliveMsecs: config.HTTP_KEEP_ALIVE_MILLISECONDS,
        maxSockets: config.HTTP_MAX_SOCKETS,
        maxFreeSockets: config.HTTP_MAX_FREE_SOCKETS,
        scheduling: 'lifo',
        ...(this.caBundle ? { ca: this.caBundle } : {})
      }),
      timeout: config.HTTP_STREAM_TIMEOUT_SECONDS * 1000,
      maxRedirects: 3,
      validateStatus: (status) => status >= 200 && status < 300
    });
  }

  async getStreamDescriptor({ targetUrl, rangeHeader, requestHeaders = null }) {
    const normalizedUrl = await this.validateTargetUrl(targetUrl);
    const cachedEntry = await this.cacheManager.getHttpCacheEntry(normalizedUrl);

    if (cachedEntry) {
      await this.cacheManager.touchPath(cachedEntry.dataPath);
      return this.createCachedDescriptor(cachedEntry, rangeHeader);
    }

    return this.getUpstreamStreamDescriptor({
      targetUrl: normalizedUrl,
      rangeHeader,
      requestHeaders
    });
  }

  async getUpstreamStreamDescriptor({ targetUrl, rangeHeader, requestHeaders = null }) {
    let upstreamResponse;

    const forwardedHeaders = {
      'accept-encoding': 'identity',
      ...(requestHeaders || {}),
      ...(rangeHeader ? { range: rangeHeader } : {})
    };

    try {
      upstreamResponse = await this.client.get(targetUrl, {
        family: 4,
        headers: forwardedHeaders,
        responseType: 'stream'
      });
    } catch (error) {
      throw this.mapUpstreamError(error);
    }

    const upstreamHeaders = this.filterResponseHeaders(upstreamResponse.headers);
    logger.info('http stream started', {
      targetUrl,
      statusCode: upstreamResponse.status,
      rangeRequested: Boolean(rangeHeader)
    });
    const rangeRequested = Boolean(rangeHeader);
    const contentLength = upstreamResponse.headers['content-length']
      ? Number.parseInt(upstreamResponse.headers['content-length'], 10)
      : null;
    const shouldCache = !rangeRequested
      && upstreamResponse.status === 200
      && Number.isInteger(contentLength)
      && contentLength > 0
      && contentLength <= this.cacheManager.maxCacheSizeBytes;

    if (!shouldCache) {
      return {
        statusCode: upstreamResponse.status,
        stream: upstreamResponse.data,
        headers: {
          ...upstreamHeaders,
          'Cache-Control': 'no-store'
        },
        cleanup: async ({ completed }) => {
          if (!completed && !upstreamResponse.data.destroyed) {
            upstreamResponse.data.destroy();
          }
        }
      };
    }

    const cacheWrite = await this.cacheManager.createHttpCacheWrite(targetUrl, upstreamResponse.headers);

    if (!cacheWrite) {
      return {
        statusCode: upstreamResponse.status,
        stream: upstreamResponse.data,
        headers: {
          ...upstreamHeaders,
          'Cache-Control': 'no-store'
        },
        cleanup: async ({ completed }) => {
          if (!completed && !upstreamResponse.data.destroyed) {
            upstreamResponse.data.destroy();
          }
        }
      };
    }

    const clientStream = new PassThrough();
    const cacheStream = new PassThrough();
    const writerFinished = finished(cacheWrite.writer);

    upstreamResponse.data.pipe(clientStream);
    upstreamResponse.data.pipe(cacheStream);
    cacheStream.pipe(cacheWrite.writer);

    return {
      statusCode: upstreamResponse.status,
      stream: clientStream,
      headers: {
        ...upstreamHeaders,
        'Cache-Control': 'no-store',
        'X-Cache-Status': 'MISS'
      },
      cleanup: async ({ completed }) => {
        if (!completed) {
          upstreamResponse.data.destroy();
          clientStream.destroy();
          cacheStream.destroy();
          await cacheWrite.abort();
          return;
        }

        try {
          await writerFinished;
          await cacheWrite.commit();
          await this.cacheManager.pruneCache(this.torrentEngine.getActiveCachePaths());
        } catch (error) {
          logger.error('cache commit failed', {
            targetUrl,
            error
          });
          await cacheWrite.abort();
        }
      }
    };
  }

  async validateTargetUrl(targetUrl) {
    if (typeof targetUrl !== 'string' || !targetUrl.trim()) {
      throw createHttpError(400, 'A url query parameter is required');
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      throw createHttpError(400, 'Invalid upstream URL');
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw createHttpError(400, 'Only HTTP and HTTPS upstream URLs are supported');
    }

    if (parsedUrl.username || parsedUrl.password) {
      throw createHttpError(400, 'Credentials are not allowed in upstream URLs');
    }

    if (parsedUrl.hostname.toLowerCase() === 'localhost' || parsedUrl.hostname.toLowerCase().endsWith('.local')) {
      throw createHttpError(400, 'Private upstream destinations are not allowed');
    }

    let resolvedAddresses;

    try {
      resolvedAddresses = net.isIP(parsedUrl.hostname)
        ? [{ address: parsedUrl.hostname }]
        : await dns.lookup(parsedUrl.hostname, { all: true, verbatim: true });
    } catch {
      throw createHttpError(502, 'Failed to resolve upstream host');
    }

    if (resolvedAddresses.length === 0 || resolvedAddresses.some(({ address }) => !isPublicAddress(address))) {
      throw createHttpError(400, 'Private upstream destinations are not allowed');
    }

    return parsedUrl.toString();
  }

  createCachedDescriptor(entry, rangeHeader) {
    const range = parseRangeHeader(rangeHeader, entry.size);

    return {
      statusCode: range.statusCode,
      stream: createReadStream(entry.dataPath, { start: range.start, end: range.end }),
      headers: {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Length': range.contentLength,
        'Content-Range': range.contentRange,
        'Content-Type': entry.metadata.contentType || 'application/octet-stream',
        'X-Cache-Status': 'HIT'
      }
    };
  }

  filterResponseHeaders(headers) {
    const output = {};

    for (const [headerName, headerValue] of Object.entries(headers)) {
      if (!HOP_BY_HOP_HEADERS.has(headerName.toLowerCase())) {
        output[headerName] = headerValue;
      }
    }

    return output;
  }

  mapUpstreamError(error) {
    let mappedError;

    if (error.response) {
      mappedError = createHttpError(502, `Upstream server returned ${error.response.status}`);
      logger.error('http stream failed', {
        statusCode: error.response.status,
        error: mappedError
      });
      return mappedError;
    }

    if (error.code === 'ECONNABORTED') {
      mappedError = createHttpError(504, 'Upstream request timed out');
      logger.error('http stream failed', {
        code: error.code,
        error: mappedError
      });
      return mappedError;
    }

    if (error.code === 'ERR_BAD_REQUEST' || error.code === 'ERR_BAD_RESPONSE') {
      mappedError = createHttpError(502, 'Invalid upstream response');
      logger.error('http stream failed', {
        code: error.code,
        error: mappedError
      });
      return mappedError;
    }

    mappedError = createHttpError(502, 'Failed to reach upstream server');
    logger.error('http stream failed', {
      code: error.code,
      error: mappedError
    });
    return mappedError;
  }
}
