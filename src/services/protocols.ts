import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../core/errors.ts";
import { contentHash } from "./serial.ts";

export interface ProtocolInput {
  name: string;
  iouThresholds: number[];
  wrongClassIou?: number;
  duplicateIou?: number;
}

export interface ProtocolRecord {
  id: number;
  name: string;
  iouThresholds: number[];
  wrongClassIou: number;
  duplicateIou: number;
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new AppError("VALIDATION", message, 400);
}

export function validateProtocol(raw: unknown): ProtocolInput {
  assert(typeof raw === "object" && raw !== null, "protocol must be an object.");
  const p = raw as Record<string, unknown>;
  assert(typeof p.name === "string" && p.name.trim().length > 0, "name required.");
  assert(Array.isArray(p.iouThresholds) && p.iouThresholds.length > 0, "iouThresholds must be a non-empty array.");
  const thresholds = p.iouThresholds.map((t, i) => {
    assert(typeof t === "number" && Number.isFinite(t), `iouThresholds[${i}] must be finite.`);
    assert(t > 0 && t < 1, `iouThresholds[${i}]=${t} must be in (0,1).`);
    return t;
  });
  const unique = [...new Set(thresholds.map((t) => t))];
  assert(unique.length === thresholds.length, "iouThresholds must be unique.");

  const wc = p.wrongClassIou ?? 0.1;
  const dup = p.duplicateIou ?? 0.5;
  assert(typeof wc === "number" && wc >= 0 && wc < 1, "wrongClassIou must be in [0,1).");
  assert(typeof dup === "number" && dup > 0 && dup < 1, "duplicateIou must be in (0,1).");

  return { name: p.name.trim(), iouThresholds: thresholds.sort((a, b) => a - b), wrongClassIou: wc, duplicateIou: dup };
}

export function upsertProtocol(
  db: DatabaseSync,
  raw: unknown,
  now: () => string = () => new Date().toISOString(),
): ProtocolRecord {
  const input = validateProtocol(raw);
  const canonical = {
    iouThresholds: input.iouThresholds,
    wrongClassIou: input.wrongClassIou,
    duplicateIou: input.duplicateIou,
  };
  const hash = contentHash(canonical);
  const existing = db
    .prepare("SELECT id FROM protocols WHERE content_hash = ?")
    .get(hash) as { id: number } | undefined;
  if (existing) return getProtocol(db, existing.id);

  const info = (db
    .prepare(
      "INSERT INTO protocols(name, iou_thresholds, wrong_class_iou, duplicate_iou, content_hash, created_at) VALUES (?,?,?,?,?,?)",
    )
    .run as (...a: unknown[]) => { lastInsertRowid: number | bigint })(
      input.name,
      JSON.stringify(input.iouThresholds),
      input.wrongClassIou,
      input.duplicateIou,
      hash,
      now(),
    );
  return getProtocol(db, Number(info.lastInsertRowid));
}

export function getProtocol(db: DatabaseSync, id: number): ProtocolRecord {
  const row = db.prepare("SELECT * FROM protocols WHERE id = ?").get(id) as
    | {
        id: number;
        name: string;
        iou_thresholds: string;
        wrong_class_iou: number;
        duplicate_iou: number;
      }
    | undefined;
  if (!row) throw new AppError("NOT_FOUND", `protocol ${id} not found.`, 404);
  return {
    id: row.id,
    name: row.name,
    iouThresholds: JSON.parse(row.iou_thresholds) as number[],
    wrongClassIou: row.wrong_class_iou,
    duplicateIou: row.duplicate_iou,
  };
}
