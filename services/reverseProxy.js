import http from 'node:http';
import https from 'node:https';

import { logger } from '../utils/logger.js';

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

const DEFAULT_PORTS = Object.freeze({
  'http:': 80,
  'https:': 443
});

const appendForwardedFor = (existing, remoteAddress) => {
  const normalizedRemote = String(remoteAddress || '').trim();

  if (!normalizedRemote) {
    return existing || undefined;
  }

  return existing
    ? `${existing}, ${normalizedRemote}`
    : normalizedRemote;
};

const sanitizeHeaders = (headers, requestContext = {}) => {
  const nextHeaders = {};

  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = String(rawName || '').toLowerCase();

    if (!name || HOP_BY_HOP_HEADERS.has(name) || rawValue == null) {
      continue;
    }

    nextHeaders[name] = rawValue;
  }

  if (requestContext.upstreamHost) {
    nextHeaders.host = requestContext.upstreamHost;
  }

  if (requestContext.originalHost) {
    nextHeaders['x-forwarded-host'] = requestContext.originalHost;
  }

  if (requestContext.proto) {
    nextHeaders['x-forwarded-proto'] = requestContext.proto;
  }

  nextHeaders['x-forwarded-for'] = appendForwardedFor(
    typeof nextHeaders['x-forwarded-for'] === 'string' ? nextHeaders['x-forwarded-for'] : '',
    requestContext.remoteAddress
  );

  return nextHeaders;
};

export class ReverseProxyService {
  constructor({ targetBaseUrl, timeoutSeconds }) {
    this.targetBaseUrl = new URL(targetBaseUrl);
    this.timeoutMs = Math.max(1, Number(timeoutSeconds || 20)) * 1000;
    this.httpAgent = new http.Agent({ keepAlive: true });
    this.httpsAgent = new https.Agent({ keepAlive: true });
  }

  getTargetUrl(requestPath) {
    return new URL(requestPath || '/', this.targetBaseUrl);
  }

  getTransport(protocol) {
    return protocol === 'https:' ? https : http;
  }

  getAgent(protocol) {
    return protocol === 'https:' ? this.httpsAgent : this.httpAgent;
  }

  isRetryableMethod(method) {
    const normalizedMethod = String(method || 'GET').trim().toUpperCase();
    return normalizedMethod === 'GET' || normalizedMethod === 'HEAD';
  }

  shouldRetryError(error) {
    return /timed out|timeout|ECONNRESET|EPIPE|socket hang up|fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i
      .test(String(error?.message || error || ''));
  }

  async handle(req, res, next) {
    const targetUrl = this.getTargetUrl(req.originalUrl || req.url);
    const transport = this.getTransport(targetUrl.protocol);
    const requestBodyChunks = [];
    let aborted = false;
    let activeUpstreamRequest = null;

    req.on('aborted', () => {
      aborted = true;
      activeUpstreamRequest?.destroy();
    });

    req.on('data', (chunk) => {
      requestBodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on('end', () => {
      const requestBody = requestBodyChunks.length > 0
        ? Buffer.concat(requestBodyChunks)
        : null;
      const maxAttempts = this.isRetryableMethod(req.method) ? 2 : 1;

      const attemptProxy = (attemptNumber) => {
        if (aborted || res.headersSent) {
          return;
        }

        const upstreamRequest = transport.request({
          protocol: targetUrl.protocol,
          hostname: targetUrl.hostname,
          port: targetUrl.port || DEFAULT_PORTS[targetUrl.protocol],
          method: req.method,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          agent: this.getAgent(targetUrl.protocol),
          headers: sanitizeHeaders(req.headers, {
            upstreamHost: targetUrl.host,
            originalHost: req.get('host'),
            proto: req.protocol,
            remoteAddress: req.ip || req.socket.remoteAddress
          })
        }, (upstreamResponse) => {
          const responseHeaders = sanitizeHeaders(upstreamResponse.headers);

          res.status(upstreamResponse.statusCode || 502);

          for (const [headerName, headerValue] of Object.entries(responseHeaders)) {
            if (headerValue != null) {
              res.setHeader(headerName, headerValue);
            }
          }

          upstreamResponse.pipe(res);
          upstreamResponse.on('error', (error) => {
            logger.warn('reverse proxy upstream response failed', {
              targetUrl: targetUrl.toString(),
              attempt: attemptNumber,
              error
            });
            res.destroy(error);
          });
        });

        activeUpstreamRequest = upstreamRequest;

        upstreamRequest.setTimeout(this.timeoutMs, () => {
          upstreamRequest.destroy(new Error(`Reverse proxy upstream timed out after ${this.timeoutMs}ms`));
        });

        upstreamRequest.on('error', (error) => {
          if (res.headersSent || aborted) {
            if (res.headersSent) {
              res.destroy(error);
            }
            return;
          }

          const canRetry = attemptNumber < maxAttempts && this.shouldRetryError(error);

          if (canRetry) {
            logger.warn('reverse proxy request retrying after upstream failure', {
              targetUrl: targetUrl.toString(),
              attempt: attemptNumber,
              error
            });
            setTimeout(() => attemptProxy(attemptNumber + 1), 150);
            return;
          }

          next(error);
        });

        if (requestBody?.length) {
          upstreamRequest.end(requestBody);
        } else {
          upstreamRequest.end();
        }
      };

      attemptProxy(1);
    });
  }
}
