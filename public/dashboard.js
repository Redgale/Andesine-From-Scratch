/**
 * Andesine Dashboard — Client Logic
 * Handles: particle system, real-time stat simulation,
 * sparkline & main chart rendering, URL bar autocomplete,
 * panel navigation, proxy overlay controls.
 */

'use strict';

/* ─── PARTICLE CANVAS ─────────────────────────── */
(function initParticles() {
  const canvas = document.getElementById('particle-canvas');
  const ctx = canvas.getContext('2d');
  let W, H, particles = [];

  const resize = () => {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  };
  window.addEventListener('resize', resize);
  resize();

  class Particle {
    constructor() { this.reset(); }
    reset() {
      this.x  = Math.random() * W;
      this.y  = Math.random() * H;
      this.vx = (Math.random() - 0.5) * 0.3;
      this.vy = (Math.random() - 0.5) * 0.3;
      this.life   = 0;
      this.maxLife = 200 + Math.random() * 400;
      this.size   = Math.random() * 1.5 + 0.5;
      this.hue    = Math.random() < 0.6 ? 18 : (Math.random() < 0.5 ? 340 : 190); // lava/magma/ice
    }
    update() {
      this.x += this.vx; this.y += this.vy; this.life++;
      if (this.life > this.maxLife || this.x < 0 || this.x > W || this.y < 0 || this.y > H) this.reset();
    }
    draw() {
      const t = this.life / this.maxLife;
      const alpha = t < 0.2 ? t / 0.2 : t > 0.8 ? (1 - t) / 0.2 : 1;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${this.hue}, 100%, 65%, ${alpha * 0.6})`;
      ctx.fill();
    }
  }

  for (let i = 0; i < 120; i++) particles.push(new Particle());

  (function loop() {
    ctx.clearRect(0, 0, W, H);
    particles.forEach(p => { p.update(); p.draw(); });
    requestAnimationFrame(loop);
  })();
})();


/* ─── PANEL NAVIGATION ────────────────────────── */
const panelBtns = document.querySelectorAll('.nav-btn[data-panel]');
panelBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.panel;
    panelBtns.forEach(b => b.classList.remove('nav-btn--active'));
    btn.classList.add('nav-btn--active');
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`panel-${target}`).classList.add('active');
  });
});


/* ─── NODES PANEL ─────────────────────────────── */
const NODE_DATA = [
  { region: 'US-EAST', name: 'Obsidian-01', ip: '104.21.48.1',  ping: 12,  load: 0.38, status: 'online' },
  { region: 'US-WEST', name: 'Basalt-03',   ip: '172.67.152.2', ping: 24,  load: 0.62, status: 'online' },
  { region: 'EU-WEST', name: 'Pumice-07',   ip: '198.41.214.5', ping: 58,  load: 0.55, status: 'online' },
  { region: 'EU-CENTRAL', name: 'Gabbro-02', ip: '31.13.79.4', ping: 67,  load: 0.41, status: 'online' },
  { region: 'ASIA-PAC', name: 'Rhyolite-04', ip: '185.60.219.8', ping: 102, load: 0.29, status: 'online' },
  { region: 'ASIA-SE', name: 'Tephrite-09', ip: '103.21.244.1', ping: 88,  load: 0.71, status: 'degraded' },
  { region: 'SA-EAST', name: 'Scoria-06',   ip: '52.67.11.4',   ping: 145, load: 0.22, status: 'online' },
  { region: 'AUS-SE',  name: 'Dacite-11',   ip: '13.54.108.1',  ping: 168, load: 0.35, status: 'online' },
];

(function renderNodes() {
  const grid = document.getElementById('nodesGrid');
  NODE_DATA.forEach(n => {
    const pingColor = n.ping < 50 ? 'var(--accent-safe)' : n.ping < 100 ? 'var(--accent-amber)' : 'var(--accent-magma)';
    const card = document.createElement('div');
    card.className = 'node-card glass';
    card.innerHTML = `
      <div class="node-card__status">
        <div class="node-status-dot node-status-dot--${n.status === 'online' ? 'online' : 'degraded'}"></div>
      </div>
      <div class="node-card__region">${n.region}</div>
      <div class="node-card__name">${n.name}</div>
      <div class="node-card__ip">${n.ip}</div>
      <div class="node-card__ping" style="color:${pingColor}">${n.ping}<sub>ms</sub></div>
      <div class="node-card__bar"><div class="node-card__bar-fill" style="width:${n.load * 100}%"></div></div>
    `;
    card.addEventListener('click', () => {
      document.querySelector('.nav-btn[data-panel="dashboard"]').click();
    });
    grid.appendChild(card);
  });
})();


/* ─── REAL-TIME STATS SIMULATION ─────────────── */
const SparkBuffer = class {
  constructor(size = 30) { this.data = Array(size).fill(0); this.size = size; }
  push(v) { this.data.push(v); if (this.data.length > this.size) this.data.shift(); }
  get() { return this.data; }
};

const sparks = {
  latency:   new SparkBuffer(30),
  bandwidth: new SparkBuffer(30),
  stability: new SparkBuffer(30),
  sessions:  new SparkBuffer(30),
};

let statsState = { latency: 18, bandwidth: 124, stability: 99.2, sessions: 0 };

function jitter(base, range) {
  return Math.max(0, base + (Math.random() - 0.5) * range);
}

function updateStats() {
  statsState.latency    = jitter(statsState.latency, 8);
  statsState.bandwidth  = jitter(statsState.bandwidth, 30);
  statsState.stability  = Math.min(100, Math.max(90, jitter(statsState.stability, 1.5)));
  statsState.sessions   = Math.round(jitter(statsState.sessions, 2));

  sparks.latency.push(statsState.latency);
  sparks.bandwidth.push(statsState.bandwidth);
  sparks.stability.push(statsState.stability);
  sparks.sessions.push(statsState.sessions);

  document.getElementById('latencyVal').textContent   = statsState.latency.toFixed(0);
  document.getElementById('bandwidthVal').textContent = (statsState.bandwidth / 8).toFixed(1);
  document.getElementById('stabilityVal').textContent = statsState.stability.toFixed(1);
  document.getElementById('sessionsVal').textContent  = statsState.sessions;

  drawSpark('sparkLatency',   sparks.latency.get(),   '#4af0ff');
  drawSpark('sparkBandwidth', sparks.bandwidth.get(), '#3dffa0');
  drawSpark('sparkStability', sparks.stability.get(), '#ffa040');
  drawSpark('sparkSessions',  sparks.sessions.get(),  '#ff6b2b');
}

function drawSpark(id, data, color) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const ctx   = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!data.length) return;

  const mn = Math.min(...data), mx = Math.max(...data);
  const range = mx - mn || 1;
  const pts = data.map((v, i) => [
    (i / (data.length - 1)) * W,
    H - ((v - mn) / range) * (H * 0.8) - H * 0.1
  ]);

  // Fill gradient
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, color + '55');
  grad.addColorStop(1, color + '00');
  ctx.beginPath();
  ctx.moveTo(pts[0][0], H);
  pts.forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.lineTo(pts[pts.length-1][0], H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  pts.forEach(([x, y], i) => i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
  ctx.strokeStyle = color;
  ctx.lineWidth   = 1.5;
  ctx.stroke();
}

setInterval(updateStats, 800);
updateStats();


/* ─── MAIN CHART ──────────────────────────────── */
(function initMainChart() {
  const canvas = document.getElementById('mainChart');
  const ctx    = canvas.getContext('2d');
  const POINTS = 80;
  const txData = Array.from({ length: POINTS }, () => Math.random() * 200 + 50);
  const rxData = Array.from({ length: POINTS }, () => Math.random() * 150 + 30);

  function drawChart() {
    const W = canvas.offsetWidth * devicePixelRatio;
    const H = canvas.offsetHeight * devicePixelRatio;
    canvas.width  = W;
    canvas.height = H;

    const allVals = [...txData, ...rxData];
    const mn = 0, mx = Math.max(...allVals) * 1.1;
    const toY = v => H - ((v - mn) / (mx - mn)) * (H - 24) - 12;
    const toX = i => (i / (POINTS - 1)) * W;

    ctx.clearRect(0, 0, W, H);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let g = 0; g < 5; g++) {
      const y = H * (g / 4);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // Draw TX
    drawLine(txData, '#ff6b2b', 'rgba(255,107,43,0.2)');
    // Draw RX
    drawLine(rxData, '#4af0ff', 'rgba(74,240,255,0.12)');

    function drawLine(data, strokeColor, fillColor) {
      const pts = data.map((v, i) => [toX(i), toY(v)]);
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, fillColor);
      grad.addColorStop(1, 'transparent');

      ctx.beginPath();
      ctx.moveTo(pts[0][0], H);
      pts.forEach(([x, y]) => ctx.lineTo(x, y));
      ctx.lineTo(pts[pts.length-1][0], H);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.beginPath();
      pts.forEach(([x, y], i) => {
        if (i === 0) ctx.moveTo(x, y);
        else {
          const cx = (pts[i-1][0] + x) / 2;
          ctx.bezierCurveTo(cx, pts[i-1][1], cx, y, x, y);
        }
      });
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth   = 2;
      ctx.stroke();
    }
  }

  setInterval(() => {
    txData.push(Math.random() * 200 + 50); txData.shift();
    rxData.push(Math.random() * 150 + 30); rxData.shift();
    drawChart();
  }, 500);

  drawChart();
  window.addEventListener('resize', drawChart);
})();


/* ─── URL BAR & AUTOCOMPLETE ──────────────────── */
const SUGGESTIONS = [
  { url: 'https://youtube.com',     label: 'YouTube',         tag: 'video'   },
  { url: 'https://reddit.com',      label: 'Reddit',          tag: 'social'  },
  { url: 'https://twitch.tv',       label: 'Twitch',          tag: 'stream'  },
  { url: 'https://discord.com/app', label: 'Discord',         tag: 'chat'    },
  { url: 'https://github.com',      label: 'GitHub',          tag: 'dev'     },
  { url: 'https://twitter.com',     label: 'Twitter / X',     tag: 'social'  },
  { url: 'https://netflix.com',     label: 'Netflix',         tag: 'video'   },
  { url: 'https://spotify.com',     label: 'Spotify',         tag: 'music'   },
  { url: 'https://figma.com',       label: 'Figma',           tag: 'design'  },
  { url: 'https://wikipedia.org',   label: 'Wikipedia',       tag: 'info'    },
];

const urlInput        = document.getElementById('urlInput');
const autocompleteList = document.getElementById('autocompleteList');
const launchBtn       = document.getElementById('launchBtn');

urlInput.addEventListener('input', () => {
  const q = urlInput.value.trim().toLowerCase();
  autocompleteList.innerHTML = '';
  if (q.length < 1) { autocompleteList.classList.remove('visible'); return; }

  const matches = SUGGESTIONS.filter(s =>
    s.url.includes(q) || s.label.toLowerCase().includes(q)
  ).slice(0, 6);

  if (!matches.length) { autocompleteList.classList.remove('visible'); return; }

  matches.forEach(m => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="ac-favicon">🌐</span><span class="ac-url">${m.url}</span><span class="ac-tag">${m.tag}</span>`;
    li.addEventListener('mousedown', e => { e.preventDefault(); urlInput.value = m.url; autocompleteList.classList.remove('visible'); });
    autocompleteList.appendChild(li);
  });
  autocompleteList.classList.add('visible');
});

urlInput.addEventListener('blur', () => {
  setTimeout(() => autocompleteList.classList.remove('visible'), 150);
});

urlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') launchProxy();
});
launchBtn.addEventListener('click', launchProxy);

document.querySelectorAll('.qs-item').forEach(item => {
  item.addEventListener('click', () => {
    urlInput.value = item.dataset.url;
    launchProxy();
  });
});


/* ─── PROXY OVERLAY ───────────────────────────── */
const proxyOverlay    = document.getElementById('proxyOverlay');
const proxyFrame      = document.getElementById('proxyFrame');
const launchTransition = document.getElementById('launchTransition');
const hudPing         = document.getElementById('hudPing');
const hudBw           = document.getElementById('hudBw');

function normalizeUrl(raw) {
  raw = raw.trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  return raw;
}

function launchProxy() {
  const raw = urlInput.value;
  const url = normalizeUrl(raw);
  if (!url) return;

  // Add to history
  addHistoryEntry(url);

  // Show transition
  proxyOverlay.classList.add('active');
  launchTransition.classList.add('active');
  statsState.sessions = Math.max(0, statsState.sessions + 1);

  // Route through server proxy
  const proxyUrl = `/proxy?url=${encodeURIComponent(url)}`;

  setTimeout(() => {
    proxyFrame.src = proxyUrl;
    launchTransition.classList.remove('active');
  }, 1400);
}

// HUD controls
document.getElementById('hudHome').addEventListener('click', () => {
  proxyOverlay.classList.remove('active');
  proxyFrame.src = 'about:blank';
  statsState.sessions = Math.max(0, statsState.sessions - 1);
});

document.getElementById('hudFullscreen').addEventListener('click', () => {
  if (!document.fullscreenElement) {
    proxyOverlay.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen();
  }
});

// HUD live stats
setInterval(() => {
  hudPing.textContent = statsState.latency.toFixed(0) + 'ms';
  hudBw.textContent   = (statsState.bandwidth / 8).toFixed(1) + 'M';
}, 1000);


/* ─── SESSION HISTORY ─────────────────────────── */
let sessionHistory = JSON.parse(localStorage.getItem('andesine_history') || '[]');

function addHistoryEntry(url) {
  const entry = {
    host:    new URL(url).hostname,
    started: new Date().toLocaleTimeString(),
    duration: '—',
    transferred: '—',
    status: 'ok'
  };
  sessionHistory.unshift(entry);
  if (sessionHistory.length > 50) sessionHistory.pop();
  localStorage.setItem('andesine_history', JSON.stringify(sessionHistory));
  renderHistory();
}

function renderHistory() {
  const tbody = document.getElementById('historyBody');
  if (!sessionHistory.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No sessions recorded yet.</td></tr>';
    return;
  }
  tbody.innerHTML = sessionHistory.map(e => `
    <tr>
      <td>${e.host}</td>
      <td>${e.started}</td>
      <td>${e.duration}</td>
      <td>${e.transferred}</td>
      <td><span class="status-badge status-badge--${e.status}">${e.status.toUpperCase()}</span></td>
    </tr>
  `).join('');
}
renderHistory();
