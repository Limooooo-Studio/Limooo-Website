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

export interface D1BatchResult {
  success: boolean;
  meta?: Record<string, unknown>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch?(statements: D1PreparedStatement[]): Promise<D1BatchResult[]>;
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

/** 在单个 D1 事务中执行多条语句；任一失败则整体失败（D1 batch 语义）。 */
export async function executeBatch(
  db: D1Database | undefined,
  statements: D1PreparedStatement[],
): Promise<boolean> {
  if (!db?.batch || statements.length === 0) return false;
  try {
    const results = await db.batch(statements);
    return results.length === statements.length && results.every((r) => r.success);
  } catch {
    return false;
  }
}
