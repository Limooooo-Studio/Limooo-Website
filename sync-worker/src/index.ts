/**
 * 每日 03:00 把 D1 里的 blocked_ips 增量同步到 Cloudflare IP List
 * （原 auto_block.py 的 sync_cloudflare 移植；ipset/iptables 部分随迁移放弃）
 */

interface D1Result<T> {
  results: T[];
  success: boolean;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(sql: string): D1PreparedStatement;
}

interface Env {
  DB: D1Database;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
}

const LIST_NAME = "limooo_blocklist";
const API = "https://api.cloudflare.com/client/v4";
const BATCH = 200;

async function cf(token: string, method: string, url: string, body?: unknown): Promise<any> {
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`CF API ${resp.status} ${url}`);
  return resp.json();
}

async function waitOperation(token: string, accountId: string, operationId?: string): Promise<void> {
  if (!operationId) return;
  for (let i = 0; i < 40; i++) {
    const resp = await cf(
      token,
      "GET",
      `${API}/accounts/${accountId}/rules/lists/bulk_operations/${operationId}`,
    );
    const status = resp?.result?.status;
    if (status === "completed" || status === "failed") return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function listItems(token: string, accountId: string, listId: string): Promise<Map<string, string>> {
  const items = new Map<string, string>();
  let page = 1;
  for (;;) {
    const resp = await cf(
      token,
      "GET",
      `${API}/accounts/${accountId}/rules/lists/${listId}/items?per_page=1000&page=${page}`,
    );
    const result: Array<{ ip: string; id: string }> = resp?.result ?? [];
    for (const item of result) items.set(item.ip, item.id);
    if (result.length < 1000) break;
    page++;
  }
  return items;
}

async function sync(env: Env): Promise<void> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) {
    console.log("[cf] missing credentials, skipping");
    return;
  }

  const rows = await env.DB.prepare("SELECT cidr FROM blocked_ips").all<{ cidr: string }>();
  const desired = new Set((rows.results ?? []).map((r) => r.cidr));

  const lists = await cf(token, "GET", `${API}/accounts/${accountId}/rules/lists?per_page=100`);
  let list = (lists?.result ?? []).find((l: { name: string }) => l.name === LIST_NAME);
  if (!list) {
    const created = await cf(token, "POST", `${API}/accounts/${accountId}/rules/lists`, {
      name: LIST_NAME,
      kind: "ip",
      description: "auto-blocked networks from nginx logs",
    });
    list = created?.result;
  }
  if (!list?.id) throw new Error("list not found/created");

  const existing = await listItems(token, accountId, list.id);
  const toAdd = [...desired].filter((ip) => !existing.has(ip));
  const toRemove = [...existing.keys()].filter((ip) => !desired.has(ip));

  for (let i = 0; i < toAdd.length; i += BATCH) {
    const chunk = toAdd.slice(i, i + BATCH).map((ip) => ({ ip }));
    const resp = await cf(token, "POST", `${API}/accounts/${accountId}/rules/lists/${list.id}/items`, chunk);
    await waitOperation(token, accountId, resp?.result?.operation_id);
  }
  for (let i = 0; i < toRemove.length; i += BATCH) {
    const chunk = toRemove
      .slice(i, i + BATCH)
      .map((ip) => ({ id: existing.get(ip) }))
      .filter((x) => x.id);
    if (!chunk.length) continue;
    const resp = await cf(token, "DELETE", `${API}/accounts/${accountId}/rules/lists/${list.id}/items`, {
      items: chunk,
    });
    await waitOperation(token, accountId, resp?.result?.operation_id);
  }
  console.log(`[cf] synced: +${toAdd.length} -${toRemove.length}`);
}

export default {
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    ctx.waitUntil(sync(env));
  },
};
