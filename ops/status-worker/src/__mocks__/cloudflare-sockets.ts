/**
 * vitest 用的 `cloudflare:sockets` 桩：Workers 运行时才有该内置模块，
 * 本地跑 `ops/status-worker` 的测试时用它顶上，避免加载失败。
 */

export interface SocketStub {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  close(): Promise<void>;
}

export function connect(): SocketStub {
  throw new Error("cloudflare:sockets is only available in the Workers runtime");
}
