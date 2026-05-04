import { env } from 'cloudflare:test';
import { beforeEach } from 'vitest';
// `?raw` is a Vite import suffix; the SQL file is inlined as a string at bundle
// time, which avoids the "fs not available in Workers runtime" trap.
import SCHEMA_SQL from '../db/schema.sql?raw';

/**
 * Reset DB and R2 before every test.
 *
 * The vitest-pool-workers pool gives us a real D1 + R2 (miniflare-backed) per
 * test file, but does not auto-reset state between tests. Drop and re-create.
 */
beforeEach(async () => {
  await env.DB.exec('DROP TABLE IF EXISTS reports');
  await env.DB.exec('DROP TABLE IF EXISTS views');
  await env.DB.exec('DROP TABLE IF EXISTS shares');
  // exec splits on newlines; collapse to one line per statement.
  for (const stmt of splitSqlStatements(SCHEMA_SQL)) {
    if (stmt.trim()) {
      await env.DB.exec(stmt.replace(/\n+/g, ' '));
    }
  }

  // Best-effort wipe R2: list and delete in batches.
  let cursor: string | undefined;
  do {
    const list = await env.HTML_BUCKET.list({ cursor });
    for (const obj of list.objects) {
      await env.HTML_BUCKET.delete(obj.key);
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
});

/** Splits a SQL file by top-level semicolons, ignoring those in comments. */
function splitSqlStatements(sql: string): string[] {
  const noComments = sql.replace(/--[^\n]*\n/g, '\n');
  return noComments.split(';').map((s) => s.trim()).filter(Boolean);
}
