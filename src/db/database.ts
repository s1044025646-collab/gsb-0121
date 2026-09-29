import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./schema.ts";
import { inTransaction } from "./tx.ts";

export interface MigrationInfo {
  from: number;
  to: number;
  applied: number[];
}

export function openDatabase(filePath: string): DatabaseSync {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  return db;
}

/**
 * Idempotent migrations. Safe to run repeatedly; only missing versions apply.
 */
export function migrate(db: DatabaseSync): MigrationInfo {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const appliedRows = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all() as { version: number }[];
  const appliedSet = new Set(appliedRows.map((r) => r.version));
  const from = appliedRows.length ? Math.max(...appliedRows.map((r) => r.version)) : 0;

  const newlyApplied: number[] = [];
  for (const m of MIGRATIONS) {
    if (appliedSet.has(m.version)) continue;
    const apply = () => inTransaction(db, () => {
      db.exec(m.sql);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(m.version, new Date().toISOString());
    });
    apply();
    newlyApplied.push(m.version);
  }
  const to = MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1]!.version : 0;
  return { from, to, applied: newlyApplied };
}
