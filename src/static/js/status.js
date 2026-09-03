/* status.limooo.cn：浏览器时区显示 + 自动刷新倒计时 */
(function () {
  function browserTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
    } catch (e) {
      return "Asia/Shanghai";
    }
  }

  function formatUpdated() {
    var el = document.getElementById("status-updated-at");
    if (!el) return;
    var epoch = parseInt(el.getAttribute("data-epoch") || "0", 10);
    if (!epoch) return;
    var d = new Date(epoch * 1000);
    var text;
    try {
      text = d.toLocaleString(undefined, {
        timeZone: browserTimeZone(),
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch (e) {
      text = d.toISOString();
    }
    el.textContent = text;
  }

  formatUpdated();

  var count = 60;
  var countEl = document.getElementById("status-refresh-count");
  setInterval(function () {
    count -= 1;
    if (count <= 0) {
      count = 60;
      location.reload();
    }
    if (countEl) countEl.textContent = count;
  }, 1000);
})();
