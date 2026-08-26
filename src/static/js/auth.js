var turnstileWidget = null;
document.documentElement.lang = document.body.getAttribute('data-lang') || 'en-us';
  var TURNSTILE_SITEKEY = document.body.getAttribute('data-sitekey') || '';
  var CURRENT_LANG = document.body.getAttribute('data-lang') || 'en-us';
  var GATE_I18N = JSON.parse(document.body.getAttribute('data-gate-i18n') || '{}');

  function t(key) {
    var dict = GATE_I18N[CURRENT_LANG] || GATE_I18N["en-us"];
    return dict && dict[key] !== undefined ? dict[key] : key;
  }
  /* Turnstile 的 language 参数要求小写格式（zh-cn / en-us / ja / ko），
     直接传 zh-cn 等大写值不会被识别，widget 会回退到浏览器语言 */
  function turnstileLang(code) {
    return { "zh-cn": "zh-cn", "en-us": "en-us", "ja-jp": "ja", "ko-kr": "ko" }[code] || "auto";
  }

  function onTurnstileSuccess() {
    document.getElementById("gate").submit();
  }

  /* ── 主题切换（与主站一致：localStorage "theme"，首次跟随系统） ── */
  function getSystemTheme() {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  function effectiveTheme() {
    var saved = localStorage.getItem("theme");
    return (saved === "light" || saved === "dark") ? saved : getSystemTheme();
  }
  function applyTheme(theme) {
    document.documentElement.classList.toggle("light-mode", theme === "light");
    var mc = document.querySelector('meta[name="theme-color"]');
    if (mc) mc.content = theme === "light" ? "#ffffff" : "#17181c";
    var sw = document.querySelector(".appearance-switch");
    if (sw) sw.setAttribute("aria-checked", theme === "dark" ? "true" : "false");
  }
  function resetTurnstile() {
    var wrap = document.getElementById("turnstile-wrap");
    if (!wrap || !window.turnstile) return;
    // turnstile.reset() 不接受配置项，语言/主题只能在 render 时生效，
    // 因此切换语言或主题时必须先移除旧 widget，再用新配置重新渲染。
    if (turnstileWidget) {
      window.turnstile.remove(turnstileWidget);
      turnstileWidget = null;
    }
    turnstileWidget = window.turnstile.render(wrap, {
      sitekey: TURNSTILE_SITEKEY,
      callback: onTurnstileSuccess,
      theme: effectiveTheme() === "light" ? "light" : "dark",
      language: turnstileLang(CURRENT_LANG)
    });
  }
  function toggleTheme() {
    var next = effectiveTheme() === "light" ? "dark" : "light";
    localStorage.setItem("theme", next);
    applyTheme(next);
    resetTurnstile();
  }

  /* ── 语言切换（与主站一致：cookie + 纯前端切换，不刷新页面） ── */
  function saveLangCookie(code) {
    var domain = location.hostname.endsWith("limooo.cn") ? "domain=.limooo.cn; " : "";
    var secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = "user_lang_preference=" + code + "; path=/; max-age=31536000; SameSite=Lax" + secure + "; " + domain;
  }
  function renderI18n() {
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var text = t(el.getAttribute("data-i18n"));
      var prefix = el.getAttribute("data-i18n-prefix");
      if (prefix != null) text = text ? prefix + text : "";
      el.textContent = text;
    });
    document.querySelectorAll("[data-i18n-attr]").forEach(function (el) {
      el.getAttribute("data-i18n-attr").split("|").forEach(function (seg) {
        var colon = seg.indexOf(":");
        if (colon === -1) return;
        seg.slice(0, colon).split(",").forEach(function (attr) {
          el.setAttribute(attr.trim(), t(seg.slice(colon + 1)));
        });
      });
    });
  }
  function applyLang(lang) {
    if (!GATE_I18N[lang]) return;
    if (lang !== CURRENT_LANG) {
      CURRENT_LANG = lang;
      document.documentElement.lang = lang;
      renderI18n();
      document.querySelectorAll("#langMenu .theme-option").forEach(function (opt) {
        opt.classList.toggle("selected", opt.dataset.lang === lang);
      });
    }
    saveLangCookie(lang);
    resetTurnstile();
  }
  function toggleLangMenu(e) {
    if (e) e.stopPropagation();
    var m = document.getElementById("langMenu");
    if (m) m.classList.toggle("open");
  }
  function closeLangMenu() {
    var m = document.getElementById("langMenu");
    if (m) m.classList.remove("open");
  }
  function setLang(code) {
    closeLangMenu();
    applyLang(code);
  }
  /* 桌面端：语言菜单悬停自动展开/收起（与主站一致），触摸端保持点击切换 */
  (function bindLangHover() {
    var fly = document.querySelector(".lang-flyout");
    if (!fly) return;
    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      fly.addEventListener("mouseenter", function () {
        var m = document.getElementById("langMenu");
        if (m) m.classList.add("open");
      });
      fly.addEventListener("mouseleave", closeLangMenu);
    }
  })();
  /* 点击控件外部时收起语言菜单 */
  document.addEventListener("click", function (e) {
    if (!e.target.closest(".theme-toggle")) closeLangMenu();
  });
  function onloadTurnstileCallback() {
    resetTurnstile();
  }
  // 初始同步主题与文案（Turnstile 由 onloadTurnstileCallback 显式渲染）
  applyTheme(effectiveTheme());
  renderI18n();
  // 动态诊断信息（Location/IP/Ray ID）每次实时获取，页面其余部分走缓存
  fetch("/__gate/diag", { headers: { "Accept": "application/json" } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) return;
      var map = { "diag-country": d.country, "diag-ip": d.ip, "diag-ray": d.ray };
      Object.keys(map).forEach(function (id) {
        var el = document.getElementById(id);
        if (el && map[id]) el.textContent = map[id];
      });
    })
    .catch(function () {});
  /* 系统主题变化时：仅在无缓存（跟随系统）状态下自动跟随 */
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", function () {
    if (!localStorage.getItem("theme")) applyTheme(getSystemTheme());
  });
