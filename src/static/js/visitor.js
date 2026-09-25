/**
 * 访客仪表盘。
 *
 * 状态筛选完全在本地完成：首次加载只请求一次 /api/visitors，
 * 点击状态 chip 只更新 DOM，不再发送 /api/visitors?status=... 请求。
 * 自动刷新、语言切换和页面重新可见时仍只使用无 status 参数的端点。
 *
 * 点击某一行：调 /api/visitors/<hash>/ip 单行解密完整 IP（列表接口只有哈希），
 * 成功即在**新标签页**打开 https://ipinfo.io/<ip>。
 */

import { filterMarkers } from './visitor-filter.js';

// ── 数据与请求状态 ──
let allMarkers = [];
let statusCounts = {};
let currentStatus = 'all';
let inFlight = false;
let dataLoaded = false;
let lastLoadedAt = 0;

// base.js 通过经典脚本注入全局 t()；模块脚本执行顺序在不同浏览器可能不同，
// 这里做一层本地适配，翻译函数尚未就绪时只回退 key，不产生 ReferenceError。
function t(key, params) {
  const translator = typeof window !== 'undefined' ? window.t : undefined;
  return typeof translator === 'function' ? translator(key, params) : key;
}

// ── 仪表盘 ──
function showDashboard() {
  const dash = document.getElementById('dashboard');
  dash.classList.remove('hidden');
  requestAnimationFrame(() => {
    dash.classList.add('visible');
  });
  refresh();
}

function handleLogout() {
  const next = encodeURIComponent(location.href);
  location.href = '/logout?next=' + next;
}

// ── 数据 ──
function showLoading() {
  const container = document.getElementById('visitor-list');
  if (container) {
    container.innerHTML = '<div class="loading-indicator">' +
      '<div class="loading-dot"></div><div class="loading-dot"></div><div class="loading-dot"></div>' +
      '</div>';
  }
}

function showError() {
  const container = document.getElementById('visitor-list');
  if (container) {
    container.innerHTML = '<div class="loading-indicator dim">' + esc(t('load_failed')) + '</div>';
  }
}

function updateStats(stats) {
  const safe = stats || {};
  document.getElementById('stat-ips').textContent = Number(safe.total_ips || 0).toLocaleString();
  document.getElementById('stat-requests').textContent = Number(safe.total_requests || 0).toLocaleString();
  document.getElementById('stat-countries').textContent = Number(safe.countries || 0).toLocaleString();
  document.getElementById('stat-statuses').textContent = Object.keys(statusCounts).length.toLocaleString();
}

async function refresh() {
  if (inFlight) return;
  inFlight = true;
  let refreshed = false;
  try {
    if (!dataLoaded) showLoading();

    const resp = await fetch('/api/visitors');
    if (resp.status === 401) {
      window.location.href = '/login?next=' + encodeURIComponent(location.href);
      return;
    }
    if (resp.status === 403) {
      document.getElementById('visitor-list').innerHTML =
        '<div class="loading-indicator dim">' + esc(t('no_permission')) + '</div>';
      return;
    }
    if (!resp.ok) throw new Error('HTTP ' + resp.status);

    const data = await resp.json();
    allMarkers = Array.isArray(data.markers) ? data.markers : [];
    statusCounts = data.status_counts || {};
    dataLoaded = true;
    lastLoadedAt = Date.now();
    updateStats(data.stats);
    refreshed = true;
  } catch (error) {
    console.error('加载失败:', error);
    showError();
  } finally {
    inFlight = false;
    if (refreshed) applyFilter();
  }
}

function formatTime(value) {
  if (!value) return '';
  const str = String(value);
  const numeric = Number(str);
  if (/^\d+$/.test(str) && Number.isFinite(numeric)) {
    const date = new Date(numeric * 1000);
    if (!Number.isNaN(date.getTime())) {
      const pad = (n) => String(n).padStart(2, '0');
      return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate()) +
        ' ' + pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes());
    }
  }
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
  return m ? (m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5]) : str;
}

function statusClass(code) {
  if (code === '444') return 's444';
  if (code.charAt(0) === '5') return 's5';
  if (code.charAt(0) === '4') return 's4';
  if (code.charAt(0) === '3') return 's3';
  return 's2';
}

function renderList(markers) {
  const container = document.getElementById('visitor-list');
  if (!markers.length) {
    container.innerHTML = '<div class="loading-indicator dim">' + esc(t('no_records')) + '</div>';
    return;
  }

  container.innerHTML = markers.map((m) => {
    const markerId = m.ip_hash || '';
    const hasGeo = !!(m.country || m.city);
    let locHtml;
    if (hasGeo) {
      const sameLoc = m.country && m.city &&
        m.country.trim().toLowerCase() === m.city.trim().toLowerCase();
      if (sameLoc) {
        locHtml = '<div class="loc">' + esc(m.country) + '</div>';
      } else {
        locHtml = (m.country ? '<div class="loc">' + esc(m.country) + '</div>' : '') +
                  (m.city ? '<div class="loc-city">' + esc(m.city) + '</div>' : '');
      }
    } else {
      locHtml = '<div class="loc">' + esc(markerId || t('unknown')) + '</div>';
    }

    const lines = [];
    if (markerId) lines.push('ID: ' + esc(markerId));
    if (m.isp) lines.push('ISP: ' + esc(m.isp));
    if (m.asn) lines.push('AS: ' + esc(m.asn));
    const badges = Object.keys(m.statuses || {})
      .sort((a, b) => Number(a) - Number(b))
      .map((c) => '<span class="badge ' + statusClass(c) + '">' + esc(c) + '×' +
        Number(m.statuses[c]) + '</span>')
      .join('');

    return '<div class="visitor-row" data-hash="' + esc(markerId) + '" title="' +
      esc(t('ip_view_hint')) + '">' +
      '<div class="dot ' + (hasGeo ? 'geo' : 'nogeo') + '"></div>' +
      '<div class="info">' + locHtml +
      '<div class="detail">' + lines.join(' · ') + '</div>' +
      (badges ? '<div class="badges">' + badges + '</div>' : '') +
      '</div><div class="time-col">' +
      '<div class="time-text">' + esc(formatTime(m.last_time)) + '</div>' +
      '<div class="count-text">' + t('times', { count: m.count }) + '</div>' +
      '</div></div>';
  }).join('');
}

function renderChips(counts) {
  const bar = document.getElementById('filter-bar');
  if (!bar) return;
  const codes = Object.keys(counts || {}).sort((a, b) => Number(a) - Number(b));
  let html = chipHtml('all', t('filter_all'), null);
  codes.forEach((c) => {
    html += chipHtml(c, c, counts[c]);
  });
  bar.innerHTML = html;
}

function chipHtml(status, label, count) {
  const active = currentStatus === status ? ' active' : '';
  const countHtml = count != null ? '<span class="cnt">' + count + '</span>' : '';
  return '<button class="chip' + active + '" data-status="' + esc(status) + '">' +
    esc(label) + countHtml + '</button>';
}

function applyFilter() {
  if (!dataLoaded || inFlight) return;
  renderChips(statusCounts);

  const filtered = filterMarkers(allMarkers, currentStatus);
  renderList(filtered);
}

document.getElementById('filter-bar').addEventListener('click', (event) => {
  const btn = event.target.closest('.chip');
  if (!btn) return;
  currentStatus = btn.dataset.status;
  applyFilter();
});

// ── 点击访客行：解密该行 IP 并跳 ipinfo.io ──
// 列表接口只给 ip_hash；完整 IP 走单行端点按需解密（见
// functions/api/visitors/[hash]/ip.ts），避免每次轮询把 500 条密文全解一遍。
const IP_LITERAL_RE = /^[0-9a-fA-F:.]{3,45}$/;

let toastTimer = null;
function toast(message) {
  if (!message) return;
  let el = document.getElementById('visitor-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'visitor-toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  void el.offsetWidth; // 重新触发过渡，连续点击也有反馈
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); }, 3000);
}

async function openIpInfo(hash) {
  if (!hash) {
    toast(t('ip_unavailable'));
    return;
  }

  // 新标签页必须在**点击的同步阶段**先占位：await 之后再 window.open，
  // Safari/Chrome 会判定为「非用户手势触发的弹窗」直接拦掉。
  // noopener 只能事后补（用了 noopener 就拿不到窗口引用去改地址），
  // 所以这里先开 about:blank，再把 opener 置空，避免 reverse tabnabbing。
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  const fail = () => {
    if (tab) tab.close();
    toast(t('ip_unavailable'));
  };

  let resp;
  try {
    resp = await fetch('/api/visitors/' + encodeURIComponent(hash) + '/ip', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  } catch (e) {
    fail();
    return;
  }
  if (!resp.ok) {
    // 历史行没有密文（404）、密钥缺失（503）等都归到同一个提示，不泄露细节。
    fail();
    return;
  }
  let data;
  try {
    data = await resp.json();
  } catch (e) {
    fail();
    return;
  }
  const ip = typeof data.ip === 'string' ? data.ip.trim() : '';
  if (!IP_LITERAL_RE.test(ip)) {
    fail();
    return;
  }

  const url = 'https://ipinfo.io/' + ip;
  if (tab) {
    tab.location.replace(url);
  } else {
    // 极少数情况下占位也被拦（比如用户禁用了弹窗）：退回当前标签页，功能不丢。
    location.href = url;
  }
}

document.getElementById('visitor-list').addEventListener('click', (event) => {
  const row = event.target.closest('.visitor-row');
  if (!row) return;
  openIpInfo(row.dataset.hash);
});

function esc(value) {
  const div = document.createElement('div');
  div.textContent = value || '';
  return div.innerHTML;
}

// 自动刷新：页面不可见时暂停，避免后台挂机持续请求；重新可见且数据过期时
// 再补一次刷新。无论何时刷新，都不会改变 currentStatus 或发送 status 参数。
//
// 节奏为什么是 10 分钟：/api/visitors 要聚合 30 天窗口，是本站最重的 D1 查询。
// 60 秒轮询会把它放大成每天数百万行读取（2026-09-17 实测撞上免费版 5M 行/天
// 上限，全站 D1 接口停摆一整天）。5 分钟仍留下 288 次/天的余量，10 分钟减半到
// 144 次/天，而访客统计本身是按天看的运维数据，10 分钟延迟没有实际影响。
// 需要立刻看最新数据时用页面上的刷新按钮，不依赖这个定时器。
const REFRESH_INTERVAL_MS = 600000;
let refreshTimer = null;
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { refresh(); }, REFRESH_INTERVAL_MS);
}
function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopAutoRefresh();
  } else {
    startAutoRefresh();
    if (dataLoaded && Date.now() - lastLoadedAt > REFRESH_INTERVAL_MS) refresh();
  }
});

// 语言切换后仍保留当前筛选状态，只重新拉取无 status 参数的数据。
document.addEventListener('languagechange', () => { refresh(); });

// 模板内联 onclick 仍会调用 refresh() / handleLogout()，模块作用域的函数
// 需要显式挂到 window 上，保持与旧版经典脚本一致。
window.refresh = refresh;
window.handleLogout = handleLogout;

function start() {
  if (!document.hidden) startAutoRefresh();
  showDashboard();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
