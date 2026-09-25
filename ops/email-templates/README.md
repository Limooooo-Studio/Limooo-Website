# Limooo 邮件模板

存放 Limooo 对外邮件的通用框架与多语种文案。**所有服务统一走 `framework.html` + `render.py`，不要各自维护版式。**

## 通用框架（所有服务复用）

- `framework.html`：通用 HTML 版式（logo + 标题 + 正文 + 可选高亮块 + 可选 CTA 按钮 + 可选提示 + 页脚），占位符见文件头。
- `framework.i18n.json`：通用四语种默认文案（footer_rights / default_hint / default_button / common_title）。
- `render.py`：渲染入口，供所有服务调用。示例：

  ```python
  from render import render_email
  html, plain = render_email(
      lang="zh-cn",            # zh-cn / en-us / ja-jp / ko-kr
      title="您的验证码",
      body="感谢您使用 Limooo Studio 的服务。",
      code="654321",           # 可选：高亮块
      cta_label="前往查看",    # 可选：主按钮
      cta_url="https://limooo.cn",
      hint="如果您未发起此操作，可忽略本邮件。",
      preheader="您的验证码是 654321",
  )
  ```

  CLI 调试：`python3 render.py --lang en-us --title 'Hi' --body 'Hello' --code 123456`

## 验证码用例

- `verification-code.i18n.json`：验证码主题四语种文案（subject / title / body / hint / plain / footer）。
- `verification-code.html`：用例说明（实际版式由 framework 提供，不重复）。

## 健康检查告警

- `health-alert.i18n.json`：告警邮件四语种文案（subject / title / intro / alerts / metrics / CTA / hint）。
- 告警渲染现在由 `ops/status-worker` 负责（零 VPS 后 `check_health.py` 已随 VPS 退役）；
  仍是同一套 `render_email()` 版式，邮件主题和正文无需重复维护。

## 发送要点

- **零 VPS 后的首选通道**：`status-worker` 的 `ALERT_WEBHOOK_URL`（HTTP webhook，默认飞书机器人格式）。
- **兜底**：Workers `send_email` binding（需开通 Email Sending）；发件域 `limooo.cn`，
  DNS 改动只落在 `cf-bounce` 子域，根域 SPF 不动。
- 收件：收件人通过 `wrangler secret put ALERT_TO` 注入，不入库；未配置时告警只记日志、不报错。
- 页脚 `Limooo` 用 Baloo 2（`font-size:1.21em` 补偿偏小字形）；邮件内嵌 TTF 为 `cid` 附件。
- 顶部 logo 用 `images.limooo.cn`（保留透明通道）；`image.limooo.cn` 会丢失 alpha 导致黑底。

## 历史记录（迁移前，已停用）

- SMTP：`smtp.feishu.cn:465`（SSL），账号 `no-reply-<N>@limooo.cn` / `Limooo-no-reply-N`。
- 凭据：服务器 `secrets/smtp-relay.env`；relay `/opt/smtp-relay/relay.py` 从该 env 读取。
- 随 VPS 退租一并失效；服务器端 relay 已不存在。

## 已知问题

- 飞书发信出口 IP（`71.18.227.x` / `163.181.x`）在 Spamhaus 黑名单，部分邮箱（如 iCloud）会以
  `554 5.7.1 [HM08] local policy` 硬拒。SPF/DKIM 虽 pass，但发送 IP 信誉差仍会被拒。
  临时缓解：收件人侧添加联系人/白名单。治本需飞书申诉移除 IP，或改用 IP 干净的服务商。
