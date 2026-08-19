# Limooo - Flask Web Application
#
# Copyright (C) 2026 Limooo <https://limooo.cn/>
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

# ============================================================
# 安全配置 — 由 deploy.sh 自动部署到 /etc/nginx/conf.d/
# 注意：IP 封禁已移至 Flask 层（app.py），支持动态白名单
# ============================================================

# ── 通用安全规则 ─────────────────────────────────────────
# 屏蔽恶意 User-Agent
if ($http_user_agent ~* (scrapy|libwww|httpclient|nmap|nikto|sqlmap|masscan|zgrab|gobuster|dirbuster|feroxbuster|nessus|burpsuite|owasp|pre-filter)) {
    return 444;
}

# 屏蔽非浏览器 UA(无 Mozilla 且非搜索引擎/合法自动化)
# $ua_deny 由 limooo.conf 顶部的 map 计算,1 = 非浏览器
if ($ua_deny) {
    return 403;
}

# 屏蔽对敏感路径的访问
location ~* ^/(\.env|\.git/|\.aws/|\.svn/|\.hg/|\.DS_Store|\.npmrc|config\.env) {
    deny all;
}

location ~* (wp-login|wp-admin|xmlrpc\.php|phpmyadmin|actuator|_profiler|composer\.json) {
    deny all;
}

location ~* \.(sql|bak|backup|old|swp|save|log|tar\.gz|zip|rar)$ {
    deny all;
}
