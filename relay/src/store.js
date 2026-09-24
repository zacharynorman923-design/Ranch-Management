/* Tiny key/value helpers over the D1 `kv` table. */
export async function kvGet(env, k) {
  const row = await env.DB.prepare('SELECT v FROM kv WHERE k = ?1').bind(k).first();
  if (!row) return null;
  try { return JSON.parse(row.v); } catch { return row.v; }
}
export async function kvSet(env, k, v) {
  await env.DB.prepare('INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, JSON.stringify(v)).run();
}
