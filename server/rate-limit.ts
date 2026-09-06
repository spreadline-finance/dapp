export const BUDGET_SQL = `INSERT INTO request_budgets (key, window_start, count) VALUES (?, ?, 1)
ON CONFLICT(key) DO UPDATE SET count = CASE WHEN request_budgets.window_start = excluded.window_start THEN request_budgets.count + 1 ELSE 1 END,
window_start = excluded.window_start RETURNING count`;
export async function consumeBudget(
  db: D1Database,
  identity: string,
  group: string,
  limit: number,
  now = Date.now(),
) {
  const day = Math.floor(now / 86400000);
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${day}:${group}:${identity}`),
  );
  const key = Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const windowStart = Math.floor(now / 60000) * 60;
  const row = await db
    .prepare(BUDGET_SQL)
    .bind(key, windowStart)
    .first<{ count: number }>();
  if (!row) throw new Error("request_budget_unavailable");
  return {
    allowed: row.count <= limit,
    retryAfter: 60 - (Math.floor(now / 1000) % 60),
  };
}
