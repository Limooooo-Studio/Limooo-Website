/** 门禁页前端交互：运行时从 /__gate/config 获取 sitekey 与 i18n。 */

var turnstileWidget = null;
var CONFIG = null;
var GATE_I18N = {};
var TURNSTILE_SITEKEY = "";
var CURRENT_LANG = document.body.getAttribute('data-lang') || 'en-us';
document.documentElement.lang = CURRENT_LANG;

function t(key) {
  var dict = GATE_I18N[CURRENT_LANG] || GATE_I18N['en-us'] || {};
  return dict[key] !== undefined ? dict[key] : key;
}

function turnstileLang(code) {
  return { 'zh-cn': 'zh-cn', 'en-us': 'en-us', 'ja-jp': 'ja', 'ko-kr': 'ko' }[code] || 'auto';
}

function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function effectiveTheme() {
  var saved = localStorage.getItem('theme');
  return (saved === 'light' || saved === 'dark') ? saved : getSystemTheme();
}

function applyTheme(theme) {
  document.documentElement.classList.toggle('light-mode', theme === 'light');
  var sw = document.querySelector('.appearance-switch');
  if (sw) sw.setAttribute('aria-checked', theme === 'dark' ? 'true' : 'false');
}

function loadTurnstileScript() {
  if (window.turnstile || TURNSTILE_SITEKEY === '') return;
  if (document.querySelector('script[data-turnstile]')) return;
  var s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback';
  s.async = true;
  s.defer = true;
  s.setAttribute('data-turnstile', '');
  document.head.appendChild(s);
}

function showError(key) {
  var el = document.getElementById('gate-error');
  if (!el) return;
  if (!key) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = t('error_' + key);
}

function resetTurnstile() {
  var wrap = document.getElementById('turnstile-wrap');
  if (!wrap) return;
  if (!window.turnstile) {
    loadTurnstileScript();
    return;
  }
  showError('');
  if (turnstileWidget) {
    window.turnstile.remove(turnstileWidget);
    turnstileWidget = null;
  }
  turnstileWidget = window.turnstile.render(wrap, {
    sitekey: TURNSTILE_SITEKEY,
    callback: function () { document.getElementById('gate').submit(); },
    theme: effectiveTheme() === 'light' ? 'light' : 'dark',
    language: turnstileLang(CURRENT_LANG)
  });
}

function renderI18n() {
  document.querySelectorAll('[data-i18n]').forEach(function (el) {
    var text = t(el.getAttribute('data-i18n'));
    var prefix = el.getAttribute('data-i18n-prefix');
    if (prefix != null) text = text ? prefix + text : '';
    el.textContent = text;
  });
  document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });
  document.querySelectorAll('[data-i18n-attr]').forEach(function (el) {
    el.getAttribute('data-i18n-attr').split('|').forEach(function (seg) {
      var colon = seg.indexOf(':');
      if (colon === -1) return;
      seg.slice(0, colon).split(',').forEach(function (attr) {
        el.setAttribute(attr.trim(), t(seg.slice(colon + 1)));
      });
    });
  });
}

function saveLangCookie(code) {
  var rootDomain = CONFIG && CONFIG.root_domain ? CONFIG.root_domain : '';
  var domain = rootDomain && (location.hostname === rootDomain || location.hostname.endsWith('.' + rootDomain))
    ? '; domain=.' + rootDomain
    : '';
  var secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = 'user_lang_preference=' + code + '; path=/; max-age=31536000; SameSite=Lax' + secure + domain;
}

function applyLang(lang) {
  if (!GATE_I18N[lang]) return;
  if (lang !== CURRENT_LANG) {
    CURRENT_LANG = lang;
    document.documentElement.lang = lang;
    renderI18n();
    document.querySelectorAll('#langMenu .theme-option').forEach(function (opt) {
      opt.classList.toggle('selected', opt.dataset.lang === lang);
    });
  }
  saveLangCookie(lang);
  resetTurnstile();
}

function toggleLangMenu(e) {
  if (e) e.stopPropagation();
  var m = document.getElementById('langMenu');
  if (m) m.classList.toggle('open');
}

function closeLangMenu() {
  var m = document.getElementById('langMenu');
  if (m) m.classList.remove('open');
}

function setLang(code) {
  closeLangMenu();
  applyLang(code);
}

function toggleTheme() {
  var next = effectiveTheme() === 'light' ? 'dark' : 'light';
  localStorage.setItem('theme', next);
  applyTheme(next);
  resetTurnstile();
}

function onloadTurnstileCallback() {
  resetTurnstile();
}

function initGateConfig(cfg) {
  CONFIG = cfg;
  GATE_I18N = cfg.i18n || {};
  TURNSTILE_SITEKEY = cfg.sitekey || '';
  CURRENT_LANG = cfg.lang || CURRENT_LANG;
  document.documentElement.lang = CURRENT_LANG;
  applyTheme(effectiveTheme());
  renderI18n();
  var errorKey = document.body.getAttribute('data-gate-error') || '';
  if (errorKey) showError(errorKey);
  if (TURNSTILE_SITEKEY === '') {
    showError('sitekey');
    return;
  }
  resetTurnstile();
}

(function bindLangHover() {
  var fly = document.querySelector('.lang-flyout');
  if (!fly) return;
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    fly.addEventListener('mouseenter', function () {
      var m = document.getElementById('langMenu');
      if (m) m.classList.add('open');
    });
    fly.addEventListener('mouseleave', closeLangMenu);
  }
})();

document.addEventListener('click', function (e) {
  if (!e.target.closest('.theme-toggle')) closeLangMenu();
});

/* 页面静态文案先按构建语言渲染；运行时加载配置后补齐 Turnstile 与切换能力。 */
applyTheme(effectiveTheme());
renderI18n();
showError(document.body.getAttribute('data-gate-error') || '');

fetch('/__gate/config', { headers: { 'Accept': 'application/json' } })
  .then(function (r) { return r.ok ? r.json() : null; })
  .then(function (cfg) { if (cfg) initGateConfig(cfg); })
  .catch(function () { showError('unavailable'); });

fetch('/__gate/diag', { headers: { 'Accept': 'application/json' } })
  .then(function (r) { return r.ok ? r.json() : null; })
  .then(function (d) {
    if (!d) return;
    var map = { 'diag-country': d.country, 'diag-ip': d.ip, 'diag-ray': d.ray };
    Object.keys(map).forEach(function (id) {
      var el = document.getElementById(id);
      if (el && map[id]) el.textContent = map[id];
    });
  })
  .catch(function () {});

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () {
  if (!localStorage.getItem('theme')) applyTheme(getSystemTheme());
});
