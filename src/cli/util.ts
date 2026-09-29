import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../core/errors.ts";

export function readJsonArg(pathOrInline: string): unknown {
  const text = pathOrInline.trim().startsWith("{") || pathOrInline.trim().startsWith("[")
    ? pathOrInline
    : readFileSync(resolve(pathOrInline), "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("INVALID_JSON", `could not parse JSON from ${pathOrInline}`, 400);
  }
}

export function count(db: DatabaseSync, table: string, where = "", params: unknown[] = []): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`)
    .get(...(params as never[])) as { n: number };
  return row.n;
}

export function writeExport(path: string, value: unknown): void {
  writeFileSync(resolve(path), JSON.stringify(value, null, 2));
}

export function fail(err: unknown): never {
  if (err instanceof AppError) {
    console.error(`error [${err.code}]: ${err.message}`);
    process.exit(1);
  }
  console.error("error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
