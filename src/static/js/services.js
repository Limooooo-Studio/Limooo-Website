/* ═══════════════════════════════════════════════════════════════
   服务详情弹层：打开 / 关闭
   ═══════════════════════════════════════════════════════════════ */

function openServiceDetail(id) {
    var modal = document.getElementById('modal-' + id);
    if (!modal) return;
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    // 点击服务选项：让地址栏渲染出 /#convention 或 /#outdoor
    if (location.hash !== '#' + id) location.hash = id;
}

/* 去除地址栏的整个 hash（连 # 一起），回到干净 URL */
function clearHash() {
    if (location.hash) {
        history.replaceState(null, '', location.pathname + location.search);
    }
}

function closeServiceDetail() {
    document.querySelectorAll('.service-modal.open').forEach(function(modal) {
        modal.classList.remove('open');
    });
    document.body.style.overflow = '';
    clearHash();
}

/* Esc 键关闭弹层 */
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeServiceDetail();
});

/* 浏览器前进 / 后退时，让弹层与地址栏 hash 保持同步 */
window.addEventListener('hashchange', function() {
    var hash = location.hash.replace('#', '');
    if (hash === 'convention' || hash === 'outdoor') {
        openServiceDetail(hash);
    } else {
        closeServiceDetail();
    }
});

/* 从主页作品框带 #convention / #outdoor 进入时，直达对应服务弹层 */
(function() {
    var hash = location.hash.replace('#', '');
    if (hash === 'convention' || hash === 'outdoor') {
        openServiceDetail(hash);
    }
})();


/* 服务卡片级联淡入 */
setTimeout(function() {
    document.querySelectorAll('.reveal-item').forEach(function(el, i) {
        setTimeout(function() { el.classList.add('show'); }, i * 60);
    });
}, 100);
