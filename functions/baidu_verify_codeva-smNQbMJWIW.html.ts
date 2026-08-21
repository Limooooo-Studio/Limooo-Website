// 百度站点验证：/baidu_verify_codeva-smNQbMJWIW.html 直接返回验证内容。
// 不依赖 public/ 下的静态文件，因为 Pages 会对 *.html 静态资源 308 到去扩展名 URL，
// 百度校验要求该精确路径返回 200。

const TOKEN = "264d2c3041b656900ec4c76f4a4c0d6d";

export const onRequestGet = () =>
  new Response(TOKEN, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
