/* Refresh only the dynamic status content; keep navigation, theme and footer stable. */
(function () {
  var interval = 60000;
  async function refreshStatus() {
    try {
      var response = await fetch(window.location.href, { cache: 'no-store', headers: { 'X-Requested-With': 'status-refresh' } });
      if (!response.ok) return;
      var documentNext = new DOMParser().parseFromString(await response.text(), 'text/html');
      var next = documentNext.querySelector('.claude-main');
      var current = document.querySelector('.claude-main');
      if (next && current) current.replaceWith(next);
    } catch (_) { /* keep the last known state visible during a transient outage */ }
  }
  window.setInterval(refreshStatus, interval);
})();
