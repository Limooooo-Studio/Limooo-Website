# Limooo

A Flask-based personal website and admin system running at [limooo.cn](https://limooo.cn). It features visitor geolocation analysis, automatic IP blocking, Apple ID password management, self-hosted authentik authentication, and is accelerated by Cloudflare CDN + HTTP/3.

## Features

- **Public pages**: Home, Services, Contact, Portfolio — with dark/light theme switching
- **Visitor panel** (`/visitor`): DNS-backed Pages Function + D1 analytics; shows a hashed visitor identifier (no raw IP), country, ISP/ASN where available, status-code distribution, and is login-protected
- After the first load, visitor status chips filter locally with no new `/api/visitors` request; the API still accepts `?status=<3-digit>` for deep links.
- **Apple ID manager** (`/appleid`): Pages Function + D1 CRUD with drag-and-drop ordering; passwords are stored encrypted with Fernet, the list shows only masked passwords, with temporary plaintext reveal
- **Auth & roles**: self-hosted [authentik](https://goauthentik.io) OIDC single sign-on, with admin (read-write) / viewer (read-only) roles split by group
- **Automatic IP blocking**:
  - Scans Nginx logs for malicious scan signatures (`/.env`, `/wp-admin`, `/actuator/`, etc.) and zero-tolerance bans the offending /24 subnet
  - Syncs to kernel-level `ipset` + `iptables` for network-layer drop
  - D1 `blocked_ips` is the authority; `sync-worker` mirrors active rows to a Cloudflare IP List for edge interception
  - Application-layer global filter as a fallback — banned IPs get a direct 403
- **GeoIP geolocation**: GeoLite2 database (city + ASN); place names shown in English
- **Unified redirect page** (`/r`): shows an interstitial on redirect.limooo.cn before redirecting to any HTTPS destination; when the target is limooo.cn it prefetches the homepage portfolio images (served via the `image.limooo.cn` watermark Worker) during the brief hold (~0.8s max) so they render instantly after the jump

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
│   ├── app.py             # VPS minimal runtime: backchannel logout, __gate_check, security headers
│   ├── config.py          # unified config: paths, languages, domains, DB/IP utils
│   ├── auto_block.py      # scans logs, writes blocklist.txt, syncs ipset + D1 (03:00; subcommands: ipset/d1/cf/sync, CF only in maintenance command cf)
│   └── build.py           # Pages static build (python3 src/build.py)
│   ├── static/            # static css/js/fonts + icons/portfolio/QR codes
│   └── templates/         # Jinja2 page templates
├── README.md              # this file
├── LICENSE.md             # AGPL-3.0
├── data/                  # runtime data (generated; git-ignored except blocklist.txt / whitelist.txt)
│   ├── blocklist.txt      # VPS 本地导入种子/可审计快照（D1 是唯一权威）
│   ├── whitelist.txt      # trusted ASNs (low-risk) + fully allowed IPs/CIDRs
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
│   ├── upload.sh          # compatibility entry point → deploy.sh
│   ├── pages_deploy.sh    # Cloudflare Pages build + deploy
│   ├── requirements.txt   # Python dependencies
│   ├── limooo.conf        # Nginx site configuration
│   ├── location-security.inc      # Nginx security hardening snippet
│   ├── limooo.service     # systemd service unit
│   ├── migrations/        # D1 schema migrations
│   ├── export_d1.py       # unified D1 import SQL/JSON export (appleid | blocklist)
│   └── sync-worker/       # Cloudflare Worker: daily D1 blocked_ips → IP List sync
├── functions/             # Cloudflare Pages Functions
│   ├── _middleware.ts     # gate/redirect/blocklist/visitors/ray 编排
│   ├── _lib/              # config, d1, cidr, gate, env, fernet, oidc, session
│   ├── _data/             # generated i18n/runtime modules (do not hand-edit)
│   ├── api/               # appleid, auth, i18n, ray, visitors endpoints
│   └── login*.ts / logout.ts
├── locales/               # i18n / translation catalogs
├── public/                # Pages build output (git keeps only .gitkeep)
├── preview/               # local preview (build-generated; git keeps only .gitkeep)
└── docs/                  # architecture plan status (workspace root, see ../docs)
```

## Quick start

```bash
# Install dependencies
pip install -r ops/requirements.txt

# Local development
python3 src/app.py
```

For a clean VS Code experience, install the recommended extensions (Jinja, Pylance)
listed in `.vscode/extensions.json`; workspace settings associate Jinja templates so
HTML/CSS/JS diagnostics do not misread template syntax.

Visit `http://localhost:8080` after starting locally. The admin dashboard and Apple ID manager require authentik auth to be configured first.

## Build, testing and deploy

For a clean local build, use the same dependency set as the deployment script:

```bash
cd Flask
npm ci
npm run build
```

`src/build.py` regenerates `public/<lang>/*.html`, `public/static/`,
`functions/_data/i18n.ts`, `functions/_data/runtime.ts` and `preview/`.
Do not hand-edit those outputs; change `locales/*.json`, templates or static
sources and rebuild. `src/static/tailwind.css` is the checked-in prebuilt
Tailwind output. `npm run build` uses `ops/build.sh`，会创建 `.venv-build`
并生成 `public/manifest.json`（构建产物哈希证据）。

Deploy only the Pages output with:

```bash
bash ops/pages_deploy.sh --verbose
```

只构建不部署：`bash ops/pages_deploy.sh --build-only`；预览命令：
`bash ops/pages_deploy.sh --dry-run` 与 `bash ops/deploy.sh --dry-run`。
`ops/deploy.sh` 默认不再自动 commit/push；需要时显式传 `--commit` / `--push`。
`ops/migrate_d1.sh` 和 `ops/workers_deploy.sh` 也支持 `--dry-run`。

Full VPS + Pages deployment is `bash ops/deploy.sh`; `ops/upload.sh` forwards
to it. Per current workspace rules, do not run deployment without explicit
confirmation.

Automated test entry points are provided (see docs/03):

```bash
python3 -m pytest
cd Flask && npm test
```

## Environment variables

Injected via `secrets/webauthn.env` (systemd `EnvironmentFile`), not committed to Git:

| Variable | Description |
| --- | --- |
| `AUTHENTIK_URL` | Public URL of the authentik instance (default `https://identity.limooo.cn`) |
| `AUTHENTIK_INTERNAL_URL` | Internal access URL (default `http://127.0.0.1:9000`; token requests go over the internal loopback) |
| `AUTHENTIK_PROVIDER_SLUG` | OIDC provider slug (default `visitor`) |
| `AUTHENTIK_CLIENT_ID` / `AUTHENTIK_CLIENT_SECRET` | authentik OIDC client credentials |
| `AUTHENTIK_ADMIN_GROUPS` | Comma-separated admin group names (default `authentik Admins`) |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | Cloudflare API credentials (blocklist sync) |
| `AUTHENTIK_JWKS_URL` | Optional JWKS URL; defaults to `${AUTHENTIK_URL}/application/o/visitor/jwks/` |
| `AUTHENTIK_PKCE_ENABLED` | Optional PKCE switch; set `false` only if authentik lacks PKCE support |
| `OBSERVABILITY_HMAC_KEY` | HMAC key used to hash visitor IPs for `visitors_v2` / `ray_log_v2` |
| `FLASK_SECRET_KEY` | Session signing key |
| `APPLEID_ENCRYPTION_KEY` | Apple ID password encryption key |

`secrets/flask_secret.key` and `secrets/appleid_encryption.key` are auto-generated by the app and migrated to `/etc/limooo/` (mode 600) at deploy time. Resolution order: environment variable > `/etc/limooo/` > project directory.

## Cron jobs

`ops/deploy.sh` sets up the following crontab entries after deployment:

| Time | Job |
| --- | --- |
| Daily 03:00 | `src/auto_block.py` scans logs and syncs VPS ipset + D1 |
| Daily 03:30 | `ops/sync-worker` Worker 从 D1 同步 active 行到 Cloudflare IP List |

## Deployment

To switch servers, just change `REMOTE_HOST` at the top of `ops/deploy.sh`, then:

```bash
./ops/deploy.sh
```

The script: rsyncs the code → installs missing dependencies (nginx/rsync/python3/ipset/docker) → migrates secrets → restarts the systemd service → deploys the Nginx config (incl. HTTP/3) → downloads GeoLite2 → writes the crontab.

## Security design

- Session cookies use `Secure` + `HttpOnly` + `SameSite=Lax`, bound to `.limooo.cn`;
  every session has a random `sid` recorded in D1 `auth_sessions`, and `requireAuth`
  rejects revoked/expired sessions. Missing runtime HMAC keys or an unavailable
  `auth_sessions` table fail closed with 503.
- Keys and ciphertext stored separately (`/etc/limooo/`, mode 600)
- Three layers of blocking: app-level 403 → kernel ipset/iptables → Cloudflare edge
- Nginx trusts only Cloudflare origin IPs, preventing forged `X-Real-IP` from bypassing blocks
- Admin writes (create/update/delete) require the admin role; viewer is read-only
- Allowlist: admins logging in from a blocked IP are auto-whitelisted to avoid false positives

## Whitelist

Trusted sources are maintained in [`data/whitelist.txt`](data/whitelist.txt), one entry per line:

| Entry | Effect |
| --- | --- |
| `ASN/<number>` | Low-risk source (China Telecom / China Mobile / China Unicom, incl. Tietong and backbone AS9929). Served a Cloudflare Non-Interactive Challenge (`js_challenge`) instead of the Turnstile gate. |
| `IP-CIDR/<ip>/<mask>` | Fully allowed source (e.g. `IP-CIDR/97.64.18.11/32`); skips both the blocklist and the challenge gate. |

The ASN list is sourced from [china-mainland-asn](https://github.com/xingpingcn/china-mainland-asn) (updated daily) and mirrored to the WAF low-risk `js_challenge` rule. Allowed IPs are mirrored to `functions/_data/gateTrust.ts` via `ops/check_gate_trust.py` and to a Cloudflare WAF skip rule.

## Source of truth

- User-facing strings: `locales/*.json`; `functions/_data/*` and API i18n routes are generated from it.
- Shared runtime constants: `config-contract.json` is the agreed cross-runtime contract; `src/config.py` and the generated `functions/_lib/config.ts` both consume it, with `ops/check_config_contract.py` enforcing agreement (docs/02).
- Gate/redirect copy: `locales/*.json` via `functions/_data/runtime.ts`; `src/build.py` assembles it.
- D1 schema and migrations: `ops/migrations/*.sql`; `blocked_ips` 是封禁唯一权威源。
- Security response headers baseline (when enabled): `ops/security-headers.json` (docs/05).
- Deployment and server boundaries: workspace `../AGENTS.md`.

## Cloudflare Pages migration (in progress)

limooo.cn is being migrated from the VPS (Flask + nginx) to Cloudflare Pages. During the transition the VPS keeps running; DNS is switched once Pages is stable.

New architecture:

| Layer | Technology |
| --- | --- |
| Edge / human verification | Pages Functions (`functions/_middleware.ts`) |
| Pages | Pre-rendered static HTML at build time (multi-language) |
| Data | D1 (visitor analytics, blocklist, Apple ID management) |
| Human verification | Cloudflare Turnstile |

### Build & directory layout

- `python3 src/build.py`: pre-renders the pages in 4 languages into `public/`, inlines
  `locales/*.json` as `functions/api/i18n/[lang].ts`, and generates shared
  `functions/_data/runtime.ts` (gate/redirect i18n + preload assets)
- `ops/migrations/001_init.sql`: D1 initial schema (`apple_accounts` / `blocked_ips` / `visitors`)
- `ops/export_d1.py`: generate D1 import SQL (output in `ops/out/`, git-ignored)
- `ops/migrations/007_visitor_status_indexes.sql`: adds `(status, ts)` and `(status, ip_hash, ts)` indexes for visitor status filtering
- `ops/sync-worker/`: a daily 03:30 Worker cron syncs active D1 `blocked_ips` rows to the Cloudflare IP List; `auto_block.py cf` 仅供显式维护
- Note: Pages now exposes `POST /logout/backchannel` and revokes D1 `auth_sessions`
  by `sub`; the legacy Flask `/logout/backchannel` remains for existing authentik
  configuration until the provider URL is switched or mirrored.

### Environment variables

Configured under **Pages project settings → Environment variables → Encrypt (Secret)**, not committed to the repo:

| Variable | Purpose |
| --- | --- |
| `TURNSTILE_SITEKEY` | Public sitekey of the Turnstile widget on the gate page |
| `TURNSTILE_SECRET` | Server-side siteverify secret |
| `GATE_HMAC_KEY` | HMAC-SHA256 signing key for the `__gate` cookie (`openssl rand -hex 32`) |
| `AUTHENTIK_URL` | Public authentik URL (default `https://identity.limooo.cn`) |
| `AUTHENTIK_CLIENT_ID` / `AUTHENTIK_CLIENT_SECRET` | authentik OIDC client (reuses the existing one) |
| `AUTHENTIK_ADMIN_GROUPS` | Admin group (default `authentik Admins`) |
| `SESSION_HMAC_KEY` | Pages session-cookie signing key (separate from `GATE_HMAC_KEY`) |
| `AUTHENTIK_JWKS_URL` | Optional JWKS URL for ID Token / logout token verification |
| `AUTHENTIK_PKCE_ENABLED` | Optional PKCE toggle (default enabled) |
| `APPLEID_ENCRYPTION_KEY` | Fernet key (from `secrets/appleid_encryption.key`, shared with the Flask side) |

Local development: copy `.dev.vars.example` to `.dev.vars` and fill in real values (git-ignored). Configure `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` for `ops/sync-worker` via `wrangler secret put`.

### Gate behavior

Every request is checked for the signed `__gate` cookie. Cloudflare `botManagement.verifiedBot` is accepted as a verified search-engine trust signal; arbitrary `Googlebot`/`GPTBot` User-Agent strings and client-supplied `cf_clearance` cookies no longer bypass the gate. Low-risk China Telecom / Mobile / Unicom ASNs are still handled by the Cloudflare WAF `js_challenge` tier, but edge code only trusts the generated whitelist (`data/whitelist.txt` → `functions/_data/gateTrust.ts`) for IP/full bypass. Unverified requests are 302-redirected to `auth.limooo.cn/__gate`; after Turnstile success a 1h cookie (`Domain=.limooo.cn`, shared across subdomains) is issued and the visitor returns via `redirect.limooo.cn/?to=...`. The middleware also enforces the normalized D1 blocklist and records privacy-minimized visitor analytics. The gate page is `no-store`/`noindex` and supports dark/light theme switching.

### Page serving (clean URLs, no language path prefix)

`src/build.py` pre-renders `public/<lang>/` in 4 languages; after the gate passes, the middleware picks a language by **cookie > Accept-Language > CF region > en-US** and fetches the matching page via `env.ASSETS.fetch()`, keeping the URL clean:

- `limooo.cn/` → home page; `limooo.cn/services` / `limooo.cn/contact` → corresponding pages
- `services.limooo.cn/` → services page; `contact.limooo.cn/` → contact page (subdomains serve content directly, no 301 to the main site)
- `www.limooo.cn` → 301 to the main site (preserving the former nginx behavior)
- Nav links keep absolute subdomain URLs (`https://services.limooo.cn` etc.); language switching is a pure frontend `applyLang()`, no reload, no URL change

### Migration progress

Done:

1. Pages project (`limooo`, `limooo.pages.dev`) and D1 database (`limooo`, APAC) created; D1 binding `DB` attached to the project
2. `ops/migrations/001_init.sql` executed; `ops/out/appleid.sql` (5 rows) was imported; the 1255-row `blocklist.sql` snapshot exists, but the user decided not to restore it; production `blocked_ips` stays at 0 and will be rebuilt only from new evidence
3. Secrets configured: `TURNSTILE_SITEKEY` / `TURNSTILE_SECRET` (Turnstile widget in Managed mode; domain must include `auth.limooo.cn`), `GATE_HMAC_KEY` / `SESSION_HMAC_KEY` (`openssl rand -hex 32`), `AUTHENTIK_*`, `APPLEID_ENCRYPTION_KEY`
4. Deployed to Pages and verified live: root path 403 gate page + `Cache-Control: no-store`, logo 200, `/__gate/verify` re-renders on failure, Location/IP/Ray ID diagnostics OK; full chain tested with Turnstile test keys (submit → siteverify → issue cookie → page served), forged cookies are rejected
5. WAF custom rules live: `ip.src in $limooo_blocklist` → block
6. **DNS switched**: `limooo.cn` / `www` / `services` / `contact` / `auth` / `visitor` / `appleid` / `redirect` → CNAME `limooo.pages.dev` (proxied), all custom domains active; `identity` / `xmpp` keep server A records; `*.limooo.cn` wildcard A kept as fallback; `image.limooo.cn` is the watermark Worker, while `images.limooo.cn` is the static origin / favicon / alpha asset host (URLs have no `/static` prefix, e.g. `https://images.limooo.cn/portfolio/IMG_0203.webp`)
7. The gate is hosted at `auth.limooo.cn` (former `verify.limooo.cn` retired); subdomains serve content directly with no `/zh-CN/` language prefix; unverified requests keep the original host and path on the gate page and return to it after passing
8. **visitor / appleid / redirect migrated to Pages**: visitor (analytics) and appleid (Apple ID manager) share the same Pages Functions (login / API / D1) with the main site; `redirect.limooo.cn` is a pure relay page **exempt from human verification** (to avoid a redirect loop after verification)
9. **identity stays on the VPS**: it runs authentik (self-hosted Docker OIDC IdP), which Pages cannot replace; the VPS nginx still applies `auth_request` human verification to it

Production state (2026-08-27):

- `007_visitor_status_indexes.sql` verified present on production D1.
- VPS `limooo` / `nginx` active; Nginx config test passes.
- Pages Functions and static assets deployed; OIDC `/login` uses
  `/application/o/authorize/` and provider slug `visitor`.
- The historical 1255-entry blocklist is **not** restored; backup remains archive only.
- Remaining: Safari visitor-filter smoke test and authentik client-secret rotation.

## License

[GNU AGPL v3.0](LICENSE.md)
