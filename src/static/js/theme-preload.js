/* 主题预置脚本：必须在 body 渲染前执行，避免浅色模式白屏闪烁。
   外置文件替代原模板内联 <script>，让 CSP 无需 unsafe-inline。 */
(function () {
  var theme = localStorage.getItem("theme");
  if (!theme) {
    var match = document.cookie.match(/(?:^|;\s*)limooo_theme=(light|dark)/);
    theme = match ? match[1] : null;
  }
  if (
    theme === "light" ||
    (!theme && window.matchMedia("(prefers-color-scheme: light)").matches)
  ) {
    document.documentElement.classList.add("light-mode");
  }
})();
