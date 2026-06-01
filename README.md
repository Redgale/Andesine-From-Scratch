# 🌋 ANDESINE — Volcanic Proxy Network

## Comprehensive System Specification v2.0

> **Important:** Andesine is a research and educational proxy framework.
> Use it only for lawful purposes — personal privacy, network research,
> and accessing content you are authorised to access. Bypassing a service's
> Terms of Service may have civil or legal consequences. Do not use this
> system to pirate content, abuse commercial services, or circumvent
> legal restrictions in your jurisdiction.

---

## Table of Contents

1. [Architecture Overview](#architecture)
2. [File Structure](#file-structure)
3. [How Each Layer Works](#how-each-layer-works)
   - 3a. [The Injection Script (`andesine-inject.js`)](#3a-injection-script)
   - 3b. [Server-Side HTML Rewriter](#3b-server-side-html-rewriter)
   - 3c. [WebSocket Relay](#3c-websocket-relay)
   - 3d. [WebRTC TURN/STUN Gateway](#3d-webrtc-turn-gateway)
   - 3e. [Header Manipulation Pipeline](#3e-header-manipulation)
   - 3f. [Cookie Jar Sync](#3f-cookie-jar-sync)
4. [Dashboard UI](#dashboard-ui)
5. [Configuration Reference](#configuration)
6. [Quick Start](#quick-start)
7. [Production Deployment](#production-deployment)
8. [Extending Andesine](#extending)
9. [Security Model](#security-model)
10. [Known Limitations](#limitations)

---

## 1. Architecture Overview <a name="architecture"></a>

```
┌──────────────────────────────────────────────────────────┐
│                    BROWSER (CLIENT)                       │
│                                                           │
│  ┌─────────────────┐    ┌──────────────────────────────┐ │
│  │  Andesine UI    │    │   Proxied Page               │ │
│  │  (Dashboard)    │    │   (inside <iframe>)          │ │
│  │                 │    │                              │ │
│  │  • Stats HUD    │    │  andesine-inject.js active:  │ │
│  │  • URL Launcher │    │  • fetch overridden          │ │
│  │  • Session Ctrl │    │  • XHR overridden            │ │
│  └────────┬────────┘    │  • WebSocket overridden      │ │
│           │             │  • RTCPeerConnection patched  │ │
│           │             │  • window.location spoofed   │ │
│           │             │  • DOM prototypes patched    │ │
│           │             └───────────────┬──────────────┘ │
└───────────┼─────────────────────────────┼────────────────┘
            │  HTTP/WS                    │  All network traffic
            ▼                             ▼  routes through proxy
┌─────────────────────────────────────────────────────────┐
│                ANDESINE SERVER (Node.js)                 │
│                                                          │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  HTTP Router  │  │ HTML Rewriter│  │  WS Relay    │  │
│  │  /proxy       │  │ + Injector   │  │  /ws-relay   │  │
│  │  /proxy-asset │  │              │  │              │  │
│  │  /api/stats   │  │  CSS Rewriter│  │  Binary/Text │  │
│  └───────┬───────┘  │  JS Rewriter │  │  Bidirectional│ │
│          │          └──────────────┘  └──────┬───────┘  │
│          │  Header Sanitisation              │           │
│          │  Cookie Sync                      │           │
└──────────┼───────────────────────────────────┼──────────┘
           │                                   │
           ▼  HTTPS                            ▼  WSS
┌─────────────────────────────────────────────────────────┐
│                  TARGET ORIGIN                           │
│              (e.g. https://example.com)                  │
│  - Receives requests looking like direct browser visits  │
│  - Returns HTML/JS/CSS/assets/WebSocket frames           │
└─────────────────────────────────────────────────────────┘
```

The core insight is a **two-stage rewriting system**:

| Stage | What it handles | When it runs |
|-------|-----------------|--------------|
| **Server-side** | Static HTML attributes (`src`, `href`, `action`) already present in the markup at parse time | On every response from the target server |
| **Client-side (inject.js)** | Dynamic URLs set by JavaScript at runtime (`element.src = '...'`, `fetch(...)`, `new WebSocket(...)`) | Continuously, after page load |

Neither stage alone is sufficient. Static rewriting misses dynamically generated URLs; client-side-only misses server-rendered URLs loaded before JavaScript runs.

---

## 2. File Structure <a name="file-structure"></a>

```
andesine/
├── server.js                    # 🖥  Node.js proxy engine + HTTP server
├── package.json                 # Dependencies (only: ws)
├── README.md                    # This file
└── public/
    ├── index.html               # 🎨 Dashboard HTML shell
    ├── style.css                # 🎨 Glassmorphism dark UI styles
    ├── dashboard.js             # 🎨 Dashboard interactivity + charts
    └── andesine-inject.js       # 💉 Client-side API override script
```

---

## 3. How Each Layer Works <a name="how-each-layer-works"></a>

### 3a. The Injection Script <a name="3a-injection-script"></a>

`andesine-inject.js` is an IIFE injected as the **very first script tag** in every proxied HTML page's `<head>`. It runs synchronously before any of the target site's code, establishing all overrides while the DOM is still loading.

#### Priority of overrides (earliest → latest)

```
DOM parse begins
  │
  ├─ <script id="__andesine_inject__"> ← WE ARE HERE
  │    ├── 1. window.location virtualised
  │    ├── 2. document.URL / referrer / domain virtualised
  │    ├── 3. window.fetch replaced
  │    ├── 4. XMLHttpRequest replaced
  │    ├── 5. WebSocket replaced
  │    ├── 6. RTCPeerConnection replaced
  │    ├── 7. Element.prototype.setAttribute patched
  │    ├── 8. HTMLScriptElement.src patched
  │    ├── 9. HTMLImageElement.src + srcset patched
  │    ├── 10. HTMLIFrameElement.src patched
  │    ├── 11. HTMLAnchorElement.href + HTMLLinkElement.href patched
  │    ├── 12. history.pushState / replaceState patched
  │    ├── 13. document.cookie virtualised (SameSite strip)
  │    ├── 14. window.open patched
  │    ├── 15. window.postMessage patched
  │    └── 16. MutationObserver watches for dynamic node insertion
  │
  ├─ <script src="...target-app-bundle.js"> ← already overridden
  └─ DOM fully parsed
```

#### Location Virtualisation

```js
// window.location.href returns the TARGET URL:
window.location.href   // → "https://example.com/dashboard"
// Not the proxy URL:   "http://localhost:8080/proxy?url=https://example.com/dashboard"

// Object.defineProperty prevents target scripts from replacing it:
Object.defineProperty(window, 'location', {
  get: () => virtualLocation,
  configurable: false,   // cannot be reconfigured
});
```

#### WebRTC SDP Rewriting

The proxy forces `iceTransportPolicy: 'relay'` on every `RTCPeerConnection`, which means the browser will **only** use TURN relay candidates. Host and STUN-reflexive candidates (which expose the real IP) are stripped from SDP before `setLocalDescription`:

```
Original SDP candidate line:
  a=candidate:1 1 UDP 2122252543 192.168.1.100 54321 typ host

After Andesine SDP rewrite → REMOVED (typ host)
After Andesine SDP rewrite → REMOVED (typ srflx)

Retained:
  a=candidate:3 1 UDP 1677722111 198.51.100.5 49152 typ relay raddr ...
                                  ^^^^^^^^^^^
                                  TURN server IP (safe — controlled by Andesine)
```

---

### 3b. Server-Side HTML Rewriter <a name="3b-server-side-html-rewriter"></a>

The server-side `rewriteHTML()` function processes every HTML response through a pipeline of regex transforms:

```
Upstream HTML
    │
    ├── STEP 1: Inject <script>andesine-inject.js</script> after <head>
    ├── STEP 2: Rewrite <base href="...">
    ├── STEP 3: Rewrite <script src="...">
    ├── STEP 4: Rewrite <link href="...">
    ├── STEP 5: Rewrite <img src="..." srcset="...">
    ├── STEP 6: Rewrite <source src="..." srcset="...">
    ├── STEP 7: Rewrite <video>/<audio> src
    ├── STEP 8: Rewrite <iframe src>
    ├── STEP 9: Rewrite <form action>
    ├── STEP 10: Rewrite <a href>
    ├── STEP 11: Strip <meta http-equiv="Content-Security-Policy">
    └── STEP 12: Strip <meta http-equiv="X-Frame-Options">
    │
    └──→ Rewritten HTML → Client
```

CSS files are rewritten separately by `rewriteCSS()` which handles `url()` references and `@import` rules.

JavaScript files are lightly rewritten by `rewriteJS()` for static `import` statements and `import()` expressions. Dynamic runtime URLs are handled entirely by the injection script.

---

### 3c. WebSocket Relay <a name="3c-websocket-relay"></a>

```
Browser                  Andesine WS Relay            Target WS Server
  │                             │                             │
  ├─ connect /ws-relay           │                             │
  │   ?target=wss://...          │                             │
  │                             ├─ connect wss://target...    │
  │                             │◄────────────────────────────┤ open
  │◄──── open (synthetic) ──────┤                             │
  │                             │                             │
  ├─── send frame ─────────────►│─────── relay frame ────────►│
  │                             │                             │
  │◄─── receive frame ──────────┤◄────── relay frame ─────────┤
  │                             │                             │
  ├─── close ───────────────────►─────── close ──────────────►│
```

The relay is transparent — it does not inspect or modify WebSocket frame payloads, preserving binary protocol integrity (e.g. for game streaming services that use custom binary protocols over WebSocket).

---

### 3d. WebRTC TURN/STUN Gateway <a name="3d-webrtc-turn-gateway"></a>

For full WebRTC privacy, Andesine requires a TURN server (e.g. coturn) deployed separately:

```bash
# Install coturn
apt install coturn

# Minimal /etc/turnserver.conf
realm=andesine.yourdomain.com
server-name=andesine.yourdomain.com
listening-port=3478
tls-listening-port=5349
user=andesine:your_secret_password
lt-cred-mech
fingerprint
no-cli
```

Set environment variables pointing to your TURN server:
```
ANDESINE_STUN_HOST=stun.yourdomain.com
ANDESINE_TURN_HOST=turn.yourdomain.com
TURN_USER=andesine
TURN_CRED=your_secret_password
```

---

### 3e. Header Manipulation Pipeline <a name="3e-header-manipulation"></a>

#### Request headers stripped before forwarding upstream:

| Header | Why stripped |
|--------|-------------|
| `Origin` | Reveals proxy host |
| `Referer` | Reveals proxy path |
| `Sec-Fetch-Dest` | Browser fetch metadata — exposes proxy context |
| `Sec-Fetch-Mode` | As above |
| `Sec-Fetch-Site` | Identifies cross-origin fetch |
| `Sec-CH-UA-*` | User-agent hints |
| `CF-Connecting-IP` | Cloudflare real-IP header |
| `X-Forwarded-For` | IP chain header |

**Replaced with:**
- `Host: <target-hostname>`
- `Origin: <target-origin>`
- `Referer: <target-origin>/`

#### Response headers stripped / replaced:

| Header | Action |
|--------|--------|
| `Content-Security-Policy` | **Stripped** — CSP would block injected script and proxied assets |
| `X-Frame-Options` | **Stripped** — Allows framing in proxy overlay |
| `Strict-Transport-Security` | **Stripped** — HSTS pinning for target domain would break proxy |
| `Cross-Origin-Embedder-Policy` | **Stripped** |
| `Cross-Origin-Opener-Policy` | **Stripped** |
| `Cross-Origin-Resource-Policy` | **Stripped** |
| `Location` (redirects) | **Rewritten** through proxy |
| `Set-Cookie` | **Rewritten** — Domain stripped, SameSite=None; Secure added |
| `Access-Control-Allow-Origin` | **Replaced** with `*` |

---

### 3f. Cookie Jar Sync <a name="3f-cookie-jar-sync"></a>

Cookies present a challenge: the browser stores cookies by domain, but the proxy serves all content from a single domain (`localhost:8080` or your proxy domain). Andesine handles this two ways:

1. **Server-side:** `Set-Cookie` response headers are stripped of `Domain=`, and `SameSite=None; Secure` is added so the browser stores them against the proxy origin.

2. **Client-side:** `document.cookie` setter is virtualised in the injection script to strip `SameSite=Lax/Strict` and `Secure` restrictions that would prevent cookies from being set cross-origin.

This is sufficient for the majority of session-cookie-based authentication flows.

---

## 4. Dashboard UI <a name="dashboard-ui"></a>

The Andesine dashboard is a single-page app (no framework dependencies) featuring:

### Visual Design
- **Theme:** Volcanic dark glass — obsidian backgrounds, molten orange/magma-pink gradients, ice-blue accents
- **Typography:** Syne (display/headings, weight 800) + JetBrains Mono (monospace/stats)
- **Glassmorphism:** `backdrop-filter: blur(18px)` cards with `rgba` backgrounds and subtle orange-tinted borders
- **Animated background:** Particle system (canvas), floating orb glows, CSS grid overlay

### Real-Time Analytics
- **4 Stat Cards:** Latency (ms), Throughput (Mb/s), Stability (%), Active Sessions
- **Sparkline graphs** rendered on `<canvas>` for each stat (30-point rolling window)
- **Main network chart:** Dual TX/RX line chart with Bezier smoothing, 80-point rolling window
- **Server metrics** streamed via SSE from `/api/stats`

### URL Launchpad
- Prominent headline with animated gradient text
- Fuzzy-match autocomplete against a built-in suggestion list
- `LAUNCH` button triggers a **ring-expansion transition animation** before loading the proxied page

### Proxy Session HUD
- Slim bar, hidden offscreen, **slides down on hover** over the proxy overlay
- Displays live ping/bandwidth
- Full-screen toggle button
- Home/close button

---

## 5. Configuration Reference <a name="configuration"></a>

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `8080` | HTTP server port |
| `HOST` | `0.0.0.0` | Bind address |
| `ANDESINE_ORIGIN` | `http://localhost:8080` | Public URL of this server |
| `ANDESINE_WS_RELAY` | `ws://localhost:8080/ws-relay` | WS relay URL (use wss:// in prod) |
| `ANDESINE_STUN` | `stun.andesine.local` | STUN server hostname |
| `ANDESINE_TURN` | `turn.andesine.local` | TURN server hostname |
| `TURN_USER` | `andesine` | TURN username |
| `TURN_CRED` | `andesine_secret` | TURN credential |
| `BLOCKED_HOSTS` | `` | Comma-separated hostnames to block |

---

## 6. Quick Start <a name="quick-start"></a>

```bash
# 1. Install the single dependency
npm install

# 2. Start the server
npm start

# 3. Open the dashboard
open http://localhost:8080
```

For development with auto-restart (Node 18+):
```bash
npm run dev
```

---

## 7. Production Deployment <a name="production-deployment"></a>

### Nginx reverse proxy + TLS

```nginx
server {
    listen 443 ssl;
    server_name andesine.yourdomain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_buffering    off;
        proxy_read_timeout 3600s;
    }
}
```

Set `ANDESINE_ORIGIN=https://andesine.yourdomain.com` and `ANDESINE_WS_RELAY=wss://andesine.yourdomain.com/ws-relay`.

### Process manager

```bash
npm i -g pm2
pm2 start server.js --name andesine
pm2 save && pm2 startup
```

---

## 8. Extending Andesine <a name="extending"></a>

### Adding new rewrite rules

Add new regex transforms to `rewriteHTML()` in `server.js`. The function is intentionally imperative and sequential — easy to extend.

### Custom injection hooks

Export hooks from the injection IIFE via `window.__andesine__`:

```js
// In your own script injected after andesine-inject.js:
const { rewriteUrl, virtualLocation } = window.__andesine__;
console.log('Virtual origin:', virtualLocation.origin);
```

### Session persistence

The current implementation uses in-memory session metrics. For persistent multi-user deployments, replace `const sessions = new Map()` with a Redis or SQLite backend.

### Streaming HTML rewriting (scale)

The current regex pipeline buffers up to 8MB before rewriting. For very large pages or lower latency, replace with a streaming HTML parser (e.g. `htmlparser2` transform stream) that rewrites attributes as they are parsed.

---

## 9. Security Model <a name="security-model"></a>

Andesine intentionally removes several browser security boundaries:

| Boundary removed | Reason | Risk |
|-----------------|--------|------|
| CSP headers | Allow injected script + proxied assets | Target site's XSS protections are also removed |
| CORS | Allow cross-origin asset loading | Proxied pages can make cross-origin requests |
| Cookie domain isolation | Maintain sessions | Cookies for different target sites share the proxy origin's cookie jar |
| WebRTC IP isolation | Route through TURN | Requires trust in the TURN server operator |

**Mitigations you should add for multi-user deployments:**

1. **Session isolation:** Use unique session tokens to namespace cookie jars per user session
2. **Rate limiting:** Limit requests per IP to prevent abuse
3. **URL allowlist/blocklist:** Only permit proxying of an approved list of domains
4. **Authentication:** Protect the dashboard with login to prevent unauthorised use
5. **Audit logging:** Log all proxied domains for accountability

---

## 10. Known Limitations <a name="limitations"></a>

| Limitation | Notes |
|-----------|-------|
| **Service Workers** | Intentionally not used. Sites relying *entirely* on a SW (offline-first PWAs) may not work fully |
| **Canvas fingerprinting** | Not spoofed — sites can still fingerprint via `<canvas>` |
| **WebAssembly modules** | WASM is proxied as raw bytes — works for most cases |
| **HTTP/2 push** | Upstream HTTP/2 push not forwarded (Node's `http` module is HTTP/1.1 to upstream) |
| **Large binary streams** | Bodies >8MB are streamed without rewriting — dynamic URL injection handles runtime URLs |
| **Encrypted media (EME)** | DRM-protected streams (Widevine/PlayReady) cannot be proxied |
| **Certificate pinning** | Apps using cert pinning (native apps, certain browsers) will reject the proxy |
| **IP reputation** | Proxy server IP may be flagged by anti-bot systems (use residential proxies upstream to mitigate) |
