# Limooo

A Flask-based personal website and admin system running at [limooo.cn](https://limooo.cn). It features visitor geolocation analysis, automatic IP blocking, Apple ID password management, self-hosted authentik authentication, and is accelerated by Cloudflare CDN + HTTP/3.

## Features

- **Public pages**: Home, Services, Contact, Portfolio — with dark/light theme switching
- **Admin dashboard** (`/admin`): parses the Nginx `access.log`, shows visitor IP, country/city, ISP and ASN in real time; filterable by status code
- **Apple ID manager** (`/appleid`): full CRUD with drag-and-drop ordering; passwords are stored encrypted with Fernet, the list shows only masked passwords, with temporary plaintext reveal
- **Auth & roles**: self-hosted [authentik](https://goauthentik.io) OIDC single sign-on, with admin (read-write) / viewer (read-only) roles split by group
- **Automatic IP blocking**:
  - Scans Nginx logs for malicious scan signatures (`/.env`, `/wp-admin`, `/actuator/`, etc.) and zero-tolerance bans the offending /24 subnet
  - Syncs to kernel-level `ipset` + `iptables` for network-layer drop
  - Syncs to a Cloudflare IP List for edge interception on the CDN
  - Application-layer global filter as a fallback — banned IPs get a direct 403
- **GeoIP geolocation**: GeoLite2 database (city + ASN); place names shown in English
- **Unified redirect page** (`/r`): shows an interstitial on redirect.limooo.cn before redirecting to any HTTPS destination; when the target is limooo.cn it prefetches the homepage portfolio images during the brief hold (~0.8s max) so they render instantly after the jump

## Tech stack

| Layer | Technology |
| --- | --- |
| Web framework | Flask + Jinja2 + Tailwind CSS |
| WSGI server | Gunicorn (3 workers) |
| Reverse proxy | Nginx (HTTP/3 / QUIC) |
| CDN | Cloudflare (Origin CA cert, IP List blocking) |
| Auth | authentik (OIDC, self-hosted, Docker) |
| Database | SQLite (WAL mode, concurrency-safe across workers) |
| Geolocation | MaxMind GeoLite2 |
| Encryption | cryptography (Fernet) |
| Deployment | systemd + rsync (`ops/deploy.sh`) |

## Project structure

```
├── src/
│   ├── app.py             # Flask main app: routes, auth, API, block filter
│   ├── common.py          # path constants, DB connection, IP utilities
│   ├── auto_block.py      # scans logs, auto-bans malicious /24s, syncs to ipset + Cloudflare (cron daily 03:00; subcommands: ipset/cf/sync)
│   └── build.py           # Pages 静态化构建（python3 src/build.py）
│   ├── static/            # static assets (icons, portfolio, QR codes)
│   └── templates/         # Jinja2 page templates
├── README.md              # this file
├── LICENSE.md             # AGPL-3.0
├── data/                  # runtime data (generated; git-ignored except blocklist.txt)
│   ├── blocklist.txt      # list of banned /24 subnets
│   ├── geo_cache.db       # geolocation cache database
│   ├── appleid.db         # Apple ID business database (accounts + encrypted passwords)
│   └── GeoLite2-*.mmdb    # MaxMind GeoLite2 databases (city + ASN)
├── secrets/               # secrets & certificates, git-ignored
│   ├── webauthn.env       # env file injected via systemd EnvironmentFile
│   ├── flask_secret.key   # session signing key (migrated to /etc/limooo/ on deploy)
│   ├── appleid_encryption.key     # Apple ID password encryption key
│   └── origin-*.pem       # Cloudflare Origin CA certificate + private key
├── ops/                   # deployment & ops tooling
│   ├── deploy.sh          # one-command deployment script
│   ├── upload.sh          # quiet variant of deploy.sh
│   ├── pages_deploy.sh    # Cloudflare Pages 构建 + 部署
│   ├── requirements.txt   # Python dependencies
│   ├── limooo.conf        # Nginx site configuration
│   ├── location-security.inc      # Nginx security hardening snippet
│   ├── limooo.service     # systemd service unit
│   ├── migrations/        # D1 schema migrations
│   ├── export_*.py        # D1 导入 SQL/JSON 导出脚本
│   └── sync-worker/       # Cloudflare Worker：D1 blocked_ips → IP List 每日同步
├── functions/             # Cloudflare Pages Functions
├── locales/               # i18n / translation catalogs
├── public/                # Pages 构建产物（git 只保留 .gitkeep）
└── preview/               # 本地预览（构建生成，git 只保留 .gitkeep）
```

## Quick start

```bash
# Install dependencies
pip install -r ops/requirements.txt

# Local development
python3 src/app.py
```

Visit `http://localhost:8080` after starting locally. The admin dashboard and Apple ID manager require authentik auth to be configured first.

## Environment variables

Injected via `secrets/webauthn.env` (systemd `EnvironmentFile`), not committed to Git:

| Variable | Description |
| --- | --- |
| `AUTHENTIK_URL` | Public URL of the authentik instance (default `https://identity.limooo.cn`) |
| `AUTHENTIK_INTERNAL_URL` | Internal access URL (default `http://127.0.0.1:9000`; token requests go over the internal loopback) |
| `AUTHENTIK_PROVIDER_SLUG` | OIDC provider slug (default `limooo`) |
| `AUTHENTIK_CLIENT_ID` / `AUTHENTIK_CLIENT_SECRET` | authentik OIDC client credentials |
| `AUTHENTIK_ADMIN_GROUPS` | Comma-separated admin group names (default `authentik Admins`) |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | Cloudflare API credentials (blocklist sync) |
| `FLASK_SECRET_KEY` | Session signing key |
| `APPLEID_ENCRYPTION_KEY` | Apple ID password encryption key |

`secrets/flask_secret.key` and `secrets/appleid_encryption.key` are auto-generated by the app and migrated to `/etc/limooo/` (mode 600) at deploy time. Resolution order: environment variable > `/etc/limooo/` > project directory.

## Cron jobs

`ops/deploy.sh` sets up the following crontab entries after deployment:

| Time | Job |
| --- | --- |
| Daily 03:00 | `src/auto_block.py` scans logs and auto-bans malicious IPs |

## Deployment

To switch servers, just change `REMOTE_HOST` at the top of `ops/deploy.sh`, then:

```bash
./ops/deploy.sh
```

The script: rsyncs the code → installs missing dependencies (nginx/rsync/python3/ipset/docker) → migrates secrets → restarts the systemd service → deploys the Nginx config (incl. HTTP/3) → downloads GeoLite2 → writes the crontab.

## Security design

- Session cookies use `Secure` + `HttpOnly` + `SameSite=Lax`, bound to `.limooo.cn`
- Keys and ciphertext stored separately (`/etc/limooo/`, mode 600)
- Three layers of blocking: app-level 403 → kernel ipset/iptables → Cloudflare edge
- Nginx trusts only Cloudflare origin IPs, preventing forged `X-Real-IP` from bypassing blocks
- Admin writes (create/update/delete) require the admin role; viewer is read-only
- Allowlist: admins logging in from a blocked IP are auto-whitelisted to avoid false positives

## Cloudflare Pages 迁移（进行中）

limooo.cn 正在从 VPS（Flask + nginx）迁移到 Cloudflare Pages。过渡期 VPS 继续运行，Pages 稳定后切换 DNS。

新架构：

| 层 | 技术 |
| --- | --- |
| 边缘 / 人机门禁 | Pages Functions（`functions/_middleware.ts`） |
| 页面 | 构建时预渲染的静态 HTML（多语言） |
| 数据 | D1（访客前向统计、封禁名单、Apple ID 管理） |
| 人机验证 | Cloudflare Turnstile |

### 构建与目录

- `python3 src/build.py`：按 4 种语言预渲染三页到 `public/`，并把 `locales/*.json` 内联为 `functions/api/i18n/[lang].ts`
- `ops/migrations/001_init.sql`：D1 初始 schema（apple_accounts / blocked_ips / visitors）
- `ops/export_appleid.py`、`ops/export_blocklist.py`：生成 D1 导入 SQL（输出在 `ops/out/`，已 gitignore）
- `ops/sync-worker/`：每日 03:00 Cron 把 D1 `blocked_ips` 增量同步到 Cloudflare IP List（原 auto_block.py 的 CF 部分；ipset/iptables 已放弃）
- 注意：authentik backchannel logout 暂未移植到 Pages（`logout_events` 表随 VPS 保留）

### 环境变量

在 **Pages 项目设置 → Environment variables → Encrypt（Secret）** 里配置，不要放进仓库：

| 变量 | 用途 |
| --- | --- |
| `TURNSTILE_SITEKEY` | 验证页 Turnstile 组件的公开 sitekey |
| `TURNSTILE_SECRET` | 服务端 siteverify 校验密钥 |
| `GATE_HMAC_KEY` | `__gate` cookie 的 HMAC-SHA256 签名密钥（`openssl rand -hex 32`） |
| `AUTHENTIK_URL` | authentik 公网地址（默认 `https://identity.limooo.cn`） |
| `AUTHENTIK_CLIENT_ID` / `AUTHENTIK_CLIENT_SECRET` | authentik OIDC 客户端（复用现有） |
| `AUTHENTIK_ADMIN_GROUPS` | 管理员组（默认 `authentik Admins`） |
| `SESSION_HMAC_KEY` | Pages 会话 cookie 签名密钥（与 `GATE_HMAC_KEY` 分开） |
| `APPLEID_ENCRYPTION_KEY` | Fernet 密钥（取 `secrets/appleid_encryption.key`，与 Flask 端共用） |

本地开发：复制 `.dev.vars.example` 为 `.dev.vars` 填入真实值（已 gitignore）。`ops/sync-worker` 的 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 用 `wrangler secret put` 配置。

### 门禁行为

所有请求先检查 `__gate` cookie（HMAC-SHA256 签名）。未验证的请求 302 到专用验证子域 `auth.limooo.cn/__gate`（附原始主机与路径，Turnstile widget 只需允许该域名），验证页 `Cache-Control: no-store` 且带 `noindex`；Turnstile 通过后签发 24h cookie（`Domain=.limooo.cn`，跨子域有效）并经 `redirect.limooo.cn/?to=...` 回到原主机原路径。`/__gate/verify` 与 `/Limooo-xtext.webp` 放行，避免死循环。中间件同时做 D1 封禁名单拦截和访客前向统计埋点。验证页支持深浅切换（与主站共用 `localStorage.theme`）。

### 页面服务方式（干净 URL，无语言路径前缀）

`src/build.py` 按 4 种语言预渲染到 `public/<lang>/`；中间件在放行后按「cookie > Accept-Language > CF 地区 > en-US」选语言，用 `env.ASSETS.fetch()` 取对应语言页面内容，URL 保持干净：

- `limooo.cn/` → 首页；`limooo.cn/services` / `limooo.cn/contact` → 对应页
- `services.limooo.cn/` → 服务页；`contact.limooo.cn/` → 联系页（子域直接出内容，不 301 到主站）
- `www.limooo.cn` → 301 到主站（保留原 nginx 行为）
- 导航链接保留子域绝对地址（`https://services.limooo.cn` 等），语言切换为纯前端 `applyLang()`，不刷新不换 URL

### 迁移进度

已完成：

1. Pages 项目（`limooo`，`limooo.pages.dev`）与 D1 数据库（`limooo`，APAC）已创建，D1 绑定 `DB` 已挂到项目
2. `ops/migrations/001_init.sql` 已执行；`ops/out/appleid.sql`（5 条）、`blocklist.sql`（1255 条）已导入
3. Secret 已配置：`TURNSTILE_SITEKEY` / `TURNSTILE_SECRET`（Turnstile widget 为 Managed 模式、域名需含 `auth.limooo.cn`）、`GATE_HMAC_KEY` / `SESSION_HMAC_KEY`（`openssl rand -hex 32`）、`AUTHENTIK_*`、`APPLEID_ENCRYPTION_KEY`
4. 已部署到 Pages，线上验证：根路径 403 验证页 + `Cache-Control: no-store`、logo 200、`/__gate/verify` 失败重渲染、Location/IP/Ray ID 诊断正常；用 Turnstile 官方测试密钥跑通"提交 → siteverify → 签发 cookie → 放行页面"全链路，伪造 cookie 会被拒绝
5. WAF 自定义规则已生效：`ip.src in $limooo_blocklist` → block
6. **DNS 已切换**：`limooo.cn` / `www` / `services` / `contact` / `auth` / `visitor` / `appleid` / `redirect` → CNAME `limooo.pages.dev`（proxied），自定义域名全部 active；`identity` / `xmpp` 保持服务器 A 记录，`*.limooo.cn` 通配 A 保留作为兜底
7. 门禁托管在 `auth.limooo.cn`（原 `verify.limooo.cn` 已停用）；子域直接出内容、URL 无 `/zh-CN/` 语言前缀，未验证请求会在门禁页保留原始主机与路径并在通过后原路返回
8. **visitor / appleid / redirect 已迁到 Pages**：visitor（访客统计）、appleid（Apple ID 管理器）与主站共用同一套 Pages Functions（登录 / API / D1）；`redirect.limooo.cn` 作为纯中转跳转页**豁免人机验证**（避免验证后回跳死循环）
9. **identity 保留在 VPS**：它承载 authentik（OIDC 身份提供者，Docker 自托管），Pages 无法替代；VPS nginx 仍对其做 `auth_request` 人机验证

待完成（一个外部依赖）：

- **ops/sync-worker 部署**：需要给 API Token 加 `Workers Scripts: Edit`（含 triggers）权限后 `wrangler deploy`；在此之前服务器 `auto_block.py` 的 Cloudflare IP List 同步继续运行，WAF 规则照常生效

## License

[GNU AGPL v3.0](../LICENSE)
