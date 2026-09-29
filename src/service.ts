import type { DatabaseSyncType } from './sqlite.js';
import {
  getOrCreateModel,
  getScheme,
  insertDatasetVersion,
  insertPredictionBatch,
  insertReport,
  loadEvalImages,
  upsertScheme,
  type ImageRow,
  type PredictionRow,
} from './db.js';
import { evaluate, type EvalOptions } from './eval.js';
import { AppError } from './errors.js';
import { hashInput } from './generate.js';
import type { ParsedReport } from './types.js';
import { validateImages } from './validation.js';

export interface Clock {
  now(): string;
}

export const utcClock: Clock = { now: () => new Date().toISOString() };

export class EvalService {
  constructor(private readonly db: DatabaseSyncType, private readonly clock: Clock = utcClock) {}

  importDataset(args: {
    name: string;
    idempotencyKey?: string;
    note?: string;
    images: ImageRow[];
  }): { datasetVersionId: number; replayed: boolean } {
    const images = validateImages(args.images);
    const { id, replayed } = insertDatasetVersion(this.db, {
      name: args.name,
      idempotencyKey: args.idempotencyKey,
      note: args.note,
      createdAt: this.clock.now(),
      images,
    });
    return { datasetVersionId: id, replayed };
  }

  importPredictions(args: {
    modelName: string;
    datasetVersionId: number;
    idempotencyKey?: string;
    rows: PredictionRow[];
  }): { modelVersionId: number; batchId: number; replayed: boolean } {
    const exists = this.db
      .prepare('SELECT id FROM dataset_versions WHERE id=?')
      .get(args.datasetVersionId);
    if (!exists) throw new AppError('NOT_FOUND', `dataset version ${args.datasetVersionId} not found`);
    const modelVersionId = getOrCreateModel(this.db, args.modelName, this.clock.now());
    const { batchId, replayed } = insertPredictionBatch({
      db: this.db,
      modelVersionId,
      datasetVersionId: args.datasetVersionId,
      idempotencyKey: args.idempotencyKey,
      createdAt: this.clock.now(),
      rows: args.rows,
    });
    return { modelVersionId, batchId, replayed };
  }

  createScheme(args: {
    name: string;
    iouThresholds: number[];
    interpolation: 'all_point' | '11_point';
    excludeClassesWithoutGt?: boolean;
  }): { schemeId: number } {
    validateThresholds(args.iouThresholds);
    if (!args.name?.trim()) throw new AppError('VALIDATION_ERROR', 'scheme name required');
    const id = upsertScheme(this.db, {
      name: args.name,
      createdAt: this.clock.now(),
      options: {
        iouThresholds: args.iouThresholds,
        interpolation: args.interpolation,
        excludeClassesWithoutGt: args.excludeClassesWithoutGt ?? true,
      },
    });
    return { schemeId: id };
  }

  runReport(args: {
    modelVersionId: number;
    datasetVersionId: number;
    schemeId: number;
  }): { reportId: number; report: ParsedReport; replayed: boolean } {
    const scheme = getScheme(this.db, args.schemeId);
    const images = loadEvalImages(this.db, args.modelVersionId, args.datasetVersionId);
    if (images.length === 0) {
      throw new AppError('NOT_FOUND', 'dataset version has no images; import annotations first');
    }
    const options: EvalOptions = { ...scheme.options, generatedAt: this.clock.now() };
    const report = evaluate(images, options);
    const inputHash = hashInput({
      images,
      iouThresholds: scheme.options.iouThresholds,
      interpolation: scheme.options.interpolation,
      excludeClassesWithoutGt: scheme.options.excludeClassesWithoutGt,
    });
    const { id, replayed } = insertReport({
      db: this.db,
      modelVersionId: args.modelVersionId,
      datasetVersionId: args.datasetVersionId,
      schemeId: args.schemeId,
      inputHash,
      payload: JSON.stringify(report),
      createdAt: this.clock.now(),
    });
    return { reportId: id, report, replayed };
  }

  getReport(reportId: number): ParsedReport & {
    reportId: number;
    modelVersionId: number;
    datasetVersionId: number;
    schemeId: number;
    frozen: boolean;
    createdAt: string;
  } {
    const row = this.db.prepare('SELECT * FROM reports WHERE id=?').get(reportId) as
      | {
          id: number;
          model_version_id: number;
          dataset_version_id: number;
          scheme_id: number;
          payload: string;
          frozen: number;
          created_at: string;
        }
      | undefined;
    if (!row) throw new AppError('NOT_FOUND', `report ${reportId} not found`);
    return {
      ...(JSON.parse(row.payload) as ParsedReport),
      reportId: row.id,
      modelVersionId: row.model_version_id,
      datasetVersionId: row.dataset_version_id,
      schemeId: row.scheme_id,
      frozen: row.frozen === 1,
      createdAt: row.created_at,
    };
  }

  listErrors(
    reportId: number,
    filter: { type?: string; category?: string; imageExternalId?: string; iouThreshold?: number },
    page: number,
    pageSize: number,
  ): { items: ParsedReport['errors']; total: number; page: number; pageSize: number } {
    const report = this.getReport(reportId);
    let items = report.errors;
    if (filter.type) items = items.filter((e) => e.type === filter.type);
    if (filter.category) items = items.filter((e) => e.category === filter.category);
    if (filter.imageExternalId) items = items.filter((e) => e.imageExternalId === filter.imageExternalId);
    if (filter.iouThreshold !== undefined) {
      items = items.filter((e) => e.iouThreshold === filter.iouThreshold);
    }
    const total = items.length;
    const start = page * pageSize;
    return { items: items.slice(start, start + pageSize), total, page, pageSize };
  }

  /**
   * Compare two model versions. Both must reference the same dataset version
   * and use the same eval scheme, otherwise comparison is rejected.
   */
  compareModels(args: {
    modelVersionIdA: number;
    modelVersionIdB: number;
    datasetVersionId: number;
    schemeId: number;
  }) {
    const a = this.runReport({
      modelVersionId: args.modelVersionIdA,
      datasetVersionId: args.datasetVersionId,
      schemeId: args.schemeId,
    });
    const b = this.runReport({
      modelVersionId: args.modelVersionIdB,
      datasetVersionId: args.datasetVersionId,
      schemeId: args.schemeId,
    });
    if (a.report.iouThresholds.join(',') !== b.report.iouThresholds.join(',')) {
      throw new AppError('RULE_MISMATCH', 'reports were produced with different IoU thresholds');
    }
    return {
      datasetVersionId: args.datasetVersionId,
      schemeId: args.schemeId,
      iouThresholds: a.report.iouThresholds,
      modelA: {
        modelVersionId: args.modelVersionIdA,
        reportId: a.reportId,
        mAP: a.report.mAP,
        mAPPerThreshold: a.report.mAPPerThreshold,
      },
      modelB: {
        modelVersionId: args.modelVersionIdB,
        reportId: b.reportId,
        mAP: b.report.mAP,
        mAPPerThreshold: b.report.mAPPerThreshold,
      },
      deltaMAP: round(b.report.mAP - a.report.mAP),
      deltaPerThreshold: b.report.mAPPerThreshold.map((v, i) => round(v - a.report.mAPPerThreshold[i])),
    };
  }
}

function validateThresholds(thresholds: number[]) {
  if (!Array.isArray(thresholds) || thresholds.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'iouThresholds must be a non-empty array');
  }
  for (const t of thresholds) {
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t >= 1) {
      throw new AppError('VALIDATION_ERROR', 'each IoU threshold must be within (0,1)', { t });
    }
  }
}

function round(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}
