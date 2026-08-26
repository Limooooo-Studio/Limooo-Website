    /* ═══ 路径切换（继承自 base.html 的页面；前端 pushState，URL 变 /路径，不真实跳转） ═══ */
    var PATHS = ['portfolio', 'qr-codes', 'icons'];
    var CURRENT_PATH = 'portfolio';

    function pathFromUrl() {
        var p = location.pathname.replace(/\/+$/, '');
        return PATHS.indexOf(p.slice(1)) !== -1 ? p.slice(1) : null;
    }
    function syncUI() {
        document.querySelectorAll('.path-card').forEach(function(card) {
            card.classList.toggle('active', card.dataset.path === CURRENT_PATH);
        });
        document.querySelectorAll('.path-panel').forEach(function(panel) {
            panel.classList.toggle('active', panel.id === 'panel-' + CURRENT_PATH);
        });
        document.getElementById('currentPath').textContent = CURRENT_PATH;
    }
    function showPath(path, ev) {
        if (ev) ev.preventDefault();
        if (PATHS.indexOf(path) === -1) return false;
        if (path !== CURRENT_PATH) {
            CURRENT_PATH = path;
            history.pushState({ path: path }, '', '/' + path);
            syncUI();
        } else if (location.pathname !== '/' + path) {
            history.replaceState({ path: path }, '', '/' + path);
            syncUI();
        }
        return false;
    }
    window.addEventListener('popstate', function() {
        var p = pathFromUrl();
        CURRENT_PATH = p || 'portfolio';
        syncUI();
    });

    /* 初始化：直接访问 /portfolio /qr-codes /icons 时打开对应界面 */
    var initPath = pathFromUrl();
    if (initPath) {
        CURRENT_PATH = initPath;
        history.replaceState({ path: initPath }, '', '/' + initPath);
    }
    syncUI();
