# Limooo 邮件模板

存放 Limooo 对外邮件（验证码等）的标准模板与多语种文案。

## 文件

- `verification-code.i18n.json`：验证码邮件四语种文案（zh-cn / en-us / ja-jp / ko-kr）。
- `verification-code.html`：HTML 版式骨架（占位符 `__TITLE__` `__BODY__` `__HINT__` `__CODE__` `__FOOTER_RIGHTS__`）。

## 发送要点

- SMTP：`smtp.feishu.cn:465`（SSL），账号 `no-reply-<N>@limooo.cn` / `Limooo-no-reply-N`。
- 凭据存放：服务器 `secrets/smtp-relay.env`（不进代码库）；relay `/opt/smtp-relay/relay.py` 从该 env 读取。
- 收件：收件人自定；BCC `lime@limooo.cn`；Reply-To `contact@limooo.cn`。
- 轮换：`PER_ACCOUNT_LIMIT`（当前 100 封/账号/天），发满切下一个邮箱。
- 页脚 `LIMOOO` 用 Baloo 2 字体，`font-size:1.21em` 补偿其偏小字形度量；邮件内嵌 TTF 为 `cid` 附件。
- 顶部 logo 使用 `images.limooo.cn`（保留透明通道）；`image.limooo.cn` 会丢失 alpha 导致黑底。

## 已知问题

- 飞书发信出口 IP（`71.18.227.x` / `163.181.x`）在 Spamhaus 黑名单，部分邮箱（如 iCloud）会以
  `554 5.7.1 [HM08] local policy` 硬拒。SPF/DKIM 虽 pass，但发送 IP 信誉差仍会被拒。
  临时缓解：收件人侧添加联系人/白名单。治本需飞书申诉移除 IP，或改用 IP 干净的服务商。
