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
- **Unified redirect page** (`/r`): shows an interstitial on redirect.limooo.cn before redirecting to any HTTPS destination; when the target is limooo.cn it prefetches the homepage portfolio images (served via `images.limooo.cn`) during the brief hold (~0.8s max) so they render instantly after the jump

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
│   └── build.py           # Pages static build (python3 src/build.py)
│   ├── static/            # static assets (icons, portfolio, QR codes)
│   └── templates/         # Jinja2 page templates
├── README.md              # this file
├── LICENSE.md             # AGPL-3.0
├── data/                  # runtime data (generated; git-ignored except blocklist.txt / whitelist.txt)
│   ├── blocklist.txt      # list of banned /24 subnets
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
│   ├── upload.sh          # quiet variant of deploy.sh
│   ├── pages_deploy.sh    # Cloudflare Pages build + deploy
│   ├── requirements.txt   # Python dependencies
│   ├── limooo.conf        # Nginx site configuration
│   ├── location-security.inc      # Nginx security hardening snippet
│   ├── limooo.service     # systemd service unit
│   ├── migrations/        # D1 schema migrations
│   ├── export_*.py        # D1 import SQL/JSON export scripts
│   └── sync-worker/       # Cloudflare Worker: daily D1 blocked_ips → IP List sync
├── functions/             # Cloudflare Pages Functions
├── locales/               # i18n / translation catalogs
├── public/                # Pages build output (git keeps only .gitkeep)
└── preview/               # local preview (build-generated; git keeps only .gitkeep)
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

## Whitelist

Trusted sources are maintained in [`data/whitelist.txt`](data/whitelist.txt), one entry per line:

| Entry | Effect |
| --- | --- |
| `ASN/<number>` | Low-risk source (China Telecom / China Mobile / China Unicom, incl. Tietong and backbone AS9929). Served a Cloudflare Non-Interactive Challenge (`js_challenge`) instead of the Turnstile gate. |
| `IP-CIDR/<ip>/<mask>` | Fully allowed source (e.g. `IP-CIDR/97.64.18.11/32`); skips both the blocklist and the challenge gate. |

The ASN list is sourced from [china-mainland-asn](https://github.com/xingpingcn/china-mainland-asn) (updated daily) and mirrored to the WAF low-risk `js_challenge` rule. Allowed IPs are mirrored to `functions/_middleware.ts` (`GATE_WHITELIST`) and to a Cloudflare WAF skip rule.

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

- `python3 src/build.py`: pre-renders the three pages in 4 languages into `public/`, and inlines `locales/*.json` as `functions/api/i18n/[lang].ts`
- `ops/migrations/001_init.sql`: D1 initial schema (`apple_accounts` / `blocked_ips` / `visitors`)
- `ops/export_appleid.py` / `ops/export_blocklist.py`: generate D1 import SQL (output in `ops/out/`, git-ignored)
- `ops/sync-worker/`: a daily 03:00 cron incrementally syncs D1 `blocked_ips` to the Cloudflare IP List (the Cloudflare part of the former auto_block.py; ipset/iptables has been dropped)
- Note: authentik backchannel logout is not yet ported to Pages (the `logout_events` table stays with the VPS)

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
| `APPLEID_ENCRYPTION_KEY` | Fernet key (from `secrets/appleid_encryption.key`, shared with the Flask side) |

Local development: copy `.dev.vars.example` to `.dev.vars` and fill in real values (git-ignored). Configure `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` for `ops/sync-worker` via `wrangler secret put`.

### Gate behavior

Every request is first checked for the `__gate` cookie (HMAC-SHA256 signed). Low-risk traffic (China Telecom / China Mobile / China Unicom ASNs) is pre-filtered by a Cloudflare WAF Non-Interactive Challenge (`js_challenge`); once it passes, the browser carries `cf_clearance` (Apple devices automatically take the Private Access Tokens channel) and the middleware lets the request straight through. All other (medium/high-risk) requests are 302-redirected to the dedicated verification subdomain `auth.limooo.cn/__gate` (original host and path attached; the Turnstile widget only needs that domain allow-listed). The gate page is served with `Cache-Control: no-store` and `noindex`; once Turnstile passes, a 24h cookie (`Domain=.limooo.cn`, shared across subdomains) is issued and the visitor is routed back to the original host and path via `redirect.limooo.cn/?to=...`. `/__gate/verify` and `/Limooo-xtext.webp` are exempt to avoid loops. The middleware also enforces the D1 blocklist and records visitor analytics. The whitelist lives in `data/whitelist.txt`: `ASN/<number>` entries are low-risk sources (China Telecom / Mobile / Unicom, served a CF Non-Interactive Challenge), while `IP-CIDR/<ip>/<mask>` entries are fully allowed (e.g. `97.64.18.11` skips both the blocklist and the gate). The gate page supports dark/light theme switching (shares `localStorage.theme` with the main site).

### Page serving (clean URLs, no language path prefix)

`src/build.py` pre-renders `public/<lang>/` in 4 languages; after the gate passes, the middleware picks a language by **cookie > Accept-Language > CF region > en-US** and fetches the matching page via `env.ASSETS.fetch()`, keeping the URL clean:

- `limooo.cn/` → home page; `limooo.cn/services` / `limooo.cn/contact` → corresponding pages
- `services.limooo.cn/` → services page; `contact.limooo.cn/` → contact page (subdomains serve content directly, no 301 to the main site)
- `www.limooo.cn` → 301 to the main site (preserving the former nginx behavior)
- Nav links keep absolute subdomain URLs (`https://services.limooo.cn` etc.); language switching is a pure frontend `applyLang()`, no reload, no URL change

### Migration progress

Done:

1. Pages project (`limooo`, `limooo.pages.dev`) and D1 database (`limooo`, APAC) created; D1 binding `DB` attached to the project
2. `ops/migrations/001_init.sql` executed; `ops/out/appleid.sql` (5 rows) and `blocklist.sql` (1255 rows) imported
3. Secrets configured: `TURNSTILE_SITEKEY` / `TURNSTILE_SECRET` (Turnstile widget in Managed mode; domain must include `auth.limooo.cn`), `GATE_HMAC_KEY` / `SESSION_HMAC_KEY` (`openssl rand -hex 32`), `AUTHENTIK_*`, `APPLEID_ENCRYPTION_KEY`
4. Deployed to Pages and verified live: root path 403 gate page + `Cache-Control: no-store`, logo 200, `/__gate/verify` re-renders on failure, Location/IP/Ray ID diagnostics OK; full chain tested with Turnstile test keys (submit → siteverify → issue cookie → page served), forged cookies are rejected
5. WAF custom rules live: `ip.src in $limooo_blocklist` → block
6. **DNS switched**: `limooo.cn` / `www` / `services` / `contact` / `auth` / `visitor` / `appleid` / `redirect` → CNAME `limooo.pages.dev` (proxied), all custom domains active; `identity` / `xmpp` keep server A records; `*.limooo.cn` wildcard A kept as fallback; `images.limooo.cn` has no separate DNS record and falls to the wildcard A (VPS), with nginx serving `/static` images directly (URLs have no `/static` prefix, e.g. `https://images.limooo.cn/portfolio/IMG_0203.webp`)
7. The gate is hosted at `auth.limooo.cn` (former `verify.limooo.cn` retired); subdomains serve content directly with no `/zh-CN/` language prefix; unverified requests keep the original host and path on the gate page and return to it after passing
8. **visitor / appleid / redirect migrated to Pages**: visitor (analytics) and appleid (Apple ID manager) share the same Pages Functions (login / API / D1) with the main site; `redirect.limooo.cn` is a pure relay page **exempt from human verification** (to avoid a redirect loop after verification)
9. **identity stays on the VPS**: it runs authentik (self-hosted Docker OIDC IdP), which Pages cannot replace; the VPS nginx still applies `auth_request` human verification to it

Remaining (one external dependency):

- **ops/sync-worker deployment**: add `Workers Scripts: Edit` (incl. triggers) permission to the API token, then `wrangler deploy`; until then the server-side `auto_block.py` keeps syncing the Cloudflare IP List and the WAF rules keep working

## License

[GNU AGPL v3.0](../LICENSE)
