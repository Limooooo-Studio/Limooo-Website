(function () {
        document.documentElement.lang = document.body.getAttribute('data-lang') || 'en-us';
        var target = document.body.getAttribute('data-to') || '/';
        var rels = JSON.parse(document.body.getAttribute('data-preload') || '[]');
        function go() { location.replace(target); }

        /* 目标是 limooo.cn 主站时，head 中的 <link rel=preload> 已在预热
           首页作品图；这里用 new Image() 监听同批 URL（命中在途请求/缓存，
           不重复下载），全部就绪立即跳，最多停留 800ms 避免登录回跳变慢 */
        if (rels.length === 0) { go(); return; }

        var pending = rels.length;
        var fired = false;
        function finish() {
            if (fired) return;
            fired = true;
            go();
        }
        rels.forEach(function (rel) {
            var img = new Image();
            img.referrerPolicy = 'origin';
            img.onload = img.onerror = function () {
                pending -= 1;
                if (pending <= 0) finish();
            };
            img.src = rel.indexOf('http') === 0 ? rel : rel;
        });
        setTimeout(finish, 800);
    })();
