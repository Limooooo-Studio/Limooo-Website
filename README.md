> **2026-09-17 起：已全部迁至 Cloudflare 边缘并退租 VPS。**
> VPS 上曾运行的 Flask/nginx/authentik/Uptime Kuma 均已停用；
> 登录改为 Cloudflare Access；状态页与探针见 `ops/status-worker`。
> 迁移过程、决策与踩坑见 `../docs/17-zero-vps-migration.md` 与 `../docs/18-resume.md`。

# Limooo

A fully serverless personal website and admin system running at [limooo.cn](https://limooo.cn). Public pages, the human-verification gate, the visitor panel, the Apple Account manager, monitoring and the status page all run on Cloudflare (Pages Functions, Workers, D1, R2).

## Features

- **Public pages**: Home, Services, Contact, Portfolio — pre-rendered in 4 languages with dark/light theme switching
- **Human verification**: the Turnstile gate page is rendered **in place** at the requested URL (no cross-domain hop) on every host — see [Gate behavior](#gate-behavior)
- **Visitor panel** (`visitor.limooo.cn`): Pages Function + D1 analytics; shows a hashed visitor identifier (no raw IP in list APIs), country, ISP/ASN where available, status-code distribution, and is login-protected
- After the first load, visitor status chips filter locally with no new `/api/visitors` request; the API still accepts `?status=<3-digit>` for deep links.
- **Apple Account manager** (`account.limooo.cn/apple`): Pages Function + D1 CRUD with drag-and-drop ordering; passwords are stored encrypted with Fernet, the list shows only masked passwords, with temporary plaintext reveal
- **Auth & roles**: Cloudflare Access is the sole identity source; the Worker self-verifies the Access JWT and maps AUD → admin (read-write) / viewer (read-only)
- **Monitoring**: the `limooo-status` Worker probes HTTP/D1 targets every minute, re-checks every 10s while a probe is down, and stores results in D1; alerts go out over a webhook (Email binding as fallback)
- **Status page** (`status.limooo.cn`): server-rendered from D1 by the same Worker, with per-day uptime taken from the `probe_uptime_daily` rollup
- **Automatic IP blocking**:
  - D1 `blocked_ips` is the authority; `sync-worker` mirrors active rows to a Cloudflare IP List for edge interception (no origin, so no ipset/iptables)
  - Application-layer global filter as a fallback — banned IPs get a direct 403
- **Unified redirect page** (`redirect.limooo.cn/?to=<https-url>`, `/r` also accepted): shows an interstitial before redirecting to any HTTPS destination
- **Portfolio image handling**: originals are never published; only watermarked full images (`image.limooo.cn/portfolio/*`) and clean thumbnails are public

## Tech stack

| Layer | Technology | Runs on |
| --- | --- | --- |
| Public pages, gate, visitor panel, Apple Account manager, status page | Pages Functions (`functions/`) + pre-rendered static HTML | Cloudflare edge |
| Data | D1 (visitor analytics, blocklist, Apple Account accounts, auth sessions, probes/heartbeats) | Cloudflare |
| Human verification | Cloudflare Turnstile, gate page rendered in place | Cloudflare + browser |
| Auth | Cloudflare Access (Zero Trust JWT, self-verified by the Worker) | Cloudflare |
| Monitoring & retention | `ops/status-worker` (Cron Triggers + Durable Object alarms) | Cloudflare Workers |
| Blocklist sync | `ops/sync-worker` (daily cron → Cloudflare IP List) | Cloudflare Workers |
| Image watermarking | `ops/image-watermark` (path-normalizing proxy) | Cloudflare Workers |
| Static assets / originals backup | Pages asset server + private R2 bucket `limooo-originals` | Cloudflare |
| Deployment | `ops/deploy.sh` (git + `ops/pages_deploy.sh` + `ops/workers_deploy.sh`) | local |

## Project structure

```
├── src/
│   ├── app.py             # legacy VPS runtime (backchannel logout, __gate_check, security headers); no longer deployed
│   ├── config.py          # unified config: paths, languages, domains, DB/IP utils (consumes config-contract.json)
│   ├── auto_block.py      # legacy log scan + blocklist sync (no origin host to scan any more; kept for reference)
│   ├── render_app.py      # build-time read-only renderer used by src/build.py
│   ├── build.py           # Pages static build (python3 src/build.py)
│   ├── static/            # static css/js/fonts + icons/portfolio/QR codes
│   └── templates/         # Jinja2 page templates
├── README.md              # this file
├── LICENSE.md             # AGPL-3.0
├── data/                  # runtime data (generated; git-ignored except blocklist.txt / whitelist.txt)
│   ├── blocklist.txt      # auditable snapshot of D1 blocked_ips (D1 is the sole authority)
│   ├── whitelist.txt      # trusted ASNs (low-risk) + fully allowed IPs/CIDRs
│   └── gate_trust.json    # generated gate trust config
├── secrets/               # secrets & certificates, git-ignored
│   ├── webauthn.env       # env file read by the deploy scripts
│   ├── flask_secret.key   # legacy session signing key
│   └── apple_account_encryption.key     # Apple Account password encryption key
├── ops/                   # deployment & ops tooling
│   ├── deploy.sh          # full deploy entry point (git commit/push + Pages + Worker)
│   ├── upload.sh          # compatibility entry point → deploy.sh
│   ├── build.sh           # Pages build: venv, contract checks, public/manifest.json
│   ├── pages_deploy.sh    # Cloudflare Pages build + Wrangler deploy
│   ├── ci_check.sh        # local replica of .github/workflows/tests.yml
│   ├── security-headers.json      # single source of the response-header baseline
│   ├── check_config_contract.py / check_gate_trust.py / check_security_headers.py
│   ├── migrations/        # D1 schema migrations
│   ├── export_d1.py       # unified D1 import SQL/JSON export (apple-account | blocklist)
│   ├── prune_d1.py        # legacy D1 retention script (live retention now runs in status-worker)
│   ├── upload_originals.sh        # private R2 backup of portfolio originals
│   ├── status-worker/     # Worker: probes, status page, alerting, D1 retention
│   ├── image-watermark/   # Worker: image.limooo.cn watermark normalizer
│   ├── d1-archive/        # D1 snapshot/archive Worker
│   ├── sync-worker/       # Worker: D1 blocked_ips → Cloudflare IP List (cron 03:30)
│   └── requirements.txt   # Python dependencies
├── functions/             # Cloudflare Pages Functions
│   ├── _middleware.ts     # gate/redirect/blocklist/visitors/ray orchestration
│   ├── _lib/              # config, d1, cidr, gate, access, session, fernet, routing
│   ├── _data/             # generated i18n/runtime modules (do not hand-edit)
│   ├── api/               # apple-account, auth, i18n, ray, visitors endpoints
│   ├── __gate/            # Turnstile verify entry point (/__gate/verify)
│   └── login.ts / logout.ts
├── locales/               # i18n / translation catalogs
├── public/                # Pages build output (git keeps only .gitkeep)
├── preview/               # local preview (build-generated; git keeps only .gitkeep)
└── docs/                  # architecture plan status (workspace root, see ../docs)
```

## Quick start

```bash
# Install dependencies
pip install -r ops/requirements.txt

# Build the static site locally
python3 src/build.py
```

For a clean VS Code experience, install the recommended extensions (Jinja, Pylance)
listed in `.vscode/extensions.json`; workspace settings associate Jinja templates so
HTML/CSS/JS diagnostics do not misread template syntax.

For a local preview of the generated site, build and open the output from `preview/`.

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
Tailwind output. `npm run build` uses `ops/build.sh`, which creates `.venv-build`
and generates `public/manifest.json` (build-artifact hash evidence).

Deploy only the Pages output with:

```bash
# 只构建 + 校验，不碰 Cloudflare
bash ops/pages_deploy.sh --build-only

# 构建 + 校验 + 部署 Pages + 冒烟（/_health 必须 200）
bash ops/pages_deploy.sh

# 完整部署：① commit ② push ③ Pages（AGENTS.md 的"完整部署"语义）
bash ops/deploy.sh --all
```

**零 VPS 版脚本（2026-09-17 重写）**：`ops/deploy.sh` 是完整部署入口，
`ops/pages_deploy.sh` 负责构建与 Pages，`ops/upload.sh` 只是 `deploy.sh` 的
兼容转发入口（不再各存一份逻辑）。所有脚本的 `--dry-run` 只打印计划、不写任何远端。

凭据从本机 `secrets/webauthn.env` 读取（不入库、不回显），已无 ssh / rsync / 远端
systemd 步骤。`ops/migrate_d1.sh` 与 `ops/workers_deploy.sh` 同样支持 `--dry-run`。

Per current workspace rules, do not run deployment without explicit confirmation.

Automated test entry points are provided (see docs/03):

```bash
# Python tests (the build virtualenv is created by ops/build.sh)
.venv-build/bin/python -m pytest

# Pages Functions, Workers and image-watermark tests
npm test
```

## Environment variables

Read from `secrets/webauthn.env` by the deploy scripts, not committed to Git. The Pages runtime has its own secret set (see the edge section below).

| Variable | Description |
| --- | --- |
| `GATE_HMAC_KEY` | HMAC-SHA256 key for the `__gate` cookie, minted and validated at the edge |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | Cloudflare API access for `ops/d1_client.py`, `ops/pages_deploy.sh` and `ops/workers_deploy.sh` |

Key material lives outside the repo; `apple_account_encryption.key` is the Fernet key
used for Apple Account passwords and the encrypted visitor IP column.

## Cron jobs

There is no VPS crontab any more (retired 2026-09-17). All scheduling now lives on
Cloudflare, as Worker Cron Triggers declared in each Worker's `wrangler.toml`:

| Schedule | Worker | Job |
| --- | --- | --- |
| `* * * * *` | `ops/status-worker` | HTTP/D1 probes every minute; a Durable Object alarm re-checks every 10s while a probe is down, and alerts on state change |
| `47 3 * * *` | `ops/status-worker` | D1 retention (`src/retention.ts`): prunes `ray_log_v2` (7d), `visitors_v2` / `visitor_rollups` (30d), `events` / `heartbeats` / `probe_uptime_daily` (90d) |
| `30 3 * * *` | `ops/sync-worker` | Mirrors active D1 `blocked_ips` rows to the Cloudflare IP List |

TLS certificates are issued and renewed by Cloudflare for the Pages custom domains,
so `acme.sh` is gone too. `ops/migrate_d1.sh` and `ops/workers_deploy.sh` are manual,
`--dry-run`-capable maintenance entry points.

## Deployment

There is no server to deploy to: the target is Cloudflare Pages (`limooo`) plus the
standalone Workers. From the repository root:

```bash
cd Flask
bash ops/deploy.sh --all        # commit + push + deploy Pages
bash ops/deploy.sh              # deploy Pages only (no commit / no push)
bash ops/deploy.sh --worker=status-worker   # deploy one standalone Worker
```

Credentials are read from the local `secrets/webauthn.env`; there are no ssh, rsync,
systemd or Nginx steps. See `../AGENTS.md` for the full deploy contract.

## Security design

- Session cookies use `Secure` + `HttpOnly` + `SameSite=Lax`, bound to `.limooo.cn`;
  every session has a random `sid` recorded in D1 `auth_sessions`, and `requireAuth`
  rejects revoked/expired sessions. Missing runtime HMAC keys or an unavailable
  `auth_sessions` table fail closed with 503.
- The gate fails closed too: with `TURNSTILE_SECRET`, `GATE_HMAC_KEY` or
  `SESSION_HMAC_KEY` empty, the edge answers 503 instead of rendering pages or
  issuing unsigned cookies.
- The `__gate` cookie is `<unix-expiry>.<HMAC-SHA256 hex>` (1h TTL, `HttpOnly`,
  `Domain=.limooo.cn`), minted and validated entirely at the edge.
- Identity comes from Cloudflare Access: the Worker self-verifies
  `Cf-Access-Jwt-Assertion` (RS256, JWKS cached 1h) and maps AUD → role. There is no
  self-hosted IdP and no custom login form.
- Keys and ciphertext stored separately, and never committed to the repository
- Blocking layers: app-level 403/Worker → Cloudflare WAF + IP List at the edge
- Admin writes (create/update/delete) require the admin role; viewer is read-only
- Visitor IPs are never returned by list APIs; the full IP is Fernet-encrypted in
  `visitor_rollups.ip_enc` and decrypted one row at a time for admins

## Whitelist

Trusted sources are maintained in [`data/whitelist.txt`](data/whitelist.txt), one entry per line:

| Entry | Effect |
| --- | --- |
| `ASN/<number>` | Low-risk source (China Telecom / China Mobile / China Unicom, incl. Tietong and backbone AS9929). Served a Cloudflare Non-Interactive Challenge (`js_challenge`) instead of the Turnstile gate. |
| `IP-CIDR/<ip>/<mask>` | Fully allowed source (e.g. `IP-CIDR/97.64.18.11/32`); skips both the blocklist and the challenge gate. |

The ASN list is sourced from [china-mainland-asn](https://github.com/xingpingcn/china-mainland-asn) (updated daily) and mirrored to the WAF low-risk `js_challenge` rule. Allowed IPs are mirrored to `functions/_data/gateTrust.ts` via `ops/check_gate_trust.py` and to a Cloudflare WAF skip rule.

Per-runtime trust: edge code only treats `IP-CIDR` entries as trusted
(`isGateTrustedIp` → `functions/_data/gateTrust.ts`). `ASN/` lines are mirrored to the
Cloudflare WAF `js_challenge` rule. After editing `data/whitelist.txt`, regenerate the edge
copy with a build (`bash ops/build.sh`, which runs `ops/check_gate_trust.py --emit`).

## Source of truth

- User-facing strings: `locales/*.json`; `functions/_data/*` and API i18n routes are generated from it.
- Shared runtime constants: `config-contract.json` is the agreed cross-runtime contract; `src/config.py` and the generated `functions/_lib/config.ts` both consume it, with `ops/check_config_contract.py` enforcing agreement (docs/02).
- Gate/redirect copy: `locales/*.json` via `functions/_data/runtime.ts`; `src/build.py` assembles it.
- D1 schema and migrations: `ops/migrations/*.sql`; `blocked_ips` is the sole authority for blocking.
- Security response headers baseline (when enabled): `ops/security-headers.json` (docs/05).
- Deployment and server boundaries: workspace `../AGENTS.md`.

## Cloudflare Pages runtime

The public site (home / services / contact, the gate, the visitor panel, the Apple Account manager, `images.limooo.cn` and the redirect relay) runs on Cloudflare Pages Functions, as do the status page and every scheduled job. DNS for the Pages hosts points at `limooo.pages.dev`.

Runtime split:

| Layer | Technology |
| --- | --- |
| Edge / human verification | Pages Functions (`functions/_middleware.ts`) |
| Pages | Pre-rendered static HTML at build time (multi-language) |
| Data | D1 (visitor analytics, blocklist, Apple Account management, auth sessions) |
| Human verification | Cloudflare Turnstile, gate page rendered in place |
| Independent Workers | `status.limooo.cn` (`limooo-status`: probes, status page, retention), `image.limooo.cn` (`image-watermark`), `limooo-blocklist-sync` |

### Build & directory layout

- `python3 src/build.py`: pre-renders the pages in 4 languages into `public/`, inlines
  `locales/*.json` as `functions/api/i18n/[lang].ts`, and generates shared
  `functions/_data/runtime.ts` (gate/redirect i18n + preload assets)
- `ops/migrations/001_init.sql`: D1 initial schema (`apple_accounts` / `blocked_ips` / `visitors`)
- `ops/export_d1.py`: generate D1 import SQL (output in `ops/out/`, git-ignored)
- `ops/migrations/007_visitor_status_indexes.sql`: adds `(status, ts)` and `(status, ip_hash, ts)` indexes for visitor status filtering
- `ops/sync-worker/`: a daily 03:30 Worker cron syncs active D1 `blocked_ips` rows to the Cloudflare IP List; `auto_block.py cf` is for explicit maintenance only
- Note: Pages exposes `POST /logout/backchannel` and revokes D1 `auth_sessions`
  by `sub`. The legacy Flask `/logout/backchannel` is no longer deployed.

### Environment variables

Configured under **Pages project settings → Environment variables → Encrypt (Secret)**, not committed to the repo:

| Variable | Purpose |
| --- | --- |
| `TURNSTILE_SITEKEY` | Public sitekey of the Turnstile widget on the gate page |
| `TURNSTILE_SECRET` | Server-side siteverify secret |
| `GATE_HMAC_KEY` | HMAC-SHA256 signing key for the `__gate` cookie (`openssl rand -hex 32`) |
| `ACCESS_TEAM_DOMAIN` | Cloudflare Access team domain; also the JWT `iss` used for verification |
| `ACCESS_ADMIN_AUDS` / `ACCESS_VIEWER_AUDS` | Comma-separated Access application AUD tags mapped to the admin / viewer role (admin wins) |
| `VISITOR_IP_KEY` | Fernet key for the encrypted full visitor IP column (`visitor_rollups.ip_enc`) |
| `SESSION_HMAC_KEY` | Pages session-cookie signing key (separate from `GATE_HMAC_KEY`) |
| `AUTHENTIK_JWKS_URL` | Optional JWKS URL for ID Token / logout token verification |
| `AUTHENTIK_PKCE_ENABLED` | Optional PKCE toggle (default enabled) |
| `APPLE_ACCOUNT_ENCRYPTION_KEY` | Fernet key (from `secrets/apple_account_encryption.key`, shared with the Flask side) |

Local development: copy `.dev.vars.example` to `.dev.vars` and fill in real values (git-ignored). Configure `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` for `ops/sync-worker` via `wrangler secret put`.

### Gate behavior

Every request is checked for the signed `__gate` cookie. Cloudflare `botManagement.verifiedBot` is accepted as a verified search-engine trust signal; arbitrary `Googlebot`/`GPTBot` User-Agent strings and client-supplied `cf_clearance` cookies do not bypass the gate. Low-risk China Telecom / Mobile / Unicom ASNs are handled by the Cloudflare WAF `js_challenge` tier, while edge code trusts only the generated whitelist (`data/whitelist.txt` → `functions/_data/gateTrust.ts`) for a full bypass.

Unverified requests get the Turnstile gate page **in place**: the host and path never change. The middleware renders `public/<lang>/auth.html` at the requested URL with status `403`, and `POST /__gate/verify` answers on that same origin with `Set-Cookie: __gate=…` (1h, `Domain=.limooo.cn`), after which the page reloads the original target. `auth.limooo.cn` is the gate host — it serves the same page at its own root (no 404, no redirect to the main site) and owns the `/__gate/config|diag|verify` endpoints — but it is no longer a redirect target.

Every host that renders the gate is served by the same edge code, so there is no second gate implementation to keep in sync.

The middleware also enforces the normalized D1 blocklist and records privacy-minimized visitor analytics. The gate page is `no-store`/`noindex` and supports dark/light theme switching. The Turnstile widget must list every host that renders it (the `limooo.cn` gate subdomains, including `auth`, `status`, `visitor`, `apple` and `images`).

### Page serving (clean URLs, no language path prefix)

`src/build.py` pre-renders `public/<lang>/` in 4 languages; after the gate passes, the middleware picks a language by **cookie > Accept-Language > CF region > en-US** and fetches the matching page via `env.ASSETS.fetch()`, keeping the URL clean:

- `limooo.cn/` → home page; `limooo.cn/services` / `limooo.cn/contact` → corresponding pages
- `services.limooo.cn/` → services page; `contact.limooo.cn/` → contact page (subdomains serve content directly, no 301 to the main site)
- `visitor.limooo.cn/` → visitor panel (login required); `account.limooo.cn/apple` → Apple Account manager (login required)
- `images.limooo.cn/` → portfolio gallery plus the favicon/logo/QR asset host; `image.limooo.cn/portfolio/<img>` → watermarked variant from the normalization Worker (its root 301s to `images.limooo.cn`)
- `www.limooo.cn` → 301 to the main site
- Nav links keep absolute subdomain URLs (`https://services.limooo.cn` etc.); language switching is a pure frontend `applyLang()`, no reload, no URL change

### Performance / edge caching

- `public/_routes.json` excludes `/static/*` and root static assets from Pages
  Functions, so CSS/JS/fonts are served directly by the Pages asset server.
- `public/_headers` gives versioned static assets a long browser cache with
  `stale-while-revalidate`; `public/_routes.json` and `_headers` are both
  generated by `src/build.py`.
- Verified public HTML is cached by language in the Pages Cache API for 300
  seconds, and responses advertise `public, s-maxage=300` with
  `Vary: Accept-Language`.
- First-party portfolio thumbnails and favicons use
  `images.limooo.cn/static/...` (static edge cache, bypasses Functions)
  instead of the watermark Worker; QR codes and externally hotlinked images
  still use `image.limooo.cn`.
- Portfolio originals are never published: `/static/portfolio/<img>` returns 404.
  Only clean thumbnails (`images.limooo.cn/static/portfolio/thumbs/<img>-<width>.{webp,avif}`)
  and the normalized, watermarked `/portfolio/<img>` on `image.limooo.cn` are public;
  originals stay in the git-ignored `src/static/portfolio/` and the private R2 bucket
  `limooo-originals` (`ops/upload_originals.sh`).
- Turnstile verification has a 3-second server-side timeout so Cloudflare
  challenge-platform incidents fail closed quickly instead of stalling users
  for up to 8 seconds.

### Production status

All of the following is live:

1. Pages project (`limooo`, `limooo.pages.dev`) and D1 database (`limooo`, APAC) created; D1 binding `DB` attached to the project
2. Migrations `001`–`015` applied; `ops/out/apple-account.sql` (5 rows) was imported; the 1255-row `blocklist.sql` snapshot exists, but the user decided not to restore it, so production `blocked_ips` stays at 0 and is rebuilt only from new evidence
3. Secrets configured under **Pages → Settings → Environment variables → Encrypt**: `TURNSTILE_SITEKEY` / `TURNSTILE_SECRET` (Turnstile widget in Managed mode; the domain list covers every host that renders it — the `limooo.cn` gate subdomains incl. `auth`, `status`, `visitor`, `account` and `images`), `GATE_HMAC_KEY` / `SESSION_HMAC_KEY`, the `ACCESS_*` AUD mappings, `APPLE_ACCOUNT_ENCRYPTION_KEY` and `VISITOR_IP_KEY`
4. Deployed to Pages and verified live: root path 403 gate page + `Cache-Control: no-store`, logo 200, `/__gate/verify` re-renders on failure, Location/IP/Ray ID diagnostics OK; forged cookies are rejected
5. WAF custom rules live: `ip.src in $limooo_blocklist` → block
6. **DNS**: `limooo.cn` / `www` / `services` / `contact` / `auth` / `visitor` / `account` / `images` / `redirect` → CNAME `limooo.pages.dev` (proxied), all custom domains active; `status.limooo.cn` is the `limooo-status` Worker and `image.limooo.cn` the watermark Worker, while `images.limooo.cn` is the static asset host; first-party pages reference `/static/...` paths (`https://images.limooo.cn/static/portfolio/thumbs/IMG_0203-800.webp`)
7. The gate lives at `auth.limooo.cn` and renders in place: subdomains serve content directly with no `/zh-CN/` language prefix, and unverified requests keep the original host and path
8. **visitor / apple / redirect run on Pages**: the visitor panel (analytics) and the Apple Account manager share the same Pages Functions (login / API / D1) with the main site; `redirect.limooo.cn` is a pure relay page **exempt from human verification** (to avoid a redirect loop after verification)
9. **No server remains**: authentik, Uptime Kuma, nginx and the Flask runtime were retired with the VPS on 2026-09-17; probes, the status page, alerting and D1 retention are handled by `ops/status-worker`

Production state (2026-09-26):

- Migrations verified present on production D1, including `007` indexes, `011` read-reduction rollups and `014` visitor IP encryption.
- Access is the only identity source; no self-hosted IdP and no custom login page.
- The gate renders in place on every host, and the gate page/logs show the real visitor IP.
- The historical 1255-entry blocklist is **not** restored; backup remains archive only.

## License

[GNU AGPL v3.0](LICENSE.md)|[GNU AGPL v3.0-简体中文](LICENSE_zh_CN.md)|[GNU AGPL v3.0-日本語](LICENSE_ja_JP.md)|[GNU AGPL v3.0-한국어](LICENSE_ko_KR.md)
