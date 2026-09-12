# Limooo

A Cloudflare Pages + Flask personal website and admin system running at [limooo.cn](https://limooo.cn). Public pages, the human-verification gate, visitor panel, and Apple ID manager run at the edge; Flask remains responsible for the VPS admin/status runtime. The project also provides visitor geolocation analysis, automatic IP blocking, self-hosted authentik authentication, and Cloudflare CDN + HTTP/3 acceleration.

## Features

- **Public pages**: Home, Services, Contact, Portfolio — pre-rendered in 4 languages with dark/light theme switching
- **Human verification**: the Turnstile gate page is rendered **in place** at the requested URL (no cross-domain hop) on every host — see [Gate behavior](#gate-behavior)
- **Visitor panel** (`visitor.limooo.cn`): Pages Function + D1 analytics; shows a hashed visitor identifier (no raw IP), country, ISP/ASN where available, status-code distribution, and is login-protected
- After the first load, visitor status chips filter locally with no new `/api/visitors` request; the API still accepts `?status=<3-digit>` for deep links.
- **Apple ID manager** (`apple.limooo.cn/account`): Pages Function + D1 CRUD with drag-and-drop ordering; passwords are stored encrypted with Fernet, the list shows only masked passwords, with temporary plaintext reveal
- **Auth & roles**: self-hosted [authentik](https://goauthentik.io) OIDC single sign-on, with admin (read-write) / viewer (read-only) roles split by group
- **Uptime Kuma monitoring**: embedded in the Authentik admin interface at the single entry `admin.limooo.cn`; MIT-licensed, free, multi-language i18n and dark mode; it probes `/_health` and receives hourly D1 health status via Push heartbeat
- **Health alert email**: `check_health.py` sends branded HTML email (logo, alert list, key metrics, CTA to `admin.limooo.cn`) with plain-text fallback; template is shared via `ops/email-templates/`
- **Kuma brand skin**: the embedded Kuma frontend uses the main-site design tokens (`#1b1b1f`/white, `#05A5A6`, Inter + Baloo 2) via the `Kuma-Fork` build; no separate admin subdomain is published
- **Kuma fork frontend**: the deployed admin UI is built from a 2.5.3 front-end fork (`Kuma-Fork/`, branch `limooo-ui`) and mounted into the existing container; monitor names and push alerts are translated based on the current user language without storing a default
- **Automatic IP blocking**:
  - Scans Nginx logs for malicious scan signatures (`/.env`, `/wp-admin`, `/actuator/`, etc.) and zero-tolerance bans the offending /24 subnet
  - Syncs to kernel-level `ipset` + `iptables` for network-layer drop
  - D1 `blocked_ips` is the authority; `sync-worker` mirrors active rows to a Cloudflare IP List for edge interception
  - Application-layer global filter as a fallback — banned IPs get a direct 403
- **GeoIP geolocation**: GeoLite2 database (city + ASN); place names shown in English
- **Unified redirect page** (`redirect.limooo.cn/?to=<https-url>`, `/r` also accepted): shows an interstitial before redirecting to any HTTPS destination; when the target is limooo.cn it prefetches the homepage portfolio thumbnails (served via the `images.limooo.cn` static edge cache) during the brief hold (~0.8s max) so they render instantly after the jump

## Tech stack

| Layer | Technology | Runs on |
| --- | --- | --- |
| Public pages, gate, visitor panel, Apple ID manager | Pages Functions (`functions/`) + pre-rendered static HTML | Cloudflare edge |
| Edge data | D1 (visitor analytics, blocklist, Apple ID accounts, auth sessions) | Cloudflare |
| Human verification | Cloudflare Turnstile, gate page rendered in place | Cloudflare + browser |
| Admin UI, status page, authentik IdP | Flask + Jinja2 + Tailwind CSS, Gunicorn (3 workers) | VPS `limooo` |
| Reverse proxy | Nginx (HTTP/3 / QUIC) | VPS `limooo` |
| CDN | Cloudflare (Origin CA cert, WAF rules, IP List blocking) | Cloudflare |
| Auth | authentik (OIDC, self-hosted, Docker) | VPS `limooo` |
| VPS database | SQLite (WAL mode, concurrency-safe across workers) | VPS `limooo` |
| Geolocation | MaxMind GeoLite2 (city + ASN) | VPS `limooo` |
| Encryption | cryptography (Fernet) for Apple ID passwords | VPS + edge |
| Deployment | `ops/deploy.sh` (rsync + systemd + Nginx) → `ops/pages_deploy.sh` (Wrangler) | local |

## Project structure

```
├── src/
│   ├── app.py             # VPS minimal runtime: backchannel logout, __gate_check, security headers
│   ├── config.py          # unified config: paths, languages, domains, DB/IP utils (consumes config-contract.json)
│   ├── auto_block.py      # scans logs, writes blocklist.txt, syncs ipset + D1 (subcommands: ipset/d1/cf/sync; the daily cron is currently disabled)
│   ├── render_app.py      # local preview renderer for build output
│   ├── build.py           # Pages static build (python3 src/build.py)
│   ├── static/            # static css/js/fonts + icons/portfolio/QR codes
│   └── templates/         # Jinja2 page templates
├── README.md              # this file
├── LICENSE.md             # AGPL-3.0
├── data/                  # runtime data (generated; git-ignored except blocklist.txt / whitelist.txt)
│   ├── blocklist.txt      # VPS local import seed / auditable snapshot (D1 is the sole authority)
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
│   ├── deploy.sh          # one-command deployment (rsync + systemd + Nginx → Pages)
│   ├── upload.sh          # compatibility entry point → deploy.sh
│   ├── build.sh           # Pages build: .venv-build/, contract checks, public/manifest.json
│   ├── pages_deploy.sh    # Cloudflare Pages build + Wrangler deploy
│   ├── limooo.conf        # Nginx site configuration (incl. the in-place gate proxy for VPS hosts)
│   ├── location-security.inc      # Nginx security hardening snippet
│   ├── limooo.service     # systemd service unit
│   ├── security-headers.json      # single source of the response-header baseline
│   ├── check_config_contract.py / check_gate_trust.py / check_security_headers.py
│   ├── migrations/        # D1 schema migrations
│   ├── export_d1.py       # unified D1 import SQL/JSON export (appleid | blocklist)
│   ├── prune_d1.py        # D1 retention (aggregate / prune)
│   ├── check_health.py    # hourly health probe + branded alert email
│   ├── upload_originals.sh        # private R2 backup of portfolio originals
│   ├── uptime-kuma/       # Uptime Kuma compose/bootstrap/init scripts
│   ├── image-watermark/   # Worker: image.limooo.cn watermark normalizer
│   ├── claude-webhook/    # status.limooo.cn Claude / Cloudflare notification receivers
│   ├── d1-archive/        # D1 snapshot/archive Worker
│   ├── sync-worker/       # Worker: D1 blocked_ips → Cloudflare IP List (cron 03:30)
│   └── requirements.txt   # Python dependencies
├── functions/             # Cloudflare Pages Functions
│   ├── _middleware.ts     # gate/redirect/blocklist/visitors/ray orchestration
│   ├── _lib/              # config, d1, cidr, gate, env, fernet, oidc, session
│   ├── _data/             # generated i18n/runtime modules (do not hand-edit)
│   ├── api/               # appleid, auth, i18n, ray, visitors endpoints
│   ├── __gate/            # Turnstile verify entry point (/__gate/verify)
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

Visit `http://localhost:8080` after starting locally. This runs the Flask/VPS runtime;
the public Pages site is previewed from the generated `public/` output. The admin
dashboard and Apple ID manager require authentik auth to be configured first.

Uptime Kuma is deployed on the VPS and served at `https://admin.limooo.cn`.
For first-time initialisation use `bash ops/uptime-kuma/bootstrap.sh` (credentials are written only to the server's `secrets/uptime-kuma.env`); for routine updates use `bash ops/uptime-kuma/deploy.sh`.

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
bash ops/pages_deploy.sh --verbose
```

Build-only (no deploy): `bash ops/pages_deploy.sh --build-only`; preview commands:
`bash ops/pages_deploy.sh --dry-run` and `bash ops/deploy.sh --dry-run`.
`ops/deploy.sh` no longer commits/pushes automatically by default; pass `--commit` / `--push` explicitly when needed.
`ops/migrate_d1.sh` and `ops/workers_deploy.sh` also support `--dry-run`.

Full VPS + Pages deployment is `bash ops/deploy.sh`; `ops/upload.sh` forwards
to it. Per current workspace rules, do not run deployment without explicit
confirmation.

Automated test entry points are provided (see docs/03):

```bash
# Python tests (the build virtualenv is created by ops/build.sh)
.venv-build/bin/python -m pytest

# Pages Functions, Workers and image-watermark tests
npm test
```

## Environment variables

Injected via `secrets/webauthn.env` (systemd `EnvironmentFile=-/var/www/limooo/secrets/webauthn.env`), not committed to Git. The Pages runtime has its own secret set (see the edge section below).

| Variable | Description |
| --- | --- |
| `GATE_HMAC_KEY` | HMAC-SHA256 key for the `__gate` cookie; the VPS `__gate_check` validates cookies minted at the edge, so both runtimes must share this key |
| `AUTHENTIK_URL` / `AUTHENTIK_INTERNAL_URL` / `AUTHENTIK_PROVIDER_SLUG` / `AUTHENTIK_CLIENT_ID` | authentik endpoints and OIDC client used by the backchannel-logout callback (code defaults exist) |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | Cloudflare API access for `ops/d1_client.py`, `src/auto_block.py`, `ops/pages_deploy.sh` and `ops/workers_deploy.sh` |
| `CLAUDE_WEBHOOK_TOKEN` | Random 32–256 char token; `ops/deploy.sh` renders it into `/etc/nginx/webhook-secret.inc` for the `status.limooo.cn` Claude / Cloudflare webhook receivers |
| `HEALTH_ALERT_COOLDOWN_SECONDS`, `HEALTH_GATE_*`, `HEALTH_LOGIN_FAILURE_RATE_THRESHOLD`, `HEALTH_VISITOR_DROP_*` | Optional thresholds for `ops/check_health.py` |
| `AUTHENTIK_CLIENT_SECRET`, `REST_COUNTRIES_KEY`, `GEONAMES_USERNAME`, `LIBRETRANSLATE_URL`, `ENTRA_CLIENT_SECRET` | Legacy secrets that `ops/deploy.sh` seeds when missing; the current minimal VPS runtime does not read them |

Key material lives outside the repo: `flask_secret.key` and `appleid_encryption.key` are generated by the app and migrated to `/etc/limooo/` (mode 600) at deploy time. Resolution order: `FLASK_SECRET_KEY` / `APPLEID_ENCRYPTION_KEY` environment variable > `/etc/limooo/` > project `secrets/`.

## Cron jobs

VPS crontab (root) as currently deployed on `limooo`:

| Time | Job |
| --- | --- |
| Hourly at :17 | `ops/check_health.py` probes the services/D1 and emails a branded alert on failure |
| Hourly at :23 | `ops/prune_d1.py --mode aggregate --apply` rolls visitor/Ray rows up |
| Daily 03:47 | `ops/prune_d1.py --mode prune --apply` enforces D1 retention |
| 04:13 / 10:13 / 16:13 / 22:13 | `acme.sh --cron` renews certificates |
| *(disabled)* | `src/auto_block.py` log scan + ipset/D1 sync — commented out since the 2026-08-20 blocklist reset; `ops/deploy.sh` only adds this entry when `auto_block.py` is absent from the crontab, so the commented line stays as is |

Cloudflare side: the `ops/sync-worker` Worker has its own cron (`30 3 * * *` in `ops/sync-worker/wrangler.toml`) and mirrors active D1 `blocked_ips` rows to the Cloudflare IP List. `ops/migrate_d1.sh` and `ops/workers_deploy.sh` are manual, `--dry-run`-capable maintenance entry points.

## Deployment

The deployment target is the VPS SSH alias `limooo`. From the repository root:

```bash
cd Flask
bash ops/deploy.sh
```

The script: rsyncs the code to `limooo` → installs missing dependencies
(nginx/rsync/python3/ipset/docker) → migrates secrets → restarts the systemd
service → deploys the Nginx config (including HTTP/3) → downloads GeoLite2 →
updates the VPS jobs → deploys Cloudflare Pages. It does not commit or push by
default; use `--commit --push` only when the complete deployment is intended.

## Security design

- Session cookies use `Secure` + `HttpOnly` + `SameSite=Lax`, bound to `.limooo.cn`;
  every session has a random `sid` recorded in D1 `auth_sessions`, and `requireAuth`
  rejects revoked/expired sessions. Missing runtime HMAC keys or an unavailable
  `auth_sessions` table fail closed with 503.
- The gate fails closed too: with `TURNSTILE_SECRET`, `GATE_HMAC_KEY` or
  `SESSION_HMAC_KEY` empty, the edge answers 503 instead of rendering pages or
  issuing unsigned cookies.
- The `__gate` cookie is `<unix-expiry>.<HMAC-SHA256 hex>` (1h TTL, `HttpOnly`,
  `Domain=.limooo.cn`). Pages mints it and the VPS `__gate_check` validates it with the
  same `GATE_HMAC_KEY`.
- `X-Limooo-Client-IP` / `X-Limooo-Client-Country` are set by Nginx when it proxies the
  gate page for VPS-served hosts so the page and its event logs show the real visitor
  instead of the VPS egress. They are display/log only — trust decisions always use
  Cloudflare's own `CF-Connecting-IP` / `cf.country`.
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

Per-runtime trust: edge code only treats `IP-CIDR` entries as trusted
(`isGateTrustedIp` → `functions/_data/gateTrust.ts`). `ASN/` lines are mirrored to the
Cloudflare WAF `js_challenge` rule and are also honoured by the VPS `__gate_check`
(Flask receives `CF-ASN` there). After editing `data/whitelist.txt`, regenerate the edge
copy with a build (`bash ops/build.sh`, which runs `ops/check_gate_trust.py --emit`).

## Source of truth

- User-facing strings: `locales/*.json`; `functions/_data/*` and API i18n routes are generated from it.
- Shared runtime constants: `config-contract.json` is the agreed cross-runtime contract; `src/config.py` and the generated `functions/_lib/config.ts` both consume it, with `ops/check_config_contract.py` enforcing agreement (docs/02).
- Gate/redirect copy: `locales/*.json` via `functions/_data/runtime.ts`; `src/build.py` assembles it.
- D1 schema and migrations: `ops/migrations/*.sql`; `blocked_ips` is the sole authority for blocking.
- Security response headers baseline (when enabled): `ops/security-headers.json` (docs/05).
- Deployment and server boundaries: workspace `../AGENTS.md`.

## Cloudflare Pages runtime

The public site (home / services / contact, the gate, the visitor panel, the Apple ID manager, `images.limooo.cn` and the redirect relay) runs on Cloudflare Pages Functions; the VPS keeps the admin entry, the authentik IdP and the status page. DNS for the Pages hosts points at `limooo.pages.dev`.

Runtime split:

| Layer | Technology |
| --- | --- |
| Edge / human verification | Pages Functions (`functions/_middleware.ts`) |
| Pages | Pre-rendered static HTML at build time (multi-language) |
| Data | D1 (visitor analytics, blocklist, Apple ID management, auth sessions) |
| Human verification | Cloudflare Turnstile, gate page rendered in place |
| VPS hosts | `admin.limooo.cn` (authentik + embedded Kuma), `status.limooo.cn` (Kuma status page + Claude/Cloudflare webhook receivers), `identity.limooo.cn` (301 → admin) |

### Build & directory layout

- `python3 src/build.py`: pre-renders the pages in 4 languages into `public/`, inlines
  `locales/*.json` as `functions/api/i18n/[lang].ts`, and generates shared
  `functions/_data/runtime.ts` (gate/redirect i18n + preload assets)
- `ops/migrations/001_init.sql`: D1 initial schema (`apple_accounts` / `blocked_ips` / `visitors`)
- `ops/export_d1.py`: generate D1 import SQL (output in `ops/out/`, git-ignored)
- `ops/migrations/007_visitor_status_indexes.sql`: adds `(status, ts)` and `(status, ip_hash, ts)` indexes for visitor status filtering
- `ops/sync-worker/`: a daily 03:30 Worker cron syncs active D1 `blocked_ips` rows to the Cloudflare IP List; `auto_block.py cf` is for explicit maintenance only
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
| `AUTHENTIK_URL` | Public authentik URL (default `https://admin.limooo.cn`); ID Token issuer is validated as `${AUTHENTIK_URL}/application/o/visitor/` |
| `AUTHENTIK_CLIENT_ID` / `AUTHENTIK_CLIENT_SECRET` | authentik OIDC client (reuses the existing one) |
| `AUTHENTIK_ADMIN_GROUPS` | Admin group (default `authentik Admins`) |
| `SESSION_HMAC_KEY` | Pages session-cookie signing key (separate from `GATE_HMAC_KEY`) |
| `AUTHENTIK_JWKS_URL` | Optional JWKS URL for ID Token / logout token verification |
| `AUTHENTIK_PKCE_ENABLED` | Optional PKCE toggle (default enabled) |
| `APPLEID_ENCRYPTION_KEY` | Fernet key (from `secrets/appleid_encryption.key`, shared with the Flask side) |

Local development: copy `.dev.vars.example` to `.dev.vars` and fill in real values (git-ignored). Configure `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` for `ops/sync-worker` via `wrangler secret put`.

### Gate behavior

Every request is checked for the signed `__gate` cookie. Cloudflare `botManagement.verifiedBot` is accepted as a verified search-engine trust signal; arbitrary `Googlebot`/`GPTBot` User-Agent strings and client-supplied `cf_clearance` cookies do not bypass the gate. Low-risk China Telecom / Mobile / Unicom ASNs are handled by the Cloudflare WAF `js_challenge` tier, while edge code trusts only the generated whitelist (`data/whitelist.txt` → `functions/_data/gateTrust.ts`) for a full bypass.

Unverified requests get the Turnstile gate page **in place**: the host and path never change. The middleware renders `public/<lang>/auth.html` at the requested URL with status `403`, and `POST /__gate/verify` answers on that same origin with `Set-Cookie: __gate=…` (1h, `Domain=.limooo.cn`), after which the page reloads the original target. `auth.limooo.cn` is the gate host — it serves the same page at its own root (no 404, no redirect to the main site) and owns the `/__gate/config|diag|verify` endpoints — but it is no longer a redirect target.

VPS-served hosts share that gate. Nginx runs `auth_request /__gate_check` (Flask: whitelist or signed cookie) and, when it answers 403, reverse-proxies the edge gate page at the original URL (`location @gate_render`) and proxies `/__gate/*` to `auth.limooo.cn`, so Turnstile verification and cookie minting stay implemented only in Pages. Nginx forwards `X-Limooo-Client-IP` / `X-Limooo-Client-Country` so the gate page, its diagnostics and its event logs show the real visitor rather than the VPS egress (display/log only — never used for trust).

The middleware also enforces the normalized D1 blocklist and records privacy-minimized visitor analytics. The gate page is `no-store`/`noindex` and supports dark/light theme switching. The Turnstile widget must list every host that renders it (the `limooo.cn` gate subdomains, including `auth`, `status`, `visitor`, `apple` and `images`).

### Page serving (clean URLs, no language path prefix)

`src/build.py` pre-renders `public/<lang>/` in 4 languages; after the gate passes, the middleware picks a language by **cookie > Accept-Language > CF region > en-US** and fetches the matching page via `env.ASSETS.fetch()`, keeping the URL clean:

- `limooo.cn/` → home page; `limooo.cn/services` / `limooo.cn/contact` → corresponding pages
- `services.limooo.cn/` → services page; `contact.limooo.cn/` → contact page (subdomains serve content directly, no 301 to the main site)
- `visitor.limooo.cn/` → visitor panel (login required); `apple.limooo.cn/account` → Apple ID manager (login required), while `appleid.limooo.cn` 301s to `apple.limooo.cn/account`
- `images.limooo.cn/` → portfolio gallery plus the favicon/logo/QR asset host; `image.limooo.cn/portfolio/<img>` → watermarked variant from the normalization Worker (its root 301s to `images.limooo.cn`)
- `www.limooo.cn` → 301 to the main site (preserving the former nginx behavior)
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

Done:

1. Pages project (`limooo`, `limooo.pages.dev`) and D1 database (`limooo`, APAC) created; D1 binding `DB` attached to the project
2. `ops/migrations/001_init.sql` executed; `ops/out/appleid.sql` (5 rows) was imported; the 1255-row `blocklist.sql` snapshot exists, but the user decided not to restore it; production `blocked_ips` stays at 0 and will be rebuilt only from new evidence
3. Secrets configured: `TURNSTILE_SITEKEY` / `TURNSTILE_SECRET` (Turnstile widget in Managed mode; the domain list must cover every host that renders the widget — the `limooo.cn` gate subdomains incl. `auth`, `status`, `visitor`, `apple` and `images`), `GATE_HMAC_KEY` / `SESSION_HMAC_KEY` (`openssl rand -hex 32`), `AUTHENTIK_*`, `APPLEID_ENCRYPTION_KEY`
4. Deployed to Pages and verified live: root path 403 gate page + `Cache-Control: no-store`, logo 200, `/__gate/verify` re-renders on failure, Location/IP/Ray ID diagnostics OK; full chain tested with Turnstile test keys (submit → siteverify → issue cookie → page served), forged cookies are rejected
5. WAF custom rules live: `ip.src in $limooo_blocklist` → block
6. **DNS switched**: `limooo.cn` / `www` / `services` / `contact` / `auth` / `visitor` / `apple` (+ the legacy `appleid` alias) / `images` / `redirect` → CNAME `limooo.pages.dev` (proxied), all custom domains active; `identity` / `xmpp` keep server A records; `status` / `admin` keep pointing at the VPS origin behind Cloudflare; `image.limooo.cn` is the watermark Worker while `images.limooo.cn` is the static asset host; first-party pages reference `/static/...` paths (`https://images.limooo.cn/static/portfolio/thumbs/IMG_0203-800.webp`)
7. The gate lives at `auth.limooo.cn` (former `verify.limooo.cn` retired) and renders in place: subdomains serve content directly with no `/zh-CN/` language prefix, and unverified requests keep the original host and path, both on Pages hosts and on `status.limooo.cn` (Nginx proxies the gate page)
8. **visitor / apple / redirect run on Pages**: the visitor panel (analytics) and the Apple ID manager share the same Pages Functions (login / API / D1) with the main site; `redirect.limooo.cn` is a pure relay page **exempt from human verification** (to avoid a redirect loop after verification)
9. **identity / admin / status run on the VPS**: authentik (self-hosted Docker OIDC IdP), the embedded Kuma admin UI and the Kuma status page + notification receivers remain VPS services; Nginx applies the same `auth_request` gate to them, rendering the edge gate page in place through the proxy described under [Gate behavior](#gate-behavior)

Production state (2026-09-13):

- `007_visitor_status_indexes.sql` verified present on production D1.
- VPS `limooo` / `nginx` active; Nginx config test passes and matches `ops/limooo.conf` byte for byte.
- Pages Functions and static assets deployed; OIDC `/login` uses
  `/application/o/authorize/` and provider slug `visitor`.
- The gate renders in place on both runtimes; `status.limooo.cn` no longer redirects to `auth.limooo.cn`, and the gate page/logs show the real visitor IP (verified with Turnstile on `status.limooo.cn`).
- The historical 1255-entry blocklist is **not** restored; backup remains archive only.
- Follow-up: Safari visitor-filter smoke test and authentik client-secret rotation.

## License

[GNU AGPL v3.0](LICENSE.md)|[GNU AGPL v3.0-简体中文](LICENSE_zh_CN.md)|[GNU AGPL v3.0-日本語](LICENSE_ja_JP.md)|[GNU AGPL v3.0-한국어](LICENSE_ko_KR.md)
