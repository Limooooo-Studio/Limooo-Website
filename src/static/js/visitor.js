        // ── 仪表盘 ──
        function showDashboard() {
            var dash = document.getElementById('dashboard');
            dash.classList.remove('hidden');
            requestAnimationFrame(function() {
                dash.classList.add('visible');
            });
            document.getElementById('global-footer').style.display = 'none';
            refresh();
        }

        function handleLogout() {
            var next = encodeURIComponent(location.href);
            location.href = '/logout?next=' + next;
        }

        // ── 数据 ──
        let currentStatus = 'all';

        async function refresh() {
            try {
                var url = '/api/visitors';
                if (currentStatus && currentStatus !== 'all') {
                    url += '?status=' + encodeURIComponent(currentStatus);
                }
                const resp = await fetch(url);
                if (resp.status === 401) { window.location.href = '/login?next=' + encodeURIComponent(location.href); return; }
                const data = await resp.json();

                document.getElementById('stat-ips').textContent = data.stats.total_ips.toLocaleString();
                document.getElementById('stat-requests').textContent = data.stats.total_requests.toLocaleString();
                document.getElementById('stat-countries').textContent = data.stats.countries.toLocaleString();
                var sc = data.status_counts || {};
                document.getElementById('stat-statuses').textContent = Object.keys(sc).length.toLocaleString();
                renderChips(sc);
                document.getElementById('list-sub').textContent = t('ip_count', { count: data.markers.length });

                renderList(data.markers);
            } catch (err) { console.error('加载失败:', err); }
        }

        function formatTime(str) {
            if (!str) return '';
            var m = String(str).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
            return m ? (m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5]) : str;
        }

        function statusClass(code) {
            if (code === '444') return 's444';
            if (code.charAt(0) === '5') return 's5';
            if (code.charAt(0) === '4') return 's4';
            if (code.charAt(0) === '3') return 's3';
            return 's2';
        }

        function renderList(markers) {
            const container = document.getElementById('visitor-list');
            if (!markers.length) {
                container.innerHTML = '<div class="loading-indicator dim">' + esc(t('no_records')) + '</div>';
                return;
            }
            container.innerHTML = markers.map(m => {
                const hasGeo = !!(m.country || m.city);
                let locHtml;
                if (hasGeo) {
                    const sameLoc = m.country && m.city && m.country.trim().toLowerCase() === m.city.trim().toLowerCase();
                    if (sameLoc) {
                        locHtml = '<div class="loc">' + esc(m.country) + '</div>';
                    } else {
                        locHtml = (m.country ? '<div class="loc">' + esc(m.country) + '</div>' : '') +
                                  (m.city ? '<div class="loc-city">' + esc(m.city) + '</div>' : '');
                    }
                } else {
                    locHtml = '<div class="loc">' + esc(m.ip || t('unknown')) + '</div>';
                }
                const lines = [];
                if (m.ip) lines.push('IP: ' + esc(m.ip));
                if (m.isp) lines.push('ISP: ' + esc(m.isp));
                if (m.asn) lines.push('AS: ' + esc(m.asn));
                const badges = Object.keys(m.statuses || {}).sort(function(a, b) { return parseInt(a, 10) - parseInt(b, 10); })
                    .map(c => '<span class="badge ' + statusClass(c) + '">' + esc(c) + '×' + Number(m.statuses[c]) + '</span>').join('');
                return '<div class="visitor-row" data-ip="' + esc(m.ip || '') + '"><div class="dot ' + (hasGeo ? 'geo' : 'nogeo') + '"></div><div class="info">' +
                    locHtml +
                    '<div class="detail">' + lines.join(' · ') + '</div>' +
                    (badges ? '<div class="badges">' + badges + '</div>' : '') +
                    '</div><div class="time-col"><div class="time-text">' + esc(formatTime(m.last_time)) + '</div><div class="count-text">' + t('times', {count: m.count}) + '</div></div></div>';
            }).join('');
        }

        function renderChips(statusCounts) {
            const bar = document.getElementById('filter-bar');
            if (!bar) return;
            const codes = Object.keys(statusCounts || {}).sort(function(a, b) { return parseInt(a, 10) - parseInt(b, 10); });
            var html = chipHtml('all', t('filter_all'), null);
            codes.forEach(function(c) {
                html += chipHtml(c, c, statusCounts[c]);
            });
            bar.innerHTML = html;
        }

        function chipHtml(status, label, cnt) {
            var active = currentStatus === status ? ' active' : '';
            var c = (cnt != null) ? '<span class="cnt">' + cnt + '</span>' : '';
            return '<button class="chip' + active + '" data-status="' + esc(status) + '">' + esc(label) + c + '</button>';
        }

        document.getElementById('filter-bar').addEventListener('click', function(e) {
            var btn = e.target.closest('.chip');
            if (!btn) return;
            currentStatus = btn.dataset.status;
            refresh();
        });

        document.getElementById('visitor-list').addEventListener('click', function(e) {
            if (e.target.closest('.time-col')) return;
            var row = e.target.closest('.visitor-row');
            if (!row || !row.dataset.ip) return;
            window.open('https://ipinfo.io/' + encodeURIComponent(row.dataset.ip), '_blank', 'noopener');
        });

        function esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

        // 自动刷新：页面不可见时暂停，避免后台挂机持续请求
        var refreshTimer = null;
        function startAutoRefresh() {
            if (refreshTimer) clearInterval(refreshTimer);
            refreshTimer = setInterval(function() { refresh(); }, 60000);
        }
        function stopAutoRefresh() {
            if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
        }
        document.addEventListener('visibilitychange', function() {
            if (document.hidden) stopAutoRefresh();
            else startAutoRefresh();
        });
        startAutoRefresh();
        // 前端切换语言后重拉数据(列表/统计使用 t() 动态渲染)
        document.addEventListener('languagechange', function() { refresh(); });
        // 页面能加载说明后端已放行（已登录），直接显示仪表盘
        showDashboard();
