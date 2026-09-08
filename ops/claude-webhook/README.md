# 状态 webhook 服务

`app.py` 同时作为 Claude 与 Cloudflare 的 webhook 接收器；两套 systemd 实例用环境变量隔离端口、数据库与显示名称。

- `claude-webhook.service`：`127.0.0.1:3003`，数据库 `/opt/claude-webhook/events.db`
- `cloudflare-webhook.service`：`127.0.0.1:3004`，数据库 `/opt/cloudflare-webhook/events.db`

Cloudflare 的 URL token 仅保存在 VPS 的 `/etc/nginx/conf.d/cloudflare-webhook-secret.conf`，不应写入 Git 或此目录。若 Cloudflare 后台支持 webhook secret，应额外设置，并放入 `/var/www/limooo/secrets/cloudflare-webhook.env` 的 `CLAUDE_WEBHOOK_SECRET`（接收器会校验签名；平台使用 `cf-webhook-auth` 静态头时应在 Nginx 层校验）。
