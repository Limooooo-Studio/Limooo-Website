# Uptime Kuma 管理后台（admin.limooo.cn）

- 软件：<https://github.com/louislam/uptime-kuma>
- 版本：`2.5.3`（固定版本升级，升级前备份 `data/`）
- 许可证：MIT，完全免费，无付费功能门槛
- 功能：HTTP(S)/TCP/Ping/WebSocket/DNS/Docker 监控、90+ 通知渠道、
  多状态页、证书监控、2FA、多语言 i18n、浅色/深色主题
- 数据：`/opt/uptime-kuma/data/`（SQLite），升级只替换容器，不删目录
- 访问：`https://admin.limooo.cn`
- 网络：Docker 只绑定本机 `127.0.0.1:3001`，由 Nginx 反向代理，
  Cloudflare 代理后仍走 VPS Origin CA 证书，不直接暴露 3001 端口

## 首次部署

```bash
bash ops/uptime-kuma/deploy.sh
```

第一次打开 `https://admin.limooo.cn` 时创建管理员账号。账号数据保存在本机
`/opt/uptime-kuma/data/`，不进入 git 仓库。

## 日常运维

```bash
# 查看状态
docker ps --filter name=uptime-kuma

# 升级到固定新版
docker pull louislam/uptime-kuma:2.5.3
docker rm -f uptime-kuma
cd /opt/uptime-kuma && docker compose up -d

# 备份
rsync -a /opt/uptime-kuma/data/ /var/backups/uptime-kuma/
```

## 回滚

停止并删除容器不会删除 `/opt/uptime-kuma/data/`。可用旧版本镜像重新启动，
并在启动前备份 `data/`。
