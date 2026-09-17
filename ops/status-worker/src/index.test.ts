import { describe, expect, it, vi } from "vitest";
import {
  ProbeState,
  buildAlertEmail,
  esc,
  pageLang,
  record,
  renderStatusPage,
  runProbe,
  sendAlert,
  statusKey,
  statusPayload,
  STATUS_HTML_CACHE_CONTROL,
  type Env,
} from "./index";

/** 极简 D1 stub：按 SQL 关键字返回预设结果，并记录写入。 */
function fakeDb(handlers: {
  first?: (sql: string) => unknown;
  all?: (sql: string) => unknown;
  batch?: (stmts: unknown[]) => void;
}) {
  const prepared: string[] = [];
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      return {
        bind: (..._args: unknown[]) => ({
          first: async () => handlers.first?.(sql) ?? null,
          all: async () => handlers.all?.(sql) ?? { results: [] },
          run: async () => ({}),
        }),
        first: async () => handlers.first?.(sql) ?? null,
        all: async () => handlers.all?.(sql) ?? { results: [] },
        run: async () => ({}),
      };
    },
    batch: async (stmts: unknown[]) => {
      handlers.batch?.(stmts);
      return [];
    },
  };
  return { db: db as unknown as D1Database, prepared };
}

const probe = {
  id: 1,
  name: "Website",
  type: "http",
  target: "https://limooo.cn/_health",
  group_key: "public",
  interval_s: 60,
};

describe("runProbe", () => {
  it("200 → up 并记录延迟", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
    const { db } = fakeDb({});
    const r = await runProbe({ DB: db } as Env, probe);
    expect(r.status).toBe(1);
    expect(r.msg).toBe("http_200");
    expect(r.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("403（门禁页）仍视为可达", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    const { db } = fakeDb({});
    expect((await runProbe({ DB: db } as Env, probe)).status).toBe(1);
  });

  it("503 → down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    const { db } = fakeDb({});
    expect((await runProbe({ DB: db } as Env, probe)).status).toBe(0);
  });

  it("抛异常 → down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    const { db } = fakeDb({});
    const r = await runProbe({ DB: db } as Env, probe);
    expect(r.status).toBe(0);
    expect(r.msg).toContain("fetch_error");
  });

  it("d1 探针查 SELECT 1", async () => {
    const { db } = fakeDb({ first: () => ({ ok: 1 }) });
    const r = await runProbe({ DB: db } as Env, { ...probe, type: "d1", target: null });
    expect(r.status).toBe(1);
  });
});

describe("record 状态机", () => {
  it("首次失败只到 pending，未达阈值不判 down", async () => {
    const { db } = fakeDb({
      first: () => ({ last_status: 1, consecutive_fail: 0, down_since: null }),
    });
    const out = await record({ DB: db, FAIL_THRESHOLD: "2" } as Env, 1, {
      status: 0,
      latency_ms: null,
      msg: "x",
    });
    expect(out.status).toBe(2);
    expect(out.becameDown).toBe(false);
  });

  it("达到阈值判 down 并记录 down_since", async () => {
    const { db } = fakeDb({
      first: () => ({ last_status: 2, consecutive_fail: 1, down_since: null }),
    });
    const out = await record({ DB: db, FAIL_THRESHOLD: "2" } as Env, 1, {
      status: 0,
      latency_ms: null,
      msg: "x",
    });
    expect(out.status).toBe(0);
    expect(out.becameDown).toBe(true);
    expect(out.downSince).toBeGreaterThan(0);
  });

  it("从 down 恢复只触发一次 recovered", async () => {
    const down = fakeDb({
      first: () => ({ last_status: 0, consecutive_fail: 3, down_since: 100 }),
    });
    const out = await record({ DB: down.db, FAIL_THRESHOLD: "2" } as Env, 1, {
      status: 1,
      latency_ms: 5,
      msg: "ok",
    });
    expect(out.recovered).toBe(true);
    expect(out.downSince).toBeNull();

    const up = fakeDb({
      first: () => ({ last_status: 1, consecutive_fail: 0, down_since: null }),
    });
    const again = await record({ DB: up.db, FAIL_THRESHOLD: "2" } as Env, 1, {
      status: 1,
      latency_ms: 5,
      msg: "ok",
    });
    expect(again.recovered).toBe(false);
  });
});

describe("statusPayload", () => {
  it("汇总 overall / down / uptime", async () => {
    const { db } = fakeDb({
      all: () => ({
        results: [
          {
            id: 1,
            name: "Website",
            type: "http",
            target: "https://limooo.cn/_health",
            group_key: "public",
            active: 1,
            status: 1,
            latency_ms: 12,
            checked_at: 1,
            total: 10,
            up: 9,
          },
          {
            id: 2,
            name: "Admin",
            type: "http",
            target: "https://admin.limooo.cn/_health",
            group_key: "internal",
            active: 1,
            status: 0,
            latency_ms: null,
            checked_at: 1,
            total: 10,
            up: 4,
          },
        ],
      }),
    });
    const payload = await statusPayload({ DB: db } as Env);
    expect(payload.total).toBe(2);
    expect(payload.down).toBe(1);
    expect(payload.overall).toBe("partial");
    expect(payload.probes[0].uptime).toBeCloseTo(90);
    expect(payload.probes[1].uptime).toBeCloseTo(40);
  });

  it("无心跳时 uptime 为 null", async () => {
    const { db } = fakeDb({
      all: () => ({
        results: [
          {
            id: 1,
            name: "X",
            type: "http",
            target: "t",
            group_key: "public",
            active: 1,
            status: null,
            latency_ms: null,
            checked_at: null,
            total: 0,
            up: 0,
          },
        ],
      }),
    });
    const payload = await statusPayload({ DB: db } as Env);
    expect(payload.probes[0].uptime).toBeNull();
    expect(payload.overall).toBe("all");
  });
});

describe("状态页边缘缓存", () => {
  it("HTML 可被边缘缓存，且 TTL 与探针节奏对齐", () => {
    // 状态页 SSR 每次都要读 D1；退回 no-store 会让每次刷新/抓取都打库。
    expect(STATUS_HTML_CACHE_CONTROL).not.toContain("no-store");
    expect(STATUS_HTML_CACHE_CONTROL).toContain("s-maxage=60");
    // 允许短暂陈旧，避免上游抖动时全站回源。
    expect(STATUS_HTML_CACHE_CONTROL).toContain("stale-while-revalidate");
  });

  it("浏览器 TTL 短于边缘 TTL（避免本地长时间看到旧状态）", () => {
    const maxAge = Number(/max-age=(\d+)/.exec(STATUS_HTML_CACHE_CONTROL)?.[1]);
    const sMaxAge = Number(/s-maxage=(\d+)/.exec(STATUS_HTML_CACHE_CONTROL)?.[1]);
    expect(maxAge).toBeLessThan(sMaxAge);
  });
});

describe("ProbeState", () => {
  function makeState() {
    const store = new Map<string, unknown>();
    let alarm: number | null = null;
    const state = {
      storage: {
        put: async (k: string, v: unknown) => void store.set(k, v),
        get: async (k: string) => store.get(k) ?? null,
        setAlarm: async (ts: number) => void (alarm = ts),
        deleteAlarm: async () => void (alarm = null),
      },
    } as unknown as DurableObjectState;
    return { state, store, getAlarm: () => alarm };
  }

  it("arm 写入 probe_id 并设置 alarm", async () => {
    const { state, store, getAlarm } = makeState();
    const env = { DB: fakeDb({}).db, RETRY_INTERVAL_S: "10" } as Env;
    const res = await new ProbeState(state, env).fetch(
      new Request("https://probe.internal/arm", { headers: { "X-Probe-Id": "7" } }),
    );
    expect(res.status).toBe(200);
    expect(store.get("probe_id")).toBe(7);
    expect(getAlarm()).toBeGreaterThan(Date.now());
  });

  it("disarm 清除 alarm", async () => {
    const { state, getAlarm } = makeState();
    const env = { DB: fakeDb({}).db } as Env;
    await new ProbeState(state, env).fetch(new Request("https://probe.internal/disarm"));
    expect(getAlarm()).toBeNull();
  });

  it("alarm 在仍 down 且窗口内时续排", async () => {
    const { state, store, getAlarm } = makeState();
    store.set("probe_id", 1);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    const { db } = fakeDb({
      first: (sql: string) =>
        sql.includes("FROM probes")
          ? probe
          : { last_status: 0, consecutive_fail: 3, down_since: Math.floor(Date.now() / 1000) },
    });
    await new ProbeState(state, { DB: db, RETRY_INTERVAL_S: "10", RETRY_WINDOW_S: "280" } as Env).alarm();
    expect(getAlarm()).not.toBeNull();
  });
});

describe("状态页渲染", () => {
  it("pageLang 按 Accept-Language 选择", () => {
    const mk = (v: string) => new Request("https://x/", { headers: { "Accept-Language": v } });
    expect(pageLang(mk("zh-CN,zh;q=0.9"))).toBe("zh-cn");
    expect(pageLang(mk("en-US,en;q=0.9"))).toBe("en-us");
    expect(pageLang(mk("ja-JP"))).toBe("ja-jp");
    expect(pageLang(mk("ko-KR"))).toBe("ko-kr");
    expect(pageLang(mk(""))).toBe("zh-cn");
  });

  it("esc 转义 HTML 元字符", () => {
    expect(esc('<b>"x"&y</b>')).toBe("&lt;b&gt;&quot;x&quot;&amp;y&lt;/b&gt;");
  });

  it("statusKey 映射 1/0/其它", () => {
    expect(statusKey(1)).toBe("up");
    expect(statusKey(0)).toBe("down");
    expect(statusKey(null)).toBe("pending");
  });

  it("renderStatusPage 输出 i18n 文案且不含内联 script/style", async () => {
    const { db } = fakeDb({
      all: () => ({
        results: [
          {
            id: 1,
            name: "Website",
            type: "http",
            target: "https://limooo.cn/_health",
            group_key: "public",
            active: 1,
            label_key: "card_website",
            status: 1,
            latency_ms: 12,
            checked_at: 1,
            total: 10,
            up: 10,
          },
        ],
      }),
    });
    const html = await renderStatusPage({ DB: db } as Env, "zh-cn");
    expect(html).toContain("系统状态");
    expect(html).toContain("Limooo 网站"); // label_key 命中 locales 同名 key
    expect(html).toContain("运行正常");
    expect(html).toContain('href="/status.css"');
    expect(html).toContain('src="/status.js"');
    expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/\sstyle="/);
  });
});

describe("告警邮件", () => {
  it("down 用红色、up 用品牌青，且带探针名", () => {
    const down = buildAlertEmail("zh-cn", "down", "Website", "http_503", 1700000000);
    const up = buildAlertEmail("zh-cn", "up", "Website", "http_200", 1700000000);
    expect(down.subject).toContain("Website");
    expect(down.html).toContain("#dc2626");
    expect(up.html).toContain("#05A5A6");
    expect(down.text).toContain("http_503");
  });

  it("四语言都能出文案", () => {
    for (const lang of ["zh-cn", "en-us", "ja-jp", "ko-kr"]) {
      const mail = buildAlertEmail(lang, "down", "X", "m", 1700000000);
      expect(mail.subject.length).toBeGreaterThan(0);
      expect(mail.html).toContain("X");
    }
  });

  it("未配置 EMAIL binding 时降级、不抛异常", async () => {
    const { db } = fakeDb({});
    const r = await sendAlert({ DB: db } as Env, "down", "X", "m");
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("no_alert_channel");
  });

  it("有 binding 但无收件人时降级", async () => {
    const { db } = fakeDb({});
    const r = await sendAlert(
      { DB: db, EMAIL: { send: async () => ({}) } } as unknown as Env,
      "down",
      "X",
      "m",
    );
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("alert_to_missing");
  });

  it("发送成功时返回 sent=true", async () => {
    const { db } = fakeDb({});
    let captured: unknown = null;
    const r = await sendAlert(
      {
        DB: db,
        ALERT_TO: "ops@example.com",
        EMAIL: { send: async (m: unknown) => void (captured = m) },
      } as unknown as Env,
      "up",
      "Website",
      "http_200",
    );
    expect(r.sent).toBe(true);
    expect(JSON.stringify(captured)).toContain("ops@example.com");
  });
});
