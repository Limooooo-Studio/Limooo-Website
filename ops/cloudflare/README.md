# Limooo Cloudflare 资源清单

本目录是 Limooo 云资源的声明式描述，供部署、回滚和外部审计使用。所有真实
token、secret 与可复现的 ID **不写在这里**，统一从以下来源读取：

| 资源 | 名称 / 类型 | 值来源 | 说明 |
| --- | --- | --- | --- |
| Pages 项目 | `limooo` | 配置文件 `Flask/wrangler.toml` | 构建输出目录 `public`，托管 `limooo.cn` 与子域 |
| Pages Functions | `functions/**` | Git 仓库代码 | 门禁、登录、Apple ID、访客统计、Ray 查询 |
| D1 数据库 | `DB` binding | `Flask/wrangler.toml` 的 `database_id` | Pages 与 `sync-worker` 共用 |
| D1 迁移 | `ops/migrations/*.sql` | Git 仓库代码 | 执行入口 `ops/migrate_d1.sh` |
| Worker：封禁同步 | `limooo-blocklist-sync` | `ops/sync-worker/wrangler.toml` | 每日 03:30，D1 active 行 → Cloudflare IP List |
| Worker：图片水印 | `image-watermark` | `ops/image-watermark/wrangler.toml` | `image.limooo.cn/*` 按 Referer 返回原图/水印 |
| WAF IP List | `limooo_blocklist` | `ops/sync-worker` | Cloudflare List，供 WAF 规则引用；`auto_block.py cf` 仅维护用 |
| DNS 区域 | `limooo.cn` | Cloudflare 控制台 | CNAME 到 `limooo.pages.dev`，详见 AGENTS.md |
| WAF 规则 | 自定义规则 | Cloudflare 控制台 | `ip.src in $limooo_blocklist`、低风险 `js_challenge` |

## Pages 环境变量（只列键名，不列值）

在 Cloudflare Pages 项目设置的 `Environment variables → Encrypt (Secret)` 配置：

- `TURNSTILE_SITEKEY` / `TURNSTILE_SECRET`
- `GATE_HMAC_KEY`、`SESSION_HMAC_KEY`
- `AUTHENTIK_URL`、`AUTHENTIK_CLIENT_ID`、`AUTHENTIK_CLIENT_SECRET`
- `AUTHENTIK_ADMIN_GROUPS`
- `APPLEID_ENCRYPTION_KEY`
- `OBSERVABILITY_HMAC_KEY`

本地开发复制 `.dev.vars.example`；生产值放在服务器
`/var/www/limooo/secrets/webauthn.env`（只被 `pages_deploy.sh` 读取，不回显）。

## 迁移与回滚

1. 变更前备份 D1：`wrangler d1 export <database> --remote`（登记到
   `docs/parallel-actions.md`）。
2. 预览：`bash ops/migrate_d1.sh --dry-run`。
3. 执行：`bash ops/migrate_d1.sh --remote`。
4. 回滚：用备份恢复后，重新执行 `migrate_d1.sh --remote`；不会自动回退
   已应用的代码版本，必须与 Git 提交配合。

## 部署顺序

```bash
# 1. 构建并校验（不部署）
bash ops/pages_deploy.sh --build-only

# 2. 预览迁移与 Cloudflare 命令
bash ops/pages_deploy.sh --dry-run
bash ops/workers_deploy.sh --dry-run

# 3. 实际部署（需凭据，按 docs/parallel-actions.md 预约）
bash ops/pages_deploy.sh
bash ops/workers_deploy.sh
```

## D1 保留与清理

- `ray_log_v2` 保留 7 天，`visitors_v2` 保留 30 天，`events` 保留 90 天。
- `visitors_daily` 为永久聚合表，由 `ops/prune_d1.py --mode aggregate --apply` 写入。
- 生产 cron 由 `ops/install_retention_cron.sh` 安装：聚合每小时 23 分，
  清理每天 03:47，避开 `auto_block`（03:00）与 sync-worker（03:30）。

## 待办 / 外部确认

- 用户已决定不恢复历史 1255 条快照；备份仅作归档，不导入 D1 / CF List。
- Pages 新代码尚未部署；部署后重新执行 `migrate_d1.sh --check-schema --remote`。
- WAF 自定义规则、DNS record 的变更应通过 Cloudflare API 或控制台执行，
  本文件只负责让这些状态可追溯。
