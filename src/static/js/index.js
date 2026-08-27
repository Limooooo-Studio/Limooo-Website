/* ═══════════════════════════════════════════════════════════════
   作品图加载（不影响首屏）：
   缩略图只在切换到作品区时才启动，避免 6 张图在首屏阶段抢占带宽；
   进入作品区后按 srcset 选择合适尺寸。
   ═══════════════════════════════════════════════════════════════ */
function loadWorkImages() {
    document.querySelectorAll('.work-img[data-src]').forEach(function (img) {
        if (img.dataset.srcset) img.srcset = img.dataset.srcset;
        img.src = img.dataset.src;
    });
}

/* ═══════════════════════════════════════════════════════════════
   首页滚动切换动画
   - 滚轮 / 触摸下滑 → 切换到作品展示页（portfolio）
   - 滚轮 / 触摸上滑 → 返回首屏（home）
   ═══════════════════════════════════════════════════════════════ */

/* ── 动画时序常量 ── */
var ANIM_DELAY = { initialReveal: 200, homeExit: 250, portfolioReveal: 300, staggerStep: 150, reverseExit: 250 };
var SWIPE_THRESHOLD = 60;
var WHEEL_THRESHOLD = 30;

var homeScreen = document.getElementById('home-screen');
var portfolioScreen = document.getElementById('portfolio');
var portfolioTitle = document.getElementById('port-title');
var homeRevealItems = homeScreen.querySelectorAll('.reveal-item');
var workBoxes = document.querySelectorAll('.work-box');
var heroTitle = document.getElementById('hero-title');
var navLogo = document.getElementById('nav-logo');

/* nav-logo 永久隐藏，由 hero-title 取代 */
if (navLogo) navLogo.classList.add('is-hidden');

heroTitle.addEventListener('click', function() { if (!isOnHome) reverseToHome(); });

var isOnHome = true;
var isTransitioning = false;
var animSeq = 0; // 动画序列号：新动画启动时自增，旧动画的 pending 定时器据此失效
var touchStartY = 0;

/*
 * 下滑: 「」渐出(233ms) → fly 到 nav 位置(200ms) → 淡出 → nav-logo 显示
 * 上滑: nav-logo 隐藏 → fly 回中心 + 括号恢复
 */

function morphHeroToNav() {
    if (!heroTitle) return;
    var seq = animSeq;
    // 「」渐出
    heroTitle.classList.add('hero-closed');
    // 233ms 后飞向左上角
    setTimeout(function() {
        if (seq !== animSeq) return;
        var navRect = navLogo.getBoundingClientRect();
        var vw = window.innerWidth, vh = window.innerHeight;
        var scale = window.innerWidth >= 768 ? 0.333 : 0.5;
        var dx = (navRect.left + navRect.width / 2) - vw / 2;
        var dy = (navRect.top + navRect.height / 2) - vh / 2;
        heroTitle.classList.add('flying');
        heroTitle.style.transform = 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px)) scale(' + scale + ')';
        setTimeout(function() {
            if (seq !== animSeq) return;
            heroTitle.style.transition = 'opacity 67ms ease-out';
            heroTitle.style.opacity = '0';
            navLogo.classList.remove('is-hidden');
            navLogo.onclick = function(e) { e.preventDefault(); reverseToHome(); };
            setTimeout(function() {
                if (seq !== animSeq) return;
                heroTitle.style.display = 'none';
                heroTitle.style.transition = '';
                heroTitle.style.opacity = '';
            }, 67);
        }, 200);
    }, 233);
}

function morphHeroBack() {
    if (!heroTitle) return;
    var seq = animSeq;
    navLogo.onclick = null;
    navLogo.classList.add('is-hidden');
    // 恢复全部 heroTitle 内联样式，避免残留 flying 期间的 transition/display
    heroTitle.style.display = '';
    heroTitle.style.opacity = '';
    heroTitle.style.transition = '';
    heroTitle.classList.add('flying');
    void heroTitle.offsetWidth;
    heroTitle.classList.remove('hero-closed');
    heroTitle.style.transform = 'translate(-50%, -50%)';
    setTimeout(function() {
        if (seq !== animSeq) return;
        heroTitle.classList.remove('flying');
        // isTransitioning / isOnHome 由 reverseToHome 的回调统一按序重置
    }, 267);
}

function showPortfolio() {
    // hero-title 已飞到 nav 位置，直接留在那作为 logo
    var seq = animSeq;
    portfolioScreen.scrollTop = 0; // 从顶部展示，避免惯性滚动残留
    homeScreen.style.display = 'none';
    portfolioScreen.style.visibility = 'visible';
    portfolioScreen.style.opacity = '1';
    loadWorkImages();
    // 下滑切换到作品区：地址栏渲染 /#portfolio
    if (location.hash !== '#portfolio') location.hash = 'portfolio';

    setTimeout(function() {
        if (seq !== animSeq) return;
        portfolioTitle.classList.add('show');
        workBoxes.forEach(function(box, index) {
            setTimeout(function() { box.classList.add('show'); }, index * ANIM_DELAY.staggerStep);
        });
        isOnHome = false;
        isTransitioning = false;
    }, ANIM_DELAY.portfolioReveal);
}

function triggerCapture() {
    if (isTransitioning || !isOnHome) return;
    isTransitioning = true;
    animSeq++;
    var seq = animSeq;
    document.querySelector('.scroll-hint').style.display = 'none';
    homeRevealItems.forEach(function(item) {
        item.classList.remove('show');
        item.classList.add('exit-up');
    });
    morphHeroToNav();
    setTimeout(function() {
        if (seq !== animSeq) return;
        showPortfolio();
    }, 533);
}

/* 直达例图（#portfolio）：不播滚动切换动画，直接展示作品区，
   仅保留 work-box 原有的级联淡入 */
function showPortfolioDirect() {
    if (isTransitioning) return;
    isTransitioning = true;
    animSeq++;
    var seq = animSeq;
    // 隐藏首屏与 hero 标题（不飞行，直接不显示）
    portfolioScreen.scrollTop = 0;
    homeScreen.style.display = 'none';
    if (heroTitle) heroTitle.style.display = 'none';
    if (navLogo) {
        navLogo.classList.remove('is-hidden');
        navLogo.onclick = function(e) { e.preventDefault(); reverseToHome(); };
    }
    portfolioScreen.style.visibility = 'visible';
    portfolioScreen.style.opacity = '1';
    loadWorkImages();
    setTimeout(function() {
        if (seq !== animSeq) return;
        portfolioTitle.classList.add('show');
        workBoxes.forEach(function(box, index) {
            setTimeout(function() { box.classList.add('show'); }, index * ANIM_DELAY.staggerStep);
        });
        isOnHome = false;
        isTransitioning = false;
    }, ANIM_DELAY.portfolioReveal);
}

function resetHomeItems() {
    document.querySelector('.scroll-hint').style.display = '';
    homeRevealItems.forEach(function(item) {
        item.classList.remove('exit-up', 'show');
        item.classList.add('from-top');
    });
    void homeScreen.offsetWidth;
    requestAnimationFrame(function() {
        homeRevealItems.forEach(function(item) {
            item.classList.remove('from-top');
            item.classList.add('show');
        });
    });
}

function reverseToHome() {
    if (isOnHome || isTransitioning || portfolioScreen.scrollTop > 10) return;
    isTransitioning = true;
    animSeq++;
    var seq = animSeq;
    portfolioScreen.classList.add('portfolio-exit');
    morphHeroBack();
    // 与 morphHeroBack 移除 flying 的 400ms 对齐，避免中间窗口期状态不一致
    setTimeout(function() {
        if (seq !== animSeq) return;
        portfolioScreen.style.visibility = 'hidden';
        portfolioScreen.style.opacity = '0';
        portfolioScreen.classList.remove('portfolio-exit');
        document.querySelectorAll('.work-box, #port-title').forEach(function(item) { item.classList.remove('show'); });
        homeScreen.style.display = 'flex';
        void homeScreen.offsetWidth;
        resetHomeItems();
        isOnHome = true;
        isTransitioning = false;
        // 返回主页：把整个 hash（连 # 一起）从地址栏去掉
        if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    }, Math.max(ANIM_DELAY.reverseExit, 400));
}

/* ── 鼠标滚轮监听 ── */
window.addEventListener('wheel', function(event) {
    // 切换动画进行中：吞掉所有滚轮事件，阻断触控板惯性继续把作品页往下滚
    if (isTransitioning) { event.preventDefault(); return; }
    if (event.deltaY > WHEEL_THRESHOLD && isOnHome) { event.preventDefault(); triggerCapture(); return; }
    if (event.deltaY < -WHEEL_THRESHOLD && !isOnHome && portfolioScreen.scrollTop <= 0) { event.preventDefault(); reverseToHome(); }
}, { passive: false });

/* ── 触摸滑动监听 ── */
document.addEventListener('touchstart', function(event) {
    touchStartY = event.touches[0].clientY;
}, { passive: true });

document.addEventListener('touchend', function(event) {
    if (isTransitioning) return;
    var swipeDistance = touchStartY - event.changedTouches[0].clientY;
    if (isOnHome && swipeDistance > SWIPE_THRESHOLD) { triggerCapture(); return; }
    if (!isOnHome && swipeDistance < -SWIPE_THRESHOLD && portfolioScreen.scrollTop <= 0) { reverseToHome(); }
}, { passive: true });

/* 浏览器前进 / 后退时，让页面与地址栏 hash 保持同步 */
window.addEventListener('hashchange', function() {
    if (location.hash === '#portfolio') {
        if (isOnHome && !isTransitioning) showPortfolioDirect();
    } else {
        if (!isOnHome && !isTransitioning) reverseToHome();
    }
});


/* 标题飞入 → 箭头级联淡入 */
setTimeout(function() {
    heroTitle.classList.add('visible');
}, 200);
setTimeout(function() {
    document.querySelectorAll('.scroll-hint.reveal-item').forEach(function(el) {
        el.classList.add('show');
    });
}, 500);

/* 从服务页「查看例图」带 #portfolio 进入时，直接展示作品区（不播切换动画） */
if (location.hash === '#portfolio') {
    setTimeout(function() { showPortfolioDirect(); }, 100);
}
