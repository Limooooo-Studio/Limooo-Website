/** 极简 D1 类型与封装（避免依赖 @cloudflare/workers-types 类型包） */

export interface D1Result<T> {
  results: T[];
  success: boolean;
  meta?: Record<string, unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<{ success: boolean; meta?: Record<string, unknown> }>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
}

export async function queryAll<T>(
  db: D1Database | undefined,
  sql: string,
  ...values: unknown[]
): Promise<T[]> {
  if (!db) return [];
  const stmt = db.prepare(sql);
  const res = values.length ? stmt.bind(...values).all<T>() : stmt.all<T>();
  return (await res).results ?? [];
}

export async function execute(
  db: D1Database | undefined,
  sql: string,
  ...values: unknown[]
): Promise<boolean> {
  if (!db) return false;
  const stmt = db.prepare(sql);
  const res = values.length ? stmt.bind(...values).run() : stmt.run();
  return (await res).success === true;
}
