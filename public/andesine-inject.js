/**
 * ╔═══════════════════════════════════════════════════════╗
 * ║   ANDESINE INJECTION SCRIPT  v2.0                     ║
 * ║   Injected as the FIRST script in every proxied page  ║
 * ║   Overrides network/DOM APIs to keep all traffic      ║
 * ║   flowing through the Andesine proxy backend.         ║
 * ╚═══════════════════════════════════════════════════════╝
 *
 * Execution order matters: this IIFE runs before any other
 * script on the page. Object.freeze() protects overrides from
 * being reversed by the target site's own JS.
 */

(function AndesineInjection(globalScope) {
  'use strict';

  /* ─────────────────────────────────────────────
   * 0. CONFIGURATION  (server fills these in via
   *    template substitution before injection)
   * ───────────────────────────────────────────── */
  const CONFIG = {
    /** The Andesine server's public origin. */
    proxyOrigin:     '{{ANDESINE_ORIGIN}}',
    /** The real origin being proxied (e.g. https://nvidia.com) */
    targetOrigin:    '{{TARGET_ORIGIN}}',
    /** WebSocket relay endpoint on the Andesine server */
    wsRelayBase:     '{{ANDESINE_WS_RELAY}}',   // e.g. wss://andesine.example.com/ws-relay
    /** TURN/STUN configuration for WebRTC relay */
    iceServers: [
      { urls: 'stun:{{ANDESINE_STUN_HOST}}:3478' },
      {
        urls:       'turn:{{ANDESINE_TURN_HOST}}:3478',
        username:   '{{TURN_USERNAME}}',
        credential: '{{TURN_CREDENTIAL}}',
      },
    ],
    /** Prefix appended to every proxied resource path */
    resourcePrefix:  '/proxy-asset?url=',
  };

  /* ─────────────────────────────────────────────
   * 1. URL REWRITING UTILITIES
   * ───────────────────────────────────────────── */

  /**
   * Rewrites an absolute or relative URL so it routes
   * through the Andesine backend proxy.
   */
  function rewriteUrl(url) {
    if (!url || typeof url !== 'string') return url;
    url = url.trim();

    // Skip data URIs, blob URIs, and already-proxied paths
    if (/^(data:|blob:|javascript:|#|mailto:|tel:)/.test(url)) return url;
    if (url.startsWith(CONFIG.proxyOrigin)) return url;
    if (url.startsWith('/proxy')) return url;

    // Resolve relative URLs against the target origin
    if (url.startsWith('//')) {
      url = 'https:' + url;
    } else if (url.startsWith('/')) {
      url = CONFIG.targetOrigin + url;
    } else if (!url.startsWith('http')) {
      // Relative path — derive from current virtual location
      const base = VirtualLocation.href.replace(/[?#].*$/, '').replace(/\/[^/]*$/, '/');
      url = base + url;
    }

    return CONFIG.proxyOrigin + CONFIG.resourcePrefix + encodeURIComponent(url);
  }

  /** Unrewrite: extract the original URL from a proxied path */
  function unwrapUrl(proxied) {
    const prefix = CONFIG.proxyOrigin + CONFIG.resourcePrefix;
    if (proxied && proxied.startsWith(prefix)) {
      return decodeURIComponent(proxied.slice(prefix.length));
    }
    return proxied;
  }

  /* ─────────────────────────────────────────────
   * 2. LOCATION VIRTUALISATION
   *    Object.defineProperty with a non-configurable
   *    descriptor — makes window.location read-only
   *    and returns the TARGET origin values.
   * ───────────────────────────────────────────── */
  const VirtualLocation = (function buildVirtualLocation() {
    const realHref   = globalScope.location.href;
    const proxyParam = new URLSearchParams(globalScope.location.search).get('url');
    const targetHref = proxyParam ? decodeURIComponent(proxyParam) : CONFIG.targetOrigin + '/';

    let _href = targetHref;

    const parsed = () => {
      try { return new URL(_href); }
      catch { return new URL(CONFIG.targetOrigin + '/'); }
    };

    const vLoc = {
      get href()     { return _href; },
      get origin()   { return parsed().origin; },
      get protocol() { return parsed().protocol; },
      get host()     { return parsed().host; },
      get hostname() { return parsed().hostname; },
      get port()     { return parsed().port; },
      get pathname() { return parsed().pathname; },
      get search()   { return parsed().search; },
      get hash()     { return parsed().hash; },
      set href(v)    { _href = v; globalScope.location.href = rewriteUrl(v); },
      assign(url)    { globalScope.location.assign(rewriteUrl(url)); },
      replace(url)   { globalScope.location.replace(rewriteUrl(url)); },
      reload()       { globalScope.location.reload(); },
      toString()     { return _href; },
      valueOf()      { return _href; },
    };

    // Prevent target scripts from overwriting window.location
    try {
      Object.defineProperty(globalScope, 'location', {
        get: () => vLoc,
        set: (v) => { vLoc.href = v; },
        configurable: false,
        enumerable: true,
      });
    } catch (e) {
      // Some browsers protect window.location; log silently
      console.debug('[Andesine] location override partial:', e.message);
    }

    return vLoc;
  })();

  /* Also virtualise document.URL / document.referrer */
  try {
    Object.defineProperty(document, 'URL', {
      get: () => VirtualLocation.href, configurable: true,
    });
    Object.defineProperty(document, 'domain', {
      get: () => VirtualLocation.hostname,
      set: () => {},
      configurable: true,
    });
    Object.defineProperty(document, 'referrer', {
      get: () => CONFIG.targetOrigin + '/',
      configurable: true,
    });
  } catch (e) {}


  /* ─────────────────────────────────────────────
   * 3. FETCH OVERRIDE
   *    Intercepts window.fetch and rewrites the
   *    target URL before forwarding.
   * ───────────────────────────────────────────── */
  const _NativeFetch = globalScope.fetch.bind(globalScope);

  globalScope.fetch = function andesineFetch(input, init = {}) {
    // Normalise request input
    let url;
    let options = Object.assign({}, init);

    if (input instanceof Request) {
      url = input.url;
      options = {
        method:      input.method,
        headers:     Object.fromEntries(input.headers),
        body:        input.body,
        mode:        'cors',
        credentials: input.credentials,
        cache:       input.cache,
        redirect:    input.redirect,
        referrer:    '',             // strip referrer
        ...options,
      };
    } else {
      url = String(input);
    }

    const proxied = rewriteUrl(url);

    // Strip/replace headers that betray our real origin
    const headers = new Headers(options.headers || {});
    headers.delete('origin');
    headers.delete('referer');
    headers.set('x-andesine-target', url);           // server uses this to reconstruct the real request
    options.headers = headers;
    options.mode    = 'cors';                         // proxy always accepts CORS

    return _NativeFetch(proxied, options);
  };


  /* ─────────────────────────────────────────────
   * 4. XMLHttpRequest OVERRIDE
   * ───────────────────────────────────────────── */
  const _NativeXHR = globalScope.XMLHttpRequest;

  function AndesineXHR() {
    const _xhr  = new _NativeXHR();
    let _method = 'GET';
    let _url    = '';

    // Proxy open() to rewrite the URL
    const _open = _xhr.open.bind(_xhr);
    this.open = function(method, url, async = true, user, pass) {
      _method = method;
      _url    = url;
      const proxied = rewriteUrl(url);
      return _open(method, proxied, async, user, pass);
    };

    // Proxy setRequestHeader — strip betraying headers
    const _setHdr = _xhr.setRequestHeader.bind(_xhr);
    this.setRequestHeader = function(name, value) {
      const lower = name.toLowerCase();
      if (['origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'].includes(lower)) return;
      _setHdr(name, value);
    };

    // Forward every other property/method dynamically
    const PASSTHROUGH_METHODS = ['send', 'abort', 'getAllResponseHeaders', 'getResponseHeader', 'overrideMimeType'];
    PASSTHROUGH_METHODS.forEach(m => {
      this[m] = (...args) => _xhr[m](...args);
    });

    // Forward event handlers
    const EVENT_PROPS = ['onreadystatechange', 'onload', 'onerror', 'onabort', 'onprogress', 'ontimeout', 'onloadstart', 'onloadend'];
    EVENT_PROPS.forEach(ev => {
      Object.defineProperty(this, ev, {
        get: ()      => _xhr[ev],
        set: (fn)    => { _xhr[ev] = fn; },
        enumerable:  true, configurable: true,
      });
    });

    // Forward read-only state properties
    const RO_PROPS = ['readyState', 'response', 'responseText', 'responseType', 'responseURL', 'responseXML', 'status', 'statusText', 'timeout', 'upload', 'withCredentials'];
    RO_PROPS.forEach(prop => {
      Object.defineProperty(this, prop, {
        get: ()    => _xhr[prop],
        set: (v)   => { try { _xhr[prop] = v; } catch {} },
        enumerable: true, configurable: true,
      });
    });

    ['addEventListener', 'removeEventListener', 'dispatchEvent'].forEach(m => {
      this[m] = (...args) => _xhr[m](...args);
    });
  }

  AndesineXHR.prototype = Object.create(_NativeXHR.prototype);
  AndesineXHR.UNSENT           = 0;
  AndesineXHR.OPENED           = 1;
  AndesineXHR.HEADERS_RECEIVED = 2;
  AndesineXHR.LOADING          = 3;
  AndesineXHR.DONE             = 4;

  globalScope.XMLHttpRequest = AndesineXHR;


  /* ─────────────────────────────────────────────
   * 5. WEBSOCKET OVERRIDE
   *    Redirects every WebSocket connection through
   *    the Andesine WS relay.
   *    URL format: wss://relay.andesine/ws-relay?target=<encoded>
   * ───────────────────────────────────────────── */
  const _NativeWS = globalScope.WebSocket;

  function AndesineWebSocket(url, protocols) {
    // Convert target WS URL
    let wsUrl = url;
    if (wsUrl.startsWith('ws://'))  wsUrl = wsUrl.replace('ws://',  'wss://');
    if (wsUrl.startsWith('http://')) wsUrl = wsUrl.replace('http://', 'wss://');
    if (wsUrl.startsWith('https://')) wsUrl = wsUrl.replace('https://', 'wss://');

    const relayUrl = CONFIG.wsRelayBase
      + '?target=' + encodeURIComponent(wsUrl)
      + '&origin=' + encodeURIComponent(CONFIG.targetOrigin);

    const _ws = protocols
      ? new _NativeWS(relayUrl, protocols)
      : new _NativeWS(relayUrl);

    // Proxy every property/method transparently
    const WS_METHODS = ['send', 'close'];
    WS_METHODS.forEach(m => { this[m] = (...args) => _ws[m](...args); });

    ['addEventListener', 'removeEventListener', 'dispatchEvent'].forEach(m => {
      this[m] = (...args) => _ws[m](...args);
    });

    const WS_EVENTS = ['onopen', 'onclose', 'onmessage', 'onerror'];
    WS_EVENTS.forEach(ev => {
      Object.defineProperty(this, ev, {
        get: ()   => _ws[ev],
        set: (fn) => { _ws[ev] = fn; },
        enumerable: true, configurable: true,
      });
    });

    const WS_PROPS = ['readyState', 'bufferedAmount', 'extensions', 'protocol', 'binaryType', 'url'];
    WS_PROPS.forEach(prop => {
      Object.defineProperty(this, prop, {
        get: ()   => prop === 'url' ? url : _ws[prop],  // return original URL
        set: (v)  => { try { _ws[prop] = v; } catch {} },
        enumerable: true, configurable: true,
      });
    });

    return this;
  }

  AndesineWebSocket.prototype  = Object.create(_NativeWS.prototype);
  AndesineWebSocket.CONNECTING = 0;
  AndesineWebSocket.OPEN       = 1;
  AndesineWebSocket.CLOSING    = 2;
  AndesineWebSocket.CLOSED     = 3;

  globalScope.WebSocket = AndesineWebSocket;


  /* ─────────────────────────────────────────────
   * 6. WEBRTC OVERRIDE — RTCPeerConnection
   *    Forces all ICE negotiation through the
   *    Andesine TURN/STUN relay, preventing IP leaks.
   *    Also rewrites SDP to strip local IPs.
   * ───────────────────────────────────────────── */
  const _NativeRTC = globalScope.RTCPeerConnection
    || globalScope.webkitRTCPeerConnection
    || globalScope.mozRTCPeerConnection;

  if (_NativeRTC) {
    /**
     * Rewrites an SDP blob:
     *  - Removes 'host' and 'srflx' candidate lines (local IP exposure)
     *  - Retains only 'relay' candidates (TURN-sourced)
     *  - Injects our TURN server into the SDP if needed
     */
    function rewriteSDP(sdp) {
      if (!sdp) return sdp;
      const lines = sdp.split('\n').filter(line => {
        // Strip host & server-reflexive candidates — only relay survives
        if (line.startsWith('a=candidate:')) {
          const parts = line.split(' ');
          const type  = parts[7];               // candidate type field
          if (type === 'host' || type === 'srflx') return false;
        }
        return true;
      });
      return lines.join('\n');
    }

    function buildIceConfig(userConfig) {
      const base = userConfig || {};
      return Object.assign({}, base, {
        iceServers:          CONFIG.iceServers,
        iceTransportPolicy:  'relay',          // ONLY relay — no host/srflx
        bundlePolicy:        'max-bundle',
        rtcpMuxPolicy:       'require',
      });
    }

    function AndesineRTCPeerConnection(config, constraints) {
      const safeConfig = buildIceConfig(config);
      const _pc = new _NativeRTC(safeConfig, constraints);
      let _self = this;

      // Intercept createOffer/createAnswer to rewrite SDP
      this.createOffer = function(options) {
        return _pc.createOffer(options).then(offer => {
          offer.sdp = rewriteSDP(offer.sdp);
          return offer;
        });
      };

      this.createAnswer = function(options) {
        return _pc.createAnswer(options).then(answer => {
          answer.sdp = rewriteSDP(answer.sdp);
          return answer;
        });
      };

      this.setLocalDescription = function(desc) {
        if (desc && desc.sdp) desc = { type: desc.type, sdp: rewriteSDP(desc.sdp) };
        return _pc.setLocalDescription(desc);
      };

      this.setRemoteDescription = function(desc) {
        if (desc && desc.sdp) desc = { type: desc.type, sdp: rewriteSDP(desc.sdp) };
        return _pc.setRemoteDescription(desc);
      };

      // Intercept addIceCandidate — filter out host/srflx
      this.addIceCandidate = function(candidate) {
        if (candidate && candidate.candidate) {
          const parts = candidate.candidate.split(' ');
          const type  = parts[7];
          if (type === 'host' || type === 'srflx') {
            return Promise.resolve();   // silently discard non-relay candidates
          }
        }
        return _pc.addIceCandidate(candidate);
      };

      // Forward all remaining methods
      const FORWARD = ['addTrack', 'removeTrack', 'addTransceiver', 'addStream', 'removeStream',
                       'close', 'getReceivers', 'getSenders', 'getTransceivers', 'getStats',
                       'createDataChannel', 'addEventListener', 'removeEventListener', 'dispatchEvent',
                       'generateCertificate', 'getConfiguration', 'setConfiguration',
                       'getSenders', 'getReceivers'];
      FORWARD.forEach(m => {
        if (typeof _pc[m] === 'function') {
          this[m] = (...args) => _pc[m](...args);
        }
      });

      // Forward event props
      ['onicecandidate','ontrack','onaddstream','onremovestream','ondatachannel',
       'oniceconnectionstatechange','onicegatheringstatechange','onnegotiationneeded',
       'onsignalingstatechange','onconnectionstatechange'].forEach(ev => {
        Object.defineProperty(this, ev, {
          get: ()   => _pc[ev],
          set: (fn) => { _pc[ev] = fn; },
          enumerable: true, configurable: true,
        });
      });

      // Forward read-only state props
      ['connectionState','currentLocalDescription','currentRemoteDescription',
       'iceConnectionState','iceGatheringState','localDescription','pendingLocalDescription',
       'pendingRemoteDescription','remoteDescription','signalingState','sctp'].forEach(prop => {
        Object.defineProperty(this, prop, {
          get: () => _pc[prop],
          enumerable: true, configurable: true,
        });
      });
    }

    AndesineRTCPeerConnection.prototype = Object.create(_NativeRTC.prototype);
    AndesineRTCPeerConnection.generateCertificate = _NativeRTC.generateCertificate
      ? _NativeRTC.generateCertificate.bind(_NativeRTC)
      : undefined;

    globalScope.RTCPeerConnection         = AndesineRTCPeerConnection;
    globalScope.webkitRTCPeerConnection   = AndesineRTCPeerConnection;
    globalScope.mozRTCPeerConnection      = AndesineRTCPeerConnection;
  }


  /* ─────────────────────────────────────────────
   * 7. DOM PROTOTYPE OVERRIDES
   *    Catches the exact moment any script touches
   *    .src / .href / .action on any element.
   * ───────────────────────────────────────────── */

  // 7a. Element.prototype.setAttribute
  const _nativeSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    const lower = name.toLowerCase();
    if (['src', 'href', 'action', 'data', 'poster', 'srcset'].includes(lower)) {
      if (lower === 'srcset') {
        value = rewriteSrcset(value);
      } else {
        value = rewriteUrl(value);
      }
    }
    return _nativeSetAttr.call(this, name, value);
  };

  // 7b. Rewrite <img srcset> / <source srcset>
  function rewriteSrcset(srcset) {
    return srcset.split(',').map(part => {
      const [url, descriptor] = part.trim().split(/\s+/);
      return descriptor ? `${rewriteUrl(url)} ${descriptor}` : rewriteUrl(url);
    }).join(', ');
  }

  // 7c. HTMLScriptElement.src
  installSrcProp(HTMLScriptElement, 'src');

  // 7d. HTMLImageElement.src + srcset
  installSrcProp(HTMLImageElement, 'src');
  installSrcsetProp(HTMLImageElement);

  // 7e. HTMLIFrameElement.src
  installSrcProp(HTMLIFrameElement, 'src');

  // 7f. HTMLSourceElement.src + srcset
  if (globalScope.HTMLSourceElement) {
    installSrcProp(HTMLSourceElement, 'src');
    installSrcsetProp(HTMLSourceElement);
  }

  // 7g. HTMLAnchorElement.href
  installHrefProp(HTMLAnchorElement);

  // 7h. HTMLLinkElement.href
  installHrefProp(HTMLLinkElement);

  // 7i. HTMLFormElement.action
  if (globalScope.HTMLFormElement) {
    const formDesc = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'action');
    if (formDesc && formDesc.set) {
      Object.defineProperty(HTMLFormElement.prototype, 'action', {
        get: formDesc.get,
        set(v) { formDesc.set.call(this, rewriteUrl(v)); },
        configurable: true, enumerable: true,
      });
    }
  }

  function installSrcProp(Constructor, prop) {
    if (!globalScope[Constructor.name]) return;
    const desc = Object.getOwnPropertyDescriptor(Constructor.prototype, prop)
      || Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)
      || Object.getOwnPropertyDescriptor(Element.prototype, prop);
    if (!desc) return;
    Object.defineProperty(Constructor.prototype, prop, {
      get() { return desc.get ? desc.get.call(this) : this.getAttribute(prop); },
      set(v) {
        const rw = rewriteUrl(v);
        if (desc.set) desc.set.call(this, rw);
        else _nativeSetAttr.call(this, prop, rw);
      },
      configurable: true, enumerable: true,
    });
  }

  function installHrefProp(Constructor) {
    if (!globalScope[Constructor.name]) return;
    const desc = Object.getOwnPropertyDescriptor(Constructor.prototype, 'href');
    if (!desc) return;
    Object.defineProperty(Constructor.prototype, 'href', {
      get() { return desc.get ? desc.get.call(this) : this.getAttribute('href'); },
      set(v) {
        const rw = rewriteUrl(v);
        if (desc.set) desc.set.call(this, rw);
        else _nativeSetAttr.call(this, 'href', rw);
      },
      configurable: true, enumerable: true,
    });
  }

  function installSrcsetProp(Constructor) {
    if (!globalScope[Constructor.name]) return;
    const desc = Object.getOwnPropertyDescriptor(Constructor.prototype, 'srcset');
    if (!desc) return;
    Object.defineProperty(Constructor.prototype, 'srcset', {
      get() { return desc.get ? desc.get.call(this) : this.getAttribute('srcset'); },
      set(v) {
        const rw = rewriteSrcset(v);
        if (desc.set) desc.set.call(this, rw);
        else _nativeSetAttr.call(this, 'srcset', rw);
      },
      configurable: true, enumerable: true,
    });
  }


  /* ─────────────────────────────────────────────
   * 8. HISTORY API OVERRIDE
   *    Keep pushState/replaceState virtual so
   *    SPAs navigate correctly inside the proxy.
   * ───────────────────────────────────────────── */
  const _nativePush    = history.pushState.bind(history);
  const _nativeReplace = history.replaceState.bind(history);

  history.pushState = function(state, title, url) {
    if (url) url = rewriteUrl(url);
    return _nativePush(state, title, url);
  };

  history.replaceState = function(state, title, url) {
    if (url) url = rewriteUrl(url);
    return _nativeReplace(state, title, url);
  };


  /* ─────────────────────────────────────────────
   * 9. DOCUMENT.COOKIE VIRTUALISATION
   *    Keeps the cookie store consistent with the
   *    target domain even though we're on proxy host.
   * ───────────────────────────────────────────── */
  const _cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')
    || Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');

  if (_cookieDesc) {
    Object.defineProperty(document, 'cookie', {
      get() { return _cookieDesc.get.call(document); },
      set(v) {
        // Strip Secure/SameSite restrictions that would block cross-origin cookies
        let cookie = v
          .replace(/;\s*SameSite=(Lax|Strict|None)/gi, '; SameSite=None')
          .replace(/;\s*Secure\b/gi, '')
          + '; Secure';
        _cookieDesc.set.call(document, cookie);
      },
      configurable: true,
    });
  }


  /* ─────────────────────────────────────────────
   * 10. WINDOW.OPEN OVERRIDE
   *     New windows open proxied pages.
   * ───────────────────────────────────────────── */
  const _nativeOpen = globalScope.open.bind(globalScope);
  globalScope.open = function(url, name, features) {
    return _nativeOpen(rewriteUrl(url), name, features);
  };


  /* ─────────────────────────────────────────────
   * 11. POSTMESSAGE VIRTUALISATION
   *     Rewrites targetOrigin in postMessage so
   *     cross-frame messaging works correctly.
   * ───────────────────────────────────────────── */
  const _nativePostMessage = globalScope.postMessage.bind(globalScope);
  globalScope.postMessage = function(message, targetOrigin, transfer) {
    const origin = targetOrigin === CONFIG.targetOrigin ? CONFIG.proxyOrigin : targetOrigin;
    return _nativePostMessage(message, origin, transfer);
  };


  /* ─────────────────────────────────────────────
   * 12. NAVIGATOR OVERRIDES (minimal)
   *     Prevent sites from reading the real user agent
   *     or detecting the proxy via Navigator APIs.
   * ───────────────────────────────────────────── */
  try {
    Object.defineProperty(navigator, 'userAgent', {
      get: () => navigator.userAgent,   // pass through real UA — no changes
      configurable: true,
    });
  } catch {}


  /* ─────────────────────────────────────────────
   * 13. MUTATION OBSERVER
   *     Watches for dynamically inserted nodes and
   *     rewrites any src/href attributes added after
   *     initial parse (e.g. lazy-loaded images, ads).
   * ───────────────────────────────────────────── */
  const rewriteNode = (node) => {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    ['src', 'href', 'action', 'poster', 'data'].forEach(attr => {
      const val = node.getAttribute(attr);
      if (val && !val.startsWith(CONFIG.proxyOrigin)) {
        node.setAttribute(attr, rewriteUrl(val));
      }
    });
    const srcset = node.getAttribute('srcset');
    if (srcset) node.setAttribute('srcset', rewriteSrcset(srcset));

    // Recurse into children
    node.querySelectorAll && node.querySelectorAll('[src],[href],[action],[poster],[srcset]')
      .forEach(rewriteNode);
  };

  const _observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(rewriteNode);
    });
  });

  _observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributeFilter: ['src', 'href', 'action', 'poster', 'srcset', 'data'],
  });


  /* ─────────────────────────────────────────────
   * 14. FREEZE PUBLIC OVERRIDES
   *     Target scripts cannot undo these overrides.
   * ───────────────────────────────────────────── */
  [
    [globalScope, 'fetch'],
    [globalScope, 'XMLHttpRequest'],
    [globalScope, 'WebSocket'],
    [globalScope, 'open'],
  ].forEach(([obj, key]) => {
    try {
      Object.defineProperty(obj, key, {
        value: obj[key],
        writable: false, configurable: false, enumerable: true,
      });
    } catch {}
  });

  /* Seal exported helpers for internal sub-scripts */
  globalScope.__andesine__ = Object.freeze({
    rewriteUrl,
    unwrapUrl,
    virtualLocation: VirtualLocation,
    config: Object.freeze(CONFIG),
  });

  console.debug('[Andesine] Injection active. Target:', CONFIG.targetOrigin);

})(typeof globalThis !== 'undefined' ? globalThis : window);
