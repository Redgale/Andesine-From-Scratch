/**
 * ╔══════════════════════════════════════════════════════╗
 * ║   ANDESINE SERVER  v2.0  —  server.js               ║
 * ║   Full-stack low-latency web proxy engine            ║
 * ║   Stack: native Node.js http/https + ws module       ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * Architecture:
 *   Browser → Andesine HTTP/WS Server → Target Origin
 *
 * Routes:
 *   GET  /                 → Dashboard UI
 *   GET  /proxy?url=<url>  → HTML proxy (rewrites + injects)
 *   GET  /proxy-asset?url= → Raw asset proxy (JS/CSS/media)
 *   WS   /ws-relay?target= → WebSocket relay
 *   GET  /api/stats        → Server-side metrics (SSE)
 */

'use strict';

const http         = require('http');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const { URL }      = require('url');
const { EventEmitter } = require('events');
const WebSocket    = require('ws');          // npm i ws — only external dep

/* ─────────────────────────────────────────────────
 * CONFIG
 * ───────────────────────────────────────────────── */
const CONFIG = {
  PORT:          process.env.PORT             || 8000,
  HOST:          process.env.HOST             || '0.0.0.0',
  ORIGIN:        process.env.ANDESINE_ORIGIN  || 'https://andesine.koyeb.app',
  WS_RELAY_BASE: process.env.ANDESINE_WS_RELAY || 'wss://andesine.koyeb.app/ws-relay',
  /** Max body size for rewriting (larger assets are streamed raw) */
  REWRITE_LIMIT: 8 * 1024 * 1024,   // 8 MB
  /** Comma-separated list of blocked target domains */
  BLOCKED_HOSTS: (process.env.BLOCKED_HOSTS || '').split(',').filter(Boolean),
};

const PUBLIC_DIR   = path.join(__dirname, 'public');
const INJECT_PATH  = path.join(PUBLIC_DIR, 'andesine-inject.js');


/* ─────────────────────────────────────────────────
 * INJECTION SCRIPT — loaded once, template-filled per request
 * ───────────────────────────────────────────────── */
let _injectTemplate = null;
function getInjectScript(targetOrigin) {
  if (!_injectTemplate) {
    _injectTemplate = fs.readFileSync(INJECT_PATH, 'utf8');
  }
  // Normalise relay base to always use wss://
  const wsRelay = CONFIG.WS_RELAY_BASE
    .replace(/^ws:\/\//,    'wss://')
    .replace(/^http:\/\//,  'wss://')
    .replace(/^https:\/\//, 'wss://');

  return _injectTemplate
    .replace(/\{\{ANDESINE_ORIGIN\}\}/g,   CONFIG.ORIGIN)
    .replace(/\{\{TARGET_ORIGIN\}\}/g,     targetOrigin)
    .replace(/\{\{ANDESINE_WS_RELAY\}\}/g, wsRelay);
}


/* ─────────────────────────────────────────────────
 * MIME TYPE HELPERS
 * ───────────────────────────────────────────────── */
const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
};

function getMimeByPath(filePath) {
  return MIME_MAP[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function isRewritable(contentType) {
  return /text\/(html|css)|application\/(javascript|json|x-javascript)/.test(contentType || '');
}

function isHtml(contentType) {
  return /text\/html/.test(contentType || '');
}

function isJs(contentType) {
  return /javascript/.test(contentType || '');
}

function isCss(contentType) {
  return /text\/css/.test(contentType || '');
}


/* ─────────────────────────────────────────────────
 * URL REWRITING UTILITIES (server-side mirror of inject.js)
 * ───────────────────────────────────────────────── */
function absoluteUrl(relative, base) {
  try { return new URL(relative, base).href; }
  catch { return null; }
}

/**
 * Rewrite a URL to route through the proxy.
 * @param {string} url     - Original resource URL
 * @param {string} baseUrl - Base URL of the current page/document
 */
function proxyUrl(url, baseUrl) {
  if (!url) return url;
  url = url.trim();

  if (/^(data:|blob:|javascript:|#|mailto:|tel:)/.test(url)) return url;
  // Already proxied
  if (url.startsWith(CONFIG.ORIGIN + '/proxy')) return url;

  const abs = absoluteUrl(url, baseUrl);
  if (!abs) return url;

  return `${CONFIG.ORIGIN}/proxy-asset?url=${encodeURIComponent(abs)}`;
}

/**
 * Rewrite `srcset` attribute values.
 */
function rewriteSrcset(srcset, baseUrl) {
  if (!srcset) return srcset;
  return srcset.split(',').map(part => {
    const trimmed = part.trim();
    const match   = trimmed.match(/^(\S+)(\s+.*)?$/);
    if (!match) return part;
    return `${proxyUrl(match[1], baseUrl)}${match[2] || ''}`;
  }).join(', ');
}


/* ─────────────────────────────────────────────────
 * HTML REWRITER
 * A high-performance regex-based streaming rewriter.
 * For production, upgrade to an html-rewriter stream parser.
 * ───────────────────────────────────────────────── */
function rewriteHTML(html, pageUrl) {
  const targetOrigin = (() => { try { const u = new URL(pageUrl); return u.origin; } catch { return ''; } })();
  const inject       = getInjectScript(targetOrigin);

  // 1. Inject our script as first child of <head> (or before first <script>)
  const injectTag = `<script id="__andesine_inject__">\n${inject}\n</script>`;

  // Inject after <head> tag, or before first <script> if no <head>
  if (/<head[\s>]/i.test(html)) {
    html = html.replace(/(<head[^>]*>)/i, `$1\n${injectTag}`);
  } else if (/<html[\s>]/i.test(html)) {
    html = html.replace(/(<html[^>]*>)/i, `$1\n<head>${injectTag}</head>`);
  } else {
    html = injectTag + '\n' + html;
  }

  // 2. Rewrite <base href>
  html = html.replace(/<base\s[^>]*href=["']([^"']+)["'][^>]*>/gi, (match, href) => {
    return match.replace(href, proxyUrl(href, pageUrl));
  });

  // 3. Rewrite <script src>
  html = html.replace(/<script\s([^>]*?)src=["']([^"']+)["']([^>]*?)>/gi, (match, pre, src, post) => {
    return `<script ${pre}src="${proxyUrl(src, pageUrl)}"${post}>`;
  });

  // 4. Rewrite <link href> (stylesheets, preloads, etc.)
  html = html.replace(/<link\s([^>]*?)href=["']([^"']+)["']([^>]*?)>/gi, (match, pre, href, post) => {
    return `<link ${pre}href="${proxyUrl(href, pageUrl)}"${post}>`;
  });

  // 5. Rewrite <img src / srcset>
  html = html.replace(/<img\s([^>]*?)>/gi, (match, attrs) => {
    attrs = attrs
      .replace(/src=["']([^"']+)["']/gi, (m, src) => `src="${proxyUrl(src, pageUrl)}"`)
      .replace(/srcset=["']([^"']+)["']/gi, (m, ss) => `srcset="${rewriteSrcset(ss, pageUrl)}"`);
    return `<img ${attrs}>`;
  });

  // 6. Rewrite <source src / srcset>
  html = html.replace(/<source\s([^>]*?)>/gi, (match, attrs) => {
    attrs = attrs
      .replace(/src=["']([^"']+)["']/gi, (m, src) => `src="${proxyUrl(src, pageUrl)}"`)
      .replace(/srcset=["']([^"']+)["']/gi, (m, ss) => `srcset="${rewriteSrcset(ss, pageUrl)}"`);
    return `<source ${attrs}>`;
  });

  // 7. Rewrite <video> / <audio> src
  html = html.replace(/<(video|audio)\s([^>]*?)>/gi, (match, tag, attrs) => {
    attrs = attrs.replace(/src=["']([^"']+)["']/gi, (m, src) => `src="${proxyUrl(src, pageUrl)}"`);
    return `<${tag} ${attrs}>`;
  });

  // 8. Rewrite <iframe src>
  html = html.replace(/<iframe\s([^>]*?)src=["']([^"']+)["']([^>]*?)>/gi, (match, pre, src, post) => {
    return `<iframe ${pre}src="${proxyUrl(src, pageUrl)}"${post}>`;
  });

  // 9. Rewrite <form action>
  html = html.replace(/<form\s([^>]*?)action=["']([^"']+)["']([^>]*?)>/gi, (match, pre, action, post) => {
    return `<form ${pre}action="${proxyUrl(action, pageUrl)}"${post}>`;
  });

  // 10. Rewrite <a href> (for initial page links; the inject script handles dynamic ones)
  html = html.replace(/<a\s([^>]*?)href=["']([^"']+)["']([^>]*?)>/gi, (match, pre, href, post) => {
    if (/^(#|mailto:|tel:|javascript:)/.test(href)) return match;
    return `<a ${pre}href="${proxyUrl(href, pageUrl)}"${post}>`;
  });

  // 11. Strip Content-Security-Policy meta tags (CSP is handled at header level)
  html = html.replace(/<meta\s[^>]*?http-equiv=["']Content-Security-Policy["'][^>]*?>/gi, '');

  // 12. Strip X-Frame-Options meta (allow framing inside our overlay)
  html = html.replace(/<meta\s[^>]*?http-equiv=["']X-Frame-Options["'][^>]*?>/gi, '');

  return html;
}


/* ─────────────────────────────────────────────────
 * CSS REWRITER
 * Rewrites url() references in CSS files.
 * ───────────────────────────────────────────────── */
function rewriteCSS(css, baseUrl) {
  // url("...") / url('...') / url(...)
  return css.replace(/url\((['"]?)([^)'"]+)\1\)/gi, (match, quote, url) => {
    if (/^(data:|#)/.test(url)) return match;
    return `url(${quote}${proxyUrl(url, baseUrl)}${quote})`;
  }).replace(/@import\s+['"]([^'"]+)['"]/gi, (match, url) => {
    return `@import '${proxyUrl(url, baseUrl)}'`;
  });
}


/* ─────────────────────────────────────────────────
 * JS REWRITER (lightweight — bulk handled by inject.js)
 * Only rewrites static import statements and known fetch calls.
 * ───────────────────────────────────────────────── */
function rewriteJS(js, baseUrl) {
  // Static ES module imports: import x from '...'
  js = js.replace(/\bfrom\s+(['"])([^'"]+)\1/g, (match, q, url) => {
    if (url.startsWith('.') || url.startsWith('/')) {
      return `from ${q}${proxyUrl(url, baseUrl)}${q}`;
    }
    return match;
  });
  // import('...')  / import("...")
  js = js.replace(/\bimport\((['"])([^'"]+)\1\)/g, (match, q, url) => {
    return `import(${q}${proxyUrl(url, baseUrl)}${q})`;
  });
  return js;
}


/* ─────────────────────────────────────────────────
 * REQUEST HEADER SANITISER
 * Strips browser-leak headers before forwarding
 * the request to the target server.
 * ───────────────────────────────────────────────── */
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'cf-connecting-ip',
  'x-forwarded-for',
  'x-real-ip',
  'via',
]);

function buildForwardHeaders(incomingHeaders, targetUrl) {
  const headers = Object.assign({}, incomingHeaders);

  // Strip proxy-identifying headers
  STRIP_REQUEST_HEADERS.forEach(h => delete headers[h]);

  const target = new URL(targetUrl);
  headers['host']    = target.host;
  headers['origin']  = target.origin;
  headers['referer'] = target.origin + '/';

  // Remove cookie jar forwarding of proxy-host cookies
  // (server handles cookie sync separately)
  if (headers['cookie']) {
    headers['cookie'] = sanitiseCookieHeader(headers['cookie']);
  }

  return headers;
}

function sanitiseCookieHeader(cookieStr) {
  // Remove __andesine_* internal cookies from forwarded header
  return cookieStr.split(';')
    .filter(c => !c.trim().startsWith('__andesine_'))
    .join(';');
}


/* ─────────────────────────────────────────────────
 * RESPONSE HEADER SANITISER
 * Strips/rewrites response headers to allow the
 * browser to render the proxied content without
 * security blocking.
 * ───────────────────────────────────────────────── */
const STRIP_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'x-xss-protection',
  'strict-transport-security',   // Let browser handle our origin's HSTS
  'public-key-pins',
  'expect-ct',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'report-to',
  'nel',
]);

function buildResponseHeaders(upstreamHeaders, proxyOrigin) {
  const out = {};

  for (const [k, v] of Object.entries(upstreamHeaders)) {
    const lower = k.toLowerCase();
    if (STRIP_RESPONSE_HEADERS.has(lower)) continue;

    if (lower === 'location') {
      // Rewrite redirect Location header
      out['location'] = proxyUrl(v, proxyOrigin);
      continue;
    }

    if (lower === 'set-cookie') {
      // Rewrite cookies — remove Domain/SameSite restrictions
      const cookies = Array.isArray(v) ? v : [v];
      out['set-cookie'] = cookies.map(c => rewriteSetCookie(c));
      continue;
    }

    if (lower === 'access-control-allow-origin') {
      out['access-control-allow-origin'] = '*';
      continue;
    }

    out[k] = v;
  }

  // Permissive CORS for all assets
  out['access-control-allow-origin']      = '*';
  out['access-control-allow-methods']     = 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD';
  out['access-control-allow-headers']     = '*';
  out['access-control-allow-credentials'] = 'true';

  return out;
}

function rewriteSetCookie(cookieStr) {
  return cookieStr
    .replace(/;\s*Domain=[^;]*/gi, '')
    .replace(/;\s*SameSite=(Lax|Strict)/gi, '; SameSite=None')
    .replace(/;\s*Secure\b/gi, '')
    + '; Secure; SameSite=None';
}


/* ─────────────────────────────────────────────────
 * FETCH UPSTREAM  (native Node.js http/https)
 * Returns a Promise<{statusCode, headers, body: Buffer}>
 * for small bodies, or streams directly for large ones.
 * ───────────────────────────────────────────────── */
function fetchUpstream(method, targetUrl, headers, body, followCount = 0) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const options = {
      method,
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      headers,
      timeout:  15000,
      rejectUnauthorized: false,   // Proxy tolerates self-signed upstream certs
    };

    const req = lib.request(options, (res) => {
      // Handle redirects (max 8)
      const loc = res.headers['location'];
      if ([301,302,303,307,308].includes(res.statusCode) && loc && followCount < 8) {
        const next = absoluteUrl(loc, targetUrl);
        if (next) {
          res.resume();
          return resolve(fetchUpstream(method === 'POST' && res.statusCode === 303 ? 'GET' : method, next, headers, body, followCount + 1));
        }
      }

      // Collect body if small enough to rewrite
      const chunks = [];
      let totalLen  = 0;
      let tooLarge  = false;

      res.on('data', chunk => {
        if (!tooLarge) {
          totalLen += chunk.length;
          if (totalLen > CONFIG.REWRITE_LIMIT) {
            tooLarge = true;
          } else {
            chunks.push(chunk);
          }
        }
      });

      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers:    res.headers,
          body:       tooLarge ? null : Buffer.concat(chunks),
          stream:     res,          // raw stream for large bodies
          tooLarge,
        });
      });

      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Upstream timeout')); });

    if (body) req.write(body);
    req.end();
  });
}


/* ─────────────────────────────────────────────────
 * SERVE STATIC FILE
 * ───────────────────────────────────────────────── */
function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type':   getMimeByPath(filePath),
      'Cache-Control':  'public, max-age=3600',
    });
    res.end(data);
  });
}


/* ─────────────────────────────────────────────────
 * SESSIONS STORE  (in-memory, keyed by session token)
 * ───────────────────────────────────────────────── */
const sessions      = new Map();
const sessionMetrics = {
  totalRequests:   0,
  bytesSent:       0,
  bytesReceived:   0,
  activeSessions:  0,
  avgLatency:      0,
  latencySamples:  [],
};

function recordLatency(ms) {
  sessionMetrics.latencySamples.push(ms);
  if (sessionMetrics.latencySamples.length > 100) sessionMetrics.latencySamples.shift();
  const sum = sessionMetrics.latencySamples.reduce((a, b) => a + b, 0);
  sessionMetrics.avgLatency = Math.round(sum / sessionMetrics.latencySamples.length);
}


/* ─────────────────────────────────────────────────
 * PROXY HANDLER  (HTTP)
 * ───────────────────────────────────────────────── */
async function handleProxy(req, res, isAsset = false) {
  const rawUrl = new URL(req.url, `http://${req.headers.host}`);
  const targetUrl = rawUrl.searchParams.get('url');

  if (!targetUrl) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing ?url= parameter');
    return;
  }

  let parsedTarget;
  try { parsedTarget = new URL(targetUrl); }
  catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid URL');
    return;
  }

  // Block forbidden hosts
  if (CONFIG.BLOCKED_HOSTS.some(h => parsedTarget.hostname.includes(h))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  const tStart = Date.now();
  sessionMetrics.totalRequests++;

  // Build request body for POST/PUT/PATCH
  let body = null;
  if (['POST','PUT','PATCH'].includes(req.method)) {
    body = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end',  () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  const fwdHeaders = buildForwardHeaders(req.headers, targetUrl);

  let upstream;
  try {
    upstream = await fetchUpstream(req.method, targetUrl, fwdHeaders, body);
  } catch (e) {
    console.error('[Andesine] Upstream error:', e.message);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Upstream connection failed: ${e.message}`);
    return;
  }

  recordLatency(Date.now() - tStart);

  const respHeaders = buildResponseHeaders(upstream.headers, CONFIG.ORIGIN);
  const contentType = (upstream.headers['content-type'] || '').toLowerCase();

  // Handle large or non-rewritable assets: stream directly
  if (upstream.tooLarge || !isRewritable(contentType)) {
    // Remove encoding so we can stream without decompressing
    delete respHeaders['content-encoding'];
    res.writeHead(upstream.statusCode, respHeaders);
    if (upstream.tooLarge && upstream.stream) {
      upstream.stream.pipe(res);
    } else if (upstream.body) {
      res.end(upstream.body);
      sessionMetrics.bytesSent += upstream.body.length;
    }
    return;
  }

  // Decompress if needed
  let bodyStr;
  const encoding = upstream.headers['content-encoding'];
  try {
    if (encoding === 'gzip' || encoding === 'deflate' || encoding === 'br') {
      const zlib = require('zlib');
      const decompress = encoding === 'br'
        ? zlib.brotliDecompressSync
        : encoding === 'gzip'
          ? zlib.gunzipSync
          : zlib.inflateSync;
      bodyStr = decompress(upstream.body).toString('utf8');
    } else {
      bodyStr = upstream.body.toString('utf8');
    }
  } catch {
    bodyStr = upstream.body.toString('utf8');
  }

  delete respHeaders['content-encoding'];   // body no longer compressed
  delete respHeaders['content-length'];      // length will change after rewriting

  // Rewrite based on content type
  let rewritten;
  if (isHtml(contentType)) {
    rewritten = rewriteHTML(bodyStr, targetUrl);
  } else if (isCss(contentType)) {
    rewritten = rewriteCSS(bodyStr, targetUrl);
  } else if (isJs(contentType)) {
    rewritten = rewriteJS(bodyStr, targetUrl);
  } else {
    // JSON or other — return as-is
    rewritten = bodyStr;
  }

  const outBuf = Buffer.from(rewritten, 'utf8');
  respHeaders['content-length'] = String(outBuf.length);

  res.writeHead(upstream.statusCode, respHeaders);
  res.end(outBuf);
  sessionMetrics.bytesSent += outBuf.length;
}


/* ─────────────────────────────────────────────────
 * SERVER-SENT EVENTS — /api/stats
 * Pushes real-time metrics to the dashboard.
 * ───────────────────────────────────────────────── */
const sseClients = new Set();

function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('data: connected\n\n');

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

setInterval(() => {
  if (!sseClients.size) return;
  const payload = JSON.stringify({
    latency:  sessionMetrics.avgLatency,
    bytesSent: sessionMetrics.bytesSent,
    bytesReceived: sessionMetrics.bytesReceived,
    sessions: sessionMetrics.activeSessions,
    requests: sessionMetrics.totalRequests,
    ts:       Date.now(),
  });
  sseClients.forEach(res => res.write(`data: ${payload}\n\n`));
}, 1000);


/* ─────────────────────────────────────────────────
 * HTTP REQUEST ROUTER
 * ───────────────────────────────────────────────── */
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Universal CORS — every route is cross-origin fetchable from any page.
  // Set via setHeader() so these are inherited by every writeHead() call below.
  res.setHeader('Access-Control-Allow-Origin',   '*');
  res.setHeader('Access-Control-Allow-Methods',  'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers',  '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
  res.setHeader('Access-Control-Max-Age',        '86400');

  // Preflight — headers already set above, just close the request
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end(); return;
  }

  // Dashboard entry
  if (pathname === '/' || pathname === '/index.html') {
    serveStatic(res, path.join(PUBLIC_DIR, 'index.html')); return;
  }

  // Static public assets
  if (/^\/(style\.css|dashboard\.js|andesine-inject\.js|favicon\.ico)$/.test(pathname)) {
    serveStatic(res, path.join(PUBLIC_DIR, pathname.slice(1))); return;
  }

  // SSE metrics
  if (pathname === '/api/stats') {
    handleSSE(req, res); return;
  }

  // HTML proxy
  if (pathname === '/proxy') {
    await handleProxy(req, res, false); return;
  }

  // Asset proxy
  if (pathname === '/proxy-asset') {
    await handleProxy(req, res, true); return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Andesine: Not Found');
});


/* ─────────────────────────────────────────────────
 * WEBSOCKET RELAY
 * Bridges browser WS ↔ target WS.
 * Handles both /ws-relay (proxied) and passthrough.
 * ───────────────────────────────────────────────── */
const wss = new WebSocket.Server({ server: httpServer, path: '/ws-relay' });

wss.on('connection', (clientWs, req) => {
  const reqUrl    = new URL(req.url, `ws://${req.headers.host}`);
  const target    = reqUrl.searchParams.get('target');
  const origin    = reqUrl.searchParams.get('origin') || '';

  if (!target) {
    clientWs.close(1008, 'Missing ?target=');
    return;
  }

  sessionMetrics.activeSessions++;
  let targetWs;

  try {
    targetWs = new WebSocket(target, {
      headers: {
        'origin': origin,
        'user-agent': req.headers['user-agent'] || 'Mozilla/5.0',
      },
      rejectUnauthorized: false,
    });
  } catch (e) {
    clientWs.close(1011, 'Target WS error');
    sessionMetrics.activeSessions = Math.max(0, sessionMetrics.activeSessions - 1);
    return;
  }

  // Browser → Target
  clientWs.on('message', (data, isBinary) => {
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(data, { binary: isBinary });
      sessionMetrics.bytesSent += Buffer.byteLength(data);
    }
  });

  // Target → Browser
  targetWs.on('message', (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
      sessionMetrics.bytesReceived += Buffer.byteLength(data);
    }
  });

  // Close / Error propagation
  clientWs.on('close', (code, reason) => {
    if (targetWs.readyState === WebSocket.OPEN) targetWs.close(code, reason);
    sessionMetrics.activeSessions = Math.max(0, sessionMetrics.activeSessions - 1);
  });

  targetWs.on('close', (code, reason) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(code, reason);
    sessionMetrics.activeSessions = Math.max(0, sessionMetrics.activeSessions - 1);
  });

  clientWs.on('error', (e) => { console.error('[Andesine WS] Client error:', e.message); });
  targetWs.on('error', (e) => {
    console.error('[Andesine WS] Target error:', e.message);
    clientWs.close(1011, 'Target WS error');
    sessionMetrics.activeSessions = Math.max(0, sessionMetrics.activeSessions - 1);
  });

  targetWs.on('open', () => {
    clientWs.send(JSON.stringify({ type: '__andesine_ws_open__', target }));
  });
});


/* ─────────────────────────────────────────────────
 * STARTUP
 * ───────────────────────────────────────────────── */
httpServer.listen(CONFIG.PORT, CONFIG.HOST, () => {
  const art = `
  ╔═══════════════════════════════════════╗
  ║   🌋  ANDESINE PROXY NETWORK  v2.0    ║
  ║       Volcanic. Fast. Relentless.     ║
  ╠═══════════════════════════════════════╣
  ║   Dashboard  → http://localhost:${CONFIG.PORT} ║
  ║   Proxy API  → /proxy?url=<url>       ║
  ║   Assets     → /proxy-asset?url=<url> ║
  ║   WS Relay   → /ws-relay?target=<ws>  ║
  ║   Metrics    → /api/stats (SSE)       ║
  ╚═══════════════════════════════════════╝
`;
  console.log(art);
});

httpServer.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[Andesine] Port ${CONFIG.PORT} already in use.`);
    process.exit(1);
  }
  throw e;
});

module.exports = { httpServer, wss, sessionMetrics };
