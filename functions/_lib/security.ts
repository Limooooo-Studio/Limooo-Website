/**
 * Limooo 统一安全响应头（Pages Functions 侧）。
 *
 * 唯一文案源是 `ops/security-headers.json`；本文件是 Pages 构建/运行时镜像。
 * 修改时请同时更新 JSON，并运行 `python3 ops/check_security_headers.py`。
 */

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy":
    "default-src 'self'; object-src 'none'; base-uri 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data: https://image.limooo.cn https://images.limooo.cn; font-src 'self' data: https://fonts.limooo.cn; connect-src 'self' https://image.limooo.cn https://images.limooo.cn; frame-src 'self' https://challenges.cloudflare.com; frame-ancestors 'self'; form-action 'self' https://*.limooo.cn",
};
