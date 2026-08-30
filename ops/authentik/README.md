# Authentik 单入口管理后台（admin.limooo.cn）

本目录只保存 Authentik 相关的可重复部署配置：

- `if/admin.html`：覆盖 Authentik 管理界面模板，在页面内嵌一个
  `https://admin.limooo.cn/dashboard` 的 Kuma iframe；右下角提供
  Admin / Monitor 切换按钮，默认进入监控。
- `deploy.sh`：幂等同步模板、把 `AUTHENTIK_URL` 固定为
  `https://admin.limooo.cn`、将 Proxy Provider 设为 `forward_single`、
  更新 Embedded Outpost 的 `authentik_host`，然后重启 server/worker。

与 Uptime Kuma 的边界：

- Nginx 在 `admin.limooo.cn` 下把 `/if/`、`/static/`、`/api/v3/`、
  `/ws/`、`/outpost.goauthentik.io/` 交给 Authentik；
- `/dashboard`、`/socket.io/`、`/assets/`、`/api/entry-page` 等 Kuma
  资源由 Nginx 直接反代到 `127.0.0.1:3001`，并先经 Authentik
  `auth_request` 校验；
- `identity.limooo.cn` 只返回 301 到 `admin.limooo.cn`，不承载后端。

部署命令：

```bash
cd /Users/lime/Documents/Project/Limooo/Flask
bash ops/authentik/deploy.sh
```

只查看计划：

```bash
bash ops/authentik/deploy.sh --dry-run
```
