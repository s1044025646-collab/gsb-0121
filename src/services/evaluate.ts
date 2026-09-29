import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../core/errors.ts";
import { evaluateClass, meanAp } from "../core/metrics.ts";
import type { ClassApResult, GtBoxRow, MatchRecord, PredBoxRow } from "../core/types.ts";
import { contentHash } from "./serial.ts";
import { getProtocol, type ProtocolRecord } from "./protocols.ts";
import { inTransaction } from "../db/tx.ts";

export interface ThresholdReport {
  iouThreshold: number;
  map: number;
  totalTp: number;
  totalFp: number;
  totalFn: number;
  perClass: ClassApResult[];
}

export interface RunResult {
  reportId: number;
  reused: boolean;
  datasetVersionId: number;
  modelVersionId: number;
  protocolId: number;
  map: number;
  createdAt: string;
  thresholds: ThresholdReport[];
}

interface Loaded {
  gts: GtBoxRow[];
  preds: PredBoxRow[];
  names: Map<number, string>;
}

function load(db: DatabaseSync, datasetVersionId: number, modelVersionId: number): Loaded {
  const gts = db
    .prepare(
      `SELECT g.id, g.image_id AS imageId, g.category_id AS categoryId, g.x,g.y,g.w,g.h
       FROM gt_boxes g WHERE g.dataset_version_id = ?`,
    )
    .all(datasetVersionId) as unknown as GtBoxRow[];

  const model = db
    .prepare(
      `SELECT id FROM model_versions WHERE id = ?
       AND id IN (SELECT DISTINCT model_version_id FROM predictions WHERE dataset_version_id = ?)`,
    )
    .get(modelVersionId, datasetVersionId);
  if (!model) {
    throw new AppError(
      "NOT_FOUND",
      `model version ${modelVersionId} has no predictions for dataset version ${datasetVersionId}.`,
      404,
    );
  }

  const preds = db
    .prepare(
      `SELECT p.id, p.image_id AS imageId, p.category_id AS categoryId, p.score, p.x,p.y,p.w,p.h
       FROM predictions p WHERE p.model_version_id = ? AND p.dataset_version_id = ?`,
    )
    .all(modelVersionId, datasetVersionId) as unknown as PredBoxRow[];

  const names = new Map<number, string>();
  const rows = db
    .prepare("SELECT category_id, name FROM dataset_categories WHERE dataset_version_id = ?")
    .all(datasetVersionId) as { category_id: number; name: string }[];
  for (const r of rows) names.set(r.category_id, r.name);

  return { gts, preds, names };
}

export function computeReport(
  loaded: Loaded,
  protocol: ProtocolRecord,
): ThresholdReport[] {
  const categoryIds = new Set<number>();
  for (const g of loaded.gts) categoryIds.add(g.categoryId);
  for (const p of loaded.preds) categoryIds.add(p.categoryId);
  const orderedCats = [...categoryIds].sort((a, b) => a - b);

  return protocol.iouThresholds.map((iouThreshold) => {
    const thresholds = { match: iouThreshold, wrongClass: protocol.wrongClassIou, duplicate: protocol.duplicateIou };
    const perClass: ClassApResult[] = [];
    let totalTp = 0;
    let totalFp = 0;
    let totalFn = 0;
    for (const catId of orderedCats) {
      const { result, records } = evaluateClass(
        catId,
        loaded.names.get(catId) ?? null,
        loaded.gts,
        loaded.preds,
        thresholds,
      );
      perClass.push(result);
      totalTp += records.filter((r) => r.tp).length;
      totalFp += records.filter((r) => r.predId !== null && !r.tp).length;
      totalFn += records.filter((r) => r.errorKind === "missed").length;
    }
    const { map } = meanAp(perClass);
    return {
      iouThreshold,
      map: round(map),
      totalTp,
      totalFp,
      totalFn,
      perClass: perClass.map((c) => ({ ...c, ap: round(c.ap) })),
    };
  });
}

export function runEvaluation(
  db: DatabaseSync,
  datasetVersionId: number,
  modelVersionId: number,
  protocolId: number,
  now: () => string = () => new Date().toISOString(),
): RunResult {
  const protocol = getProtocol(db, protocolId);
  const dv = db.prepare("SELECT id FROM dataset_versions WHERE id = ?").get(datasetVersionId);
  if (!dv) throw new AppError("NOT_FOUND", `dataset version ${datasetVersionId} not found.`, 404);

  const loaded = load(db, datasetVersionId, modelVersionId);
  const thresholds = computeReport(loaded, protocol);
  const mapValues = thresholds.map((t) => t.map);
  const overallMap = round(mapValues.reduce((a, b) => a + b, 0) / mapValues.length);

  const hashBase = { datasetVersionId, modelVersionId, protocolHash: protocolContentHash(db, protocolId), thresholds };
  const hash = contentHash(hashBase);

  const existing = db
    .prepare("SELECT id, created_at FROM reports WHERE content_hash = ?")
    .get(hash) as { id: number; created_at: string } | undefined;
  if (existing) {
    return {
      reportId: existing.id,
      reused: true,
      datasetVersionId,
      modelVersionId,
      protocolId,
      map: overallMap,
      createdAt: existing.created_at,
      thresholds,
    };
  }

  const tx = () => inTransaction(db, () => {
    const info = db
      .prepare(
        `INSERT INTO reports(dataset_version_id, model_version_id, protocol_id, map, frozen, summary_json, content_hash, created_at)
         VALUES (?,?,?,?,1,?,?,?)`,
      )
      .run(datasetVersionId, modelVersionId, protocolId, overallMap, JSON.stringify({ thresholds }), hash, now());
    const reportId = Number(info.lastInsertRowid);

    const insThr = db.prepare(
      `INSERT INTO report_thresholds(report_id, iou_threshold, map, total_tp, total_fp, total_fn, per_class_json)
       VALUES (?,?,?,?,?,?,?)`,
    );
    const insMatch = db.prepare(
      `INSERT INTO match_records(report_id, iou_threshold, image_id, category_id, gt_id, pred_id, iou, tp, error_kind, score, detail)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );

    for (const tr of thresholds) {
      insThr.run(reportId, tr.iouThreshold, tr.map, tr.totalTp, tr.totalFp, tr.totalFn, JSON.stringify(tr.perClass));
      const th = { match: tr.iouThreshold, wrongClass: protocol.wrongClassIou, duplicate: protocol.duplicateIou };
      const categoryIds = new Set<number>();
      for (const g of loaded.gts) categoryIds.add(g.categoryId);
      for (const p of loaded.preds) categoryIds.add(p.categoryId);
      for (const catId of [...categoryIds].sort((a, b) => a - b)) {
        const { records } = evaluateClass(catId, loaded.names.get(catId) ?? null, loaded.gts, loaded.preds, th);
        persistRecords(insMatch, reportId, tr.iouThreshold, records);
      }
    }
    return { reportId, createdAt: now() };
  });

  const { reportId, createdAt } = tx();
  return { reportId, reused: false, datasetVersionId, modelVersionId, protocolId, map: overallMap, createdAt, thresholds };
}

function persistRecords(
  ins: { run: (...args: never[]) => unknown },
  reportId: number,
  iouThreshold: number,
  records: MatchRecord[],
): void {
  for (const r of records) {
    (ins.run as (...args: unknown[]) => unknown)(
      reportId,
      iouThreshold,
      r.imageId,
      r.categoryId,
      r.gtId,
      r.predId,
      r.iou,
      r.tp ? 1 : 0,
      r.errorKind,
      r.score,
      r.detail,
    );
  }
}

function protocolContentHash(db: DatabaseSync, protocolId: number): string {
  const row = db.prepare("SELECT content_hash FROM protocols WHERE id = ?").get(protocolId) as
    | { content_hash: string }
    | undefined;
  if (!row) throw new AppError("NOT_FOUND", `protocol ${protocolId} not found.`, 404);
  return row.content_hash;
}

function round(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}
