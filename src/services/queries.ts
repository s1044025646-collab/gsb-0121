import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../core/errors.ts";
import type { Paginated } from "../core/types.ts";

export interface PageParams {
  page: number;
  pageSize: number;
}

export function parsePage(query: URLSearchParams): PageParams {
  const page = Number(query.get("page") ?? "1");
  const pageSize = Number(query.get("pageSize") ?? "50");
  if (!Number.isInteger(page) || page < 1) {
    throw new AppError("INVALID_PAGINATION", "page must be a positive integer.", 400);
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    throw new AppError("INVALID_PAGINATION", "pageSize must be an integer between 1 and 500.", 400);
  }
  return { page, pageSize };
}

export function paginate<T>(rows: T[], total: number, p: PageParams): Paginated<T> {
  return {
    data: rows,
    page: p.page,
    pageSize: p.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / p.pageSize)),
  };
}

interface ReportRow {
  id: number;
  dataset_version_id: number;
  model_version_id: number;
  protocol_id: number;
  map: number;
  frozen: number;
  created_at: string;
}

export function listReports(db: DatabaseSync, p: PageParams): Paginated<ReportRow> {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM reports").get() as { n: number }).n;
  const rows = db
    .prepare("SELECT * FROM reports ORDER BY id DESC LIMIT ? OFFSET ?")
    .all(p.pageSize, (p.page - 1) * p.pageSize) as unknown as ReportRow[];
  return paginate(rows, total, p);
}

export function getReportHeader(db: DatabaseSync, reportId: number): ReportRow {
  const row = db.prepare("SELECT * FROM reports WHERE id = ?").get(reportId) as ReportRow | undefined;
  if (!row) throw new AppError("NOT_FOUND", `report ${reportId} not found.`, 404);
  return row;
}

export function getReportDetail(db: DatabaseSync, reportId: number) {
  const header = getReportHeader(db, reportId);
  const thresholds = db
    .prepare(
      "SELECT iou_threshold, map, total_tp, total_fp, total_fn, per_class_json FROM report_thresholds WHERE report_id = ? ORDER BY iou_threshold",
    )
    .all(reportId) as {
    iou_threshold: number;
    map: number;
    total_tp: number;
    total_fp: number;
    total_fn: number;
    per_class_json: string;
  }[];
  return {
    ...header,
    thresholds: thresholds.map((t) => ({
      iouThreshold: t.iou_threshold,
      map: t.map,
      totalTp: t.total_tp,
      totalFp: t.total_fp,
      totalFn: t.total_fn,
      perClass: JSON.parse(t.per_class_json),
    })),
  };
}

export interface ErrorSample {
  matchRecordId: number;
  iouThreshold: number;
  imageId: number;
  imageKey: string;
  categoryId: number;
  categoryName: string | null;
  gtId: number | null;
  predId: number | null;
  iou: number;
  score: number | null;
  errorKind: string;
  detail: string;
}

export function listErrorSamples(
  db: DatabaseSync,
  reportId: number,
  opts: { kind?: string; iouThreshold?: number; categoryId?: number; page: number; pageSize: number },
): Paginated<ErrorSample> {
  getReportHeader(db, reportId);
  const where: string[] = ["m.report_id = ?", "m.tp = 0"];
  const params: unknown[] = [reportId];
  if (opts.kind) {
    const allowed = new Set(["missed", "duplicate", "localization", "wrong_class", "background_fp"]);
    if (!allowed.has(opts.kind)) {
      throw new AppError("VALIDATION", `invalid error kind "${opts.kind}".`, 400);
    }
    where.push("m.error_kind = ?");
    params.push(opts.kind);
  }
  if (opts.iouThreshold !== undefined) {
    where.push("ABS(m.iou_threshold - ?) < 1e-12");
    params.push(opts.iouThreshold);
  }
  if (opts.categoryId !== undefined) {
    where.push("m.category_id = ?");
    params.push(opts.categoryId);
  }
  const whereSql = where.join(" AND ");
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM match_records m WHERE ${whereSql}`).get(...(params as never[])) as {
      n: number;
    }
  ).n;
  const rows = db
    .prepare(
      `SELECT m.id AS matchRecordId, m.iou_threshold AS iouThreshold, m.image_id AS imageId,
              i.image_key AS imageKey, m.category_id AS categoryId, dc.name AS categoryName,
              m.gt_id AS gtId, m.pred_id AS predId, m.iou, m.score, m.error_kind AS errorKind, m.detail
       FROM match_records m
       JOIN images i ON i.id = m.image_id
       LEFT JOIN dataset_categories dc
         ON dc.dataset_version_id = (SELECT dataset_version_id FROM reports WHERE id = m.report_id)
        AND dc.category_id = m.category_id
       WHERE ${whereSql}
       ORDER BY m.error_kind, m.iou_threshold, m.image_id, m.id
       LIMIT ? OFFSET ?`,
    )
    .all(...(params as never[]), opts.pageSize, (opts.page - 1) * opts.pageSize) as unknown as ErrorSample[];
  return paginate(rows, total, { page: opts.page, pageSize: opts.pageSize });
}

export interface Comparison {
  reportAId: number;
  reportBId: number;
  datasetVersionId: number;
  protocolId: number;
  byThreshold: {
    iouThreshold: number;
    mapA: number;
    mapB: number;
    deltaMap: number;
  }[];
  overallMapA: number;
  overallMapB: number;
  deltaOverallMap: number;
}

/**
 * Model comparison is only valid when both frozen reports were produced
 * against the SAME dataset version AND the SAME evaluation protocol.
 */
export function compareReports(db: DatabaseSync, reportAId: number, reportBId: number): Comparison {
  const a = getReportHeader(db, reportAId);
  const b = getReportHeader(db, reportBId);
  if (a.dataset_version_id !== b.dataset_version_id) {
    throw new AppError(
      "RULE_MISMATCH",
      `Reports ${reportAId} and ${reportBId} target different dataset versions (${a.dataset_version_id} vs ${b.dataset_version_id}); comparison requires the same dataset.`,
      409,
    );
  }
  if (a.protocol_id !== b.protocol_id) {
    throw new AppError(
      "RULE_MISMATCH",
      `Reports ${reportAId} and ${reportBId} use different protocols (${a.protocol_id} vs ${b.protocol_id}); comparison requires the same rules.`,
      409,
    );
  }

  const rowsA = db
    .prepare("SELECT iou_threshold, map FROM report_thresholds WHERE report_id = ? ORDER BY iou_threshold")
    .all(reportAId) as { iou_threshold: number; map: number }[];
  const rowsB = db
    .prepare("SELECT iou_threshold, map FROM report_thresholds WHERE report_id = ? ORDER BY iou_threshold")
    .all(reportBId) as { iou_threshold: number; map: number }[];

  const byThreshold = rowsA.map((ra, idx) => {
    const rb = rowsB[idx];
    return {
      iouThreshold: ra.iou_threshold,
      mapA: ra.map,
      mapB: rb!.map,
      deltaMap: round(rb!.map - ra.map),
    };
  });

  return {
    reportAId,
    reportBId,
    datasetVersionId: a.dataset_version_id,
    protocolId: a.protocol_id,
    byThreshold,
    overallMapA: a.map,
    overallMapB: b.map,
    deltaOverallMap: round(b.map - a.map),
  };
}

function round(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}
