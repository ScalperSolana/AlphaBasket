import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Pool } from "pg";

import { loadBackendConfig } from "../config/env.js";

const MIGRATION_LOCK_ID = 1_441_702_612;

type AppliedMigration = Readonly<{ name: string; checksum: string }>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function run(): Promise<void> {
  const config = loadBackendConfig();
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const result = await client.query<AppliedMigration>("SELECT name, checksum FROM schema_migrations");
    const applied = new Map(result.rows.map((row) => [row.name, row.checksum]));
    const directory = resolve(import.meta.dirname, "../../../migrations");
    const migrationNames = (await readdir(directory))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
      .sort();

    for (const name of migrationNames) {
      const sql = await readFile(resolve(directory, name), "utf8");
      const checksum = sha256(sql);
      const previousChecksum = applied.get(name);
      if (previousChecksum !== undefined) {
        if (previousChecksum !== checksum) {
          throw new Error(`Applied migration ${name} was modified`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [name, checksum],
        );
        await client.query("COMMIT");
        process.stdout.write(`Applied ${name}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

await run();
