# Authentik 单入口管理后台（已停用）

> **2026-09-17 起：本目录已作废。** Authentik 随 VPS 一起退租，登录已改为
> **Cloudflare Access**（见根目录 `README.md` 与 `../status-worker/`）。
> Nginx 也没了，本节描述的 `admin.limooo.cn` 反代、`/kuma` 挂载与
> Embedded Outpost 均不再存在。文件仅作历史留存，**不要再执行 `deploy.sh`**。

历史记录（迁移前）：

- `if/admin.html`：覆盖为 Authentik 官方管理界面模板，不含自定义壳；
  Uptime Kuma 作为独立应用挂在 `https://admin.limooo.cn/kuma`。
- `deploy.sh`：幂等同步模板、把 `AUTHENTIK_URL` 固定为
  `https://admin.limooo.cn`、将 Proxy Provider 设为 `forward_single`、
  更新 Embedded Outpost 的 `authentik_host`，然后重启 server/worker。

当前的身份与登录方式：

- `visitor.limooo.cn` / `account.limooo.cn` / `admin.limooo.cn` 前置 Cloudflare Access；
- Worker 自行验签 `Cf-Access-Jwt-Assertion`，再按 AUD 映射 admin / viewer 角色；
- 会话撤销仍走 D1 `auth_sessions`，`requireAuth` 保持 fail-closed。
