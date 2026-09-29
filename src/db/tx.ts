import type { DatabaseSync } from "node:sqlite";

/**
 * Minimal explicit-transaction runner (the bundled node:sqlite in this
 * Node build does not expose DatabaseSync.transaction). Nested calls use
 * SAVEPOINTs so service-layer composition still rolls back atomically.
 */
const depths = new WeakMap<DatabaseSync, number>();

export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  const depth = depths.get(db);
  const active = (depth ?? 0) > 0;
  if (!active) {
    db.exec("BEGIN IMMEDIATE");
    depths.set(db, 1);
  } else {
    db.exec(`SAVEPOINT sp${depth}`);
    depths.set(db, depth! + 1);
  }

  try {
    const result = fn();
    if (!active) {
      db.exec("COMMIT");
      depths.set(db, 0);
    } else {
      db.exec(`RELEASE SAVEPOINT sp${depth}`);
      depths.set(db, depth!);
    }
    return result;
  } catch (err) {
    if (!active) {
      db.exec("ROLLBACK");
      depths.set(db, 0);
    } else {
      db.exec(`ROLLBACK TO SAVEPOINT sp${depth}`);
      db.exec(`RELEASE SAVEPOINT sp${depth}`);
      depths.set(db, depth!);
    }
    throw err;
  }
}
