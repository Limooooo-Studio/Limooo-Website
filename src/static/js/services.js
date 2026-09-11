/* ═══════════════════════════════════════════════════════════════
   服务详情弹层：打开 / 关闭
   ═══════════════════════════════════════════════════════════════ */

var lastServiceTrigger = null;

function openServiceDetail(id) {
    var modal = document.getElementById('modal-' + id);
    if (!modal) return;
    if (this && this.nodeType === 1 && this.matches('[data-action="openServiceDetail"]')) {
        lastServiceTrigger = this;
    }
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    var closeButton = modal.querySelector('.modal-close');
    if (closeButton) closeButton.focus();
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
    if (lastServiceTrigger && document.contains(lastServiceTrigger)) {
        lastServiceTrigger.focus();
    }
    lastServiceTrigger = null;
}

function serviceModalFocusables(modal) {
    return Array.prototype.slice.call(modal.querySelectorAll(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(function(el) { return !el.hidden && el.offsetParent !== null; });
}

/* 键盘操作：卡片支持 Enter/Space，弹层支持 Escape 与焦点循环。 */
document.addEventListener('keydown', function(e) {
    var trigger = e.target.closest && e.target.closest('[data-action="openServiceDetail"]');
    if (trigger && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        openServiceDetail.call(trigger, trigger.getAttribute('data-arg'));
        return;
    }
    var modal = document.querySelector('.service-modal.open');
    if (!modal) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        closeServiceDetail();
        return;
    }
    if (e.key !== 'Tab') return;
    var focusables = serviceModalFocusables(modal);
    if (!focusables.length) {
        e.preventDefault();
        return;
    }
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
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
