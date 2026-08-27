/**
 * 访客仪表盘。
 *
 * 状态筛选完全在本地完成：首次加载只请求一次 /api/visitors，
 * 点击状态 chip 只更新 DOM，不再发送 /api/visitors?status=... 请求。
 * 自动刷新、语言切换和页面重新可见时仍只使用无 status 参数的端点。
 */

import { filterMarkers } from './visitor-filter.js';

// ── 数据与请求状态 ──
let allMarkers = [];
let statusCounts = {};
let currentStatus = 'all';
let inFlight = false;
let dataLoaded = false;
let lastLoadedAt = 0;
let rangeDays = 30;
let maxMarkers = 500;

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
    rangeDays = Number(data.range_days || 30);
    maxMarkers = Number(data.max_markers || 500);
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

    return '<div class="visitor-row" data-hash="' + esc(markerId) + '">' +
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
  document.getElementById('list-sub').textContent =
    t('ip_count', { count: filtered.length }) + ' · ' + rangeDays + 'd · max ' + maxMarkers;
  renderList(filtered);
}

document.getElementById('filter-bar').addEventListener('click', (event) => {
  const btn = event.target.closest('.chip');
  if (!btn) return;
  currentStatus = btn.dataset.status;
  applyFilter();
});

function esc(value) {
  const div = document.createElement('div');
  div.textContent = value || '';
  return div.innerHTML;
}

// 自动刷新：页面不可见时暂停，避免后台挂机持续请求；重新可见且数据过期时
// 再补一次刷新。无论何时刷新，都不会改变 currentStatus 或发送 status 参数。
let refreshTimer = null;
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { refresh(); }, 60000);
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
    if (dataLoaded && Date.now() - lastLoadedAt > 60000) refresh();
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
