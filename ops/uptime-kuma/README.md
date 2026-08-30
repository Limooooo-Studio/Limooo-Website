# Uptime Kuma 管理后台（admin.limooo.cn 单入口）

- 软件：<https://github.com/louislam/uptime-kuma>
- 版本：`2.5.3`（固定版本升级，升级前备份 `data/`）
- 许可证：MIT，完全免费，无付费功能门槛
- 功能：HTTP(S)/TCP/Ping/WebSocket/DNS/Docker 监控、90+ 通知渠道、
  多状态页、证书监控、2FA、多语言 i18n、浅色/深色主题
- 数据：`/opt/uptime-kuma/data/`（SQLite），升级只替换容器，不删目录
- 访问：`https://admin.limooo.cn`（唯一入口）
- 架构：`admin.limooo.cn` 首先进入 Authentik 管理界面，管理页通过
  同域 iframe 内嵌 Uptime Kuma；Kuma 不再拥有独立子域或独立登录页
- `identity.limooo.cn` 在 Cloudflare 中已无独立 DNS 记录；Nginx 仅保留
  兼容 301 跳转到 `admin.limooo.cn` 同路径，不再承载后端
- Cloudflare 中已移除 `*.limooo.cn` 通配记录，只显式保留
  `admin.limooo.cn -> 43.108.57.161`，其他未点名的子域不再随机落到 VPS
- 认证：Embedded Outpost 使用 `forward_single` 模式，Nginx 仅对
  Kuma 路由发起 `auth_request`；Authentik 自身的 `/if/`、`/static/`、
  `/api/v3/`、`/ws/` 以 identity 内部 Host 代理，避免被 Outpost 拦截
- 网络：Docker 只绑定本机 `127.0.0.1:3001`，由 Nginx 反向代理，
  Cloudflare 代理后仍走 VPS Origin CA 证书，不直接暴露 3001 端口
- 品牌皮肤：`Kuma-Fork` 前端把主站设计令牌直接编译进产物
  （暗色 `#1b1b1f`、浅色 `#ffffff`、强调色 `#05A5A6`、Inter + Baloo 2）；
  升级 Kuma 时重新构建 `kuma-dist/` 即可
- Fork 前端：完整重建后的前端位于 `kuma-dist/`，部署时挂载到容器
  `/app/dist`；不修改上游 Docker 镜像，数据目录仍为 `/opt/uptime-kuma/data`
- 用户语言：fork 内新增只读翻译层，按 Kuma 当前界面语言翻译
  监控项名称和推送告警；不写入默认语言

## Fork 源码与重建

fork 源码保存在项目外层 `Kuma-Fork/`（2.5.3，分支 `limooo-ui`），
不在站点 git 仓库中。修改后重新构建并把产物复制到 `kuma-dist/`：

```bash
cd /Users/lime/Documents/Project/Limooo/Kuma-Fork
npm ci
npm run build
rsync -a dist/ /Users/lime/Documents/Project/Limooo/Flask/ops/uptime-kuma/kuma-dist/
cd /Users/lime/Documents/Project/Limooo/Flask
bash ops/uptime-kuma/deploy.sh
```

`deploy.sh` 除了重建 Kuma 容器外，会同步
`ops/authentik/if/admin.html`，并重启 Authentik server 以刷新模板。
若要单独只更新 Authentik 管理模板/URL/Outpost 配置，使用：

```bash
bash ops/authentik/deploy.sh
```

回滚 fork 前端：把 `deploy.sh` 中 `-v '$REMOTE_ROOT/dist:/app/dist'`
一行移除，重新运行；或者将服务器备份原 dist 挂回
`/opt/uptime-kuma/dist-original-*`。

## 主题调整

修改 `kuma-admin-skin.css` 后同步到服务器，并把 Nginx 中
`/limooo-admin-skin.css?v=N` 的版本号递增，避免浏览器缓存旧样式：

```bash
bash ops/uptime-kuma/deploy.sh
```

回滚：恢复 `/etc/nginx/conf.d/limooo.conf` 与
`/opt/authentik/docker-compose.yml` 上一步备份，再重新运行
`bash ops/uptime-kuma/deploy.sh` 或 `bash ops/authentik/deploy.sh`。

## 首次部署

```bash
bash ops/uptime-kuma/deploy.sh
```

第一次打开 `https://admin.limooo.cn` 时创建管理员账号。账号数据保存在本机
`/opt/uptime-kuma/data/`，不进入 git 仓库。自动初始化默认用户名为 `Lime`，
密码由 `bootstrap.sh` 生成并写入服务器 `secrets/uptime-kuma.env`。

Authentik 自身的登录账号由 `/opt/authentik/.env` 管理；用户登录后
`/if/admin/` 默认显示内嵌 Kuma，右下角可切换到 Authentik Admin。

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
