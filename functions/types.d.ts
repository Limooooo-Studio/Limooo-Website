/** 全局 Pages Functions 类型（避免依赖 @cloudflare/workers-types 包） */

declare interface PagesContext<Env = unknown> {
  request: Request;
  env: Env;
  params: Record<string, string>;
  next(): Promise<Response>;
  waitUntil?(promise: Promise<unknown>): void;
}

declare type PagesFunction<Env = unknown> = (context: PagesContext<Env>) => Promise<Response>;
