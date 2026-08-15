// 由 build.py 自动生成，勿手改。
import { translations } from "../../_data/i18n";

export const onRequestGet = ({ params }: { params: Record<string, string> }) => {
  const lang = String((params as { lang?: string }).lang ?? "");
  const dict = translations[lang];
  if (!dict) {
    return new Response(JSON.stringify({ error: "unsupported language" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify(dict), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" },
  });
};
