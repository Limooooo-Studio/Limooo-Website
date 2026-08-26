/* ═══════════════════════════════════════════════════════════════
   联系页：二维码悬停浮层 + 一键复制
   ═══════════════════════════════════════════════════════════════ */

/* ── 问卷方块位置：英语置底，其他语言置顶 ── */
function positionSurvey() {
    var block = document.getElementById('surveyBlock');
    if (!block) return;
    var list = block.parentNode;
    if (CURRENT_LANG === 'en-us') {
        list.appendChild(block);
    } else if (list.firstChild !== block) {
        list.insertBefore(block, list.firstChild);
    }
}
document.addEventListener('languagechange', positionSurvey);

/* ── 复制提示持续时间 ── */
var COPY_HINT_DURATION = 2000;

/* 更新气泡提示文本 */
function showTip(tipEl, message, visible) {
    tipEl.innerText = message;
    if (visible) {
        tipEl.style.opacity = '1'; tipEl.style.visibility = 'visible';
        tipEl.style.transform = 'translateX(-50%) translateY(0)';
    } else {
        tipEl.style.opacity = ''; tipEl.style.visibility = '';
        tipEl.style.transform = '';
    }
}

/* 复制文本到剪贴板，并显示"已复制"反馈 */
function handleCopy(el, text) {
    navigator.clipboard.writeText(text).then(function() {
        var tip = el.querySelector('.bubble-tip');
        if (tip) {
            showTip(tip, t('copied'), true);
            var tipKey = el.dataset.copyTip || 'click_to_copy';
            setTimeout(function() { showTip(tip, t(tipKey), false); }, COPY_HINT_DURATION);
        }
    });
}

/* ── 二维码相关：桌面端悬停显示对应社交账号的二维码 ── */
var qrDisplay, qrImage;

/* DOM 加载完毕后初始化二维码浮层 */
window.addEventListener('load', function() {
    qrDisplay = document.getElementById('qrDisplay');
    qrImage = document.getElementById('qrImage');
    var triggers = document.querySelectorAll('.qr-trigger');

    if (qrDisplay && window.matchMedia('(hover: hover)').matches) {
        triggers.forEach(function(trigger) {
            trigger.addEventListener('mouseenter', function() {
                qrImage.src = trigger.dataset.qr;
                qrDisplay.classList.add('show');
            });
            trigger.addEventListener('mouseleave', function() {
                qrDisplay.classList.remove('show');
            });
        });
    }
});


/* 问卷位置：英语置底，其他语言置顶（切换语言时由 languagechange 事件同步） */
positionSurvey();

/* 联系信息淡入 — 级联错开 */
setTimeout(function() {
    var items = document.querySelectorAll('.reveal-item');
    items.forEach(function(el, i) {
        setTimeout(function() { el.classList.add('show'); }, i * 80);
    });
}, 100);
