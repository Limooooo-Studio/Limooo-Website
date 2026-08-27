/**
 * CSP 友好的事件委托层（docs/14）。
 *
 * 模板不再写 onclick/oninput 内联事件，改为 data-action / data-input
 * 声明，由本文件在页面加载后统一委托到 window 上的同名全局函数。
 * 这样 script-src 可保持 'self'，不需要 'unsafe-inline'。
 */
(function () {
  function runAction(el, event) {
    var name = el.getAttribute("data-action");
    if (el.hasAttribute("data-stop")) event.stopPropagation();
    if (!name || name === "none") return;

    var args = [];
    if (el.hasAttribute("data-arg")) {
      var raw = el.getAttribute("data-arg");
      var kind = el.getAttribute("data-arg-type");
      if (kind === "json") {
        try { args.push(JSON.parse(raw)); } catch (_) { args.push(raw); }
      } else if (kind === "number") {
        args.push(Number(raw));
      } else {
        args.push(raw);
      }
    }
    if (el.hasAttribute("data-needs-event")) args.push(event);

    var fn = window[name];
    if (typeof fn === "function") fn.apply(el, args);
    if (el.hasAttribute("data-prevent")) event.preventDefault();
  }

  document.addEventListener("click", function (event) {
    var el = event.target.closest("[data-action]");
    if (el) runAction(el, event);
  });

  document.addEventListener("input", function (event) {
    var el = event.target.closest("[data-input]");
    if (!el) return;
    var fn = window[el.getAttribute("data-input")];
    if (typeof fn === "function") fn.call(el, event);
  });
})();
