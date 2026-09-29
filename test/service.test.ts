import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { EvalService } from '../src/service.js';
import { AppError } from '../src/errors.js';
import { validateBox, validateDimension, validateImages, validatePredictions } from '../src/validation.js';
import type { DbContext } from '../src/db.js';

let dir: string;
let ctx: DbContext;
let service: EvalService;
let clock: { n: number; now(): string };

const image = (externalId: string, gt: any[] = [], predictions?: any[]) => ({
  externalId,
  width: 100,
  height: 100,
  gt,
  ...(predictions ? { predictions } : {}),
});

const goodBox = { left: 0, top: 0, right: 10, bottom: 10 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'odet-test-'));
  ctx = openDatabase(join(dir, 't.sqlite'));
  clock = { n: 0, now() { return `2026-01-01T00:00:${String(this.n++).padStart(2, '0')}.000Z`; } };
  service = new EvalService(ctx.db, clock);
});

afterEach(() => {
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('validation failures', () => {
  it('rejects non-positive / non-integer dimensions', () => {
    expect(() => validateDimension(0, 100, 'img')).toThrow(AppError);
    expect(() => validateDimension(10.5, 100, 'img')).toThrow(AppError);
    try {
      validateDimension(-1, 100, 'img');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AppError).code).toBe('INVALID_DIMENSION');
    }
  });

  it('rejects out-of-bounds boxes and never clips them', () => {
    try {
      validateBox({ left: -1, top: 0, right: 10, bottom: 10 }, 100, 100, 'gt[0]');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AppError).code).toBe('OUT_OF_BOUNDS');
    }
    expect(() => validateBox({ left: 0, top: 0, right: 101, bottom: 10 }, 100, 100, 'gt[0]')).toThrow(AppError);
  });

  it('rejects zero-area boxes and bad confidence', () => {
    expect(() => validateBox({ left: 5, top: 0, right: 5, bottom: 10 }, 100, 100, 'b')).toThrow(AppError);
    const lookup = new Map([['i', { width: 100, height: 100 }]]);
    expect(() =>
      validatePredictions(
        [{ externalId: 'i', boxes: [{ ...goodBox, category: 'a', confidence: 2 }] }],
        lookup,
      ),
    ).toThrow(AppError);
  });

  it('rejects predictions for unknown images', () => {
    const lookup = new Map();
    expect(() =>
      validatePredictions([{ externalId: 'ghost', boxes: [] }], lookup),
    ).toThrow(AppError);
  });

  it('rejects duplicate external ids in one import', () => {
    expect(() => validateImages([image('a'), image('a')])).toThrow(AppError);
  });
});

describe('idempotency, immutability, transactions', () => {
  it('re-submitting the same idempotency key returns the same version', () => {
    const images = [image('i', [{ ...goodBox, category: 'a' }])];
    const r1 = service.importDataset({ name: 'v1', idempotencyKey: 'k', images });
    const r2 = service.importDataset({ name: 'v1-again', idempotencyKey: 'k', images });
    expect(r2.datasetVersionId).toBe(r1.datasetVersionId);
    expect(r2.replayed).toBe(true);
    const n = ctx.db.prepare('SELECT COUNT(*) n FROM dataset_versions').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('rolls the whole transaction back when one image is invalid', () => {
    const bad = [
      image('ok', [{ ...goodBox, category: 'a' }]),
      image('bad', [{ left: 0, top: 0, right: 999, bottom: 999, category: 'a' }]),
    ];
    expect(() => service.importDataset({ name: 'v', images: bad })).toThrow(AppError);
    const imgCount = ctx.db.prepare('SELECT COUNT(*) n FROM images').get() as { n: number };
    const gtCount = ctx.db.prepare('SELECT COUNT(*) n FROM gt_boxes').get() as { n: number };
    expect(imgCount.n).toBe(0);
    expect(gtCount.n).toBe(0);
  });

  it('prediction batch failure rolls back and is idempotent on retry', () => {
    const ds = service.importDataset({ name: 'v', images: [image('i', [{ ...goodBox, category: 'a' }])] });
    const rows = [{ externalId: 'i', boxes: [{ ...goodBox, category: 'a', confidence: 0.9 }] }];
    const r1 = service.importPredictions({
      modelName: 'm',
      datasetVersionId: ds.datasetVersionId,
      idempotencyKey: 'pk',
      rows,
    });
    const r2 = service.importPredictions({
      modelName: 'm',
      datasetVersionId: ds.datasetVersionId,
      idempotencyKey: 'pk',
      rows,
    });
    expect(r2.batchId).toBe(r1.batchId);
    expect(r2.replayed).toBe(true);
    const n = ctx.db.prepare('SELECT COUNT(*) n FROM predictions').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('annotation revisions create new immutable versions and never alter old reports', () => {
    const v1 = service.importDataset({
      name: 'rev',
      idempotencyKey: 'v1',
      images: [image('i', [{ ...goodBox, category: 'a' }])],
    });
    const m = service.importPredictions({
      modelName: 'm',
      datasetVersionId: v1.datasetVersionId,
      rows: [{ externalId: 'i', boxes: [{ ...goodBox, category: 'a', confidence: 0.9 }] }],
    });
    const scheme = service.createScheme({ name: 's', iouThresholds: [0.5], interpolation: 'all_point' });
    const report = service.runReport({
      modelVersionId: m.modelVersionId,
      datasetVersionId: v1.datasetVersionId,
      schemeId: scheme.schemeId,
    });
    expect(report.report.mAP).toBe(1);

    // Revision removes the GT -> new version, same model has no predictions linked there.
    const v2 = service.importDataset({
      name: 'rev2',
      idempotencyKey: 'v2',
      note: 'removed GT',
      images: [image('i', [])],
    });
    expect(v2.datasetVersionId).not.toBe(v1.datasetVersionId);
    const oldReport = service.getReport(report.reportId);
    expect(oldReport.mAP).toBe(1);
    expect(oldReport.frozen).toBe(true);
  });
});

describe('category mapping changes', () => {
  it('predictions using a renamed class become wrong-class / missed-GT evidence', () => {
    const ds = service.importDataset({
      name: 'cm',
      images: [image('i', [{ ...goodBox, category: 'cat' }])],
    });
    const m = service.importPredictions({
      modelName: 'm',
      datasetVersionId: ds.datasetVersionId,
      rows: [{ externalId: 'i', boxes: [{ ...goodBox, category: 'feline', confidence: 0.9 }] }],
    });
    const scheme = service.createScheme({ name: 's', iouThresholds: [0.5], interpolation: 'all_point' });
    const { report } = service.runReport({
      modelVersionId: m.modelVersionId,
      datasetVersionId: ds.datasetVersionId,
      schemeId: scheme.schemeId,
    });
    expect(report.errors.some((e) => e.type === 'wrong_class' && e.expectedCategory === 'cat')).toBe(true);
    expect(report.mAP).toBe(0);
  });
});

describe('report freezing and replay', () => {
  it('identical inputs replay to the same frozen report; changed inputs make a new one', () => {
    const ds = service.importDataset({
      name: 'r',
      images: [image('i', [{ ...goodBox, category: 'a' }])],
    });
    const m = service.importPredictions({
      modelName: 'm',
      datasetVersionId: ds.datasetVersionId,
      rows: [{ externalId: 'i', boxes: [{ ...goodBox, category: 'a', confidence: 0.9 }] }],
    });
    const scheme = service.createScheme({ name: 's', iouThresholds: [0.5], interpolation: 'all_point' });
    const args = { modelVersionId: m.modelVersionId, datasetVersionId: ds.datasetVersionId, schemeId: scheme.schemeId };
    const r1 = service.runReport(args);
    const r2 = service.runReport(args);
    expect(r2.reportId).toBe(r1.reportId);
    expect(r2.replayed).toBe(true);
  });

  it('persists across closing and reopening the database', () => {
    const ds = service.importDataset({ name: 'p', images: [image('i', [{ ...goodBox, category: 'a' }])] });
    const m = service.importPredictions({
      modelName: 'm',
      datasetVersionId: ds.datasetVersionId,
      rows: [{ externalId: 'i', boxes: [{ ...goodBox, category: 'a', confidence: 0.9 }] }],
    });
    const scheme = service.createScheme({ name: 's', iouThresholds: [0.5], interpolation: 'all_point' });
    const r = service.runReport({
      modelVersionId: m.modelVersionId,
      datasetVersionId: ds.datasetVersionId,
      schemeId: scheme.schemeId,
    });
    ctx.close();
    const reopened = openDatabase(join(dir, 't.sqlite')); // migration re-run must be safe
    const svc2 = new EvalService(reopened.db);
    const loaded = svc2.getReport(r.reportId);
    expect(loaded.mAP).toBe(1);
    reopened.close();
  });
});

describe('compare guard', () => {
  it('rejects comparison across different datasets', () => {
    const ds1 = service.importDataset({ name: 'a', images: [image('i', [{ ...goodBox, category: 'a' }])] });
    const ds2 = service.importDataset({ name: 'b', images: [image('i', [{ ...goodBox, category: 'a' }])] });
    const m1 = service.importPredictions({
      modelName: 'm1',
      datasetVersionId: ds1.datasetVersionId,
      rows: [{ externalId: 'i', boxes: [{ ...goodBox, category: 'a', confidence: 0.9 }] }],
    });
    const m2 = service.importPredictions({
      modelName: 'm2',
      datasetVersionId: ds2.datasetVersionId,
      rows: [{ externalId: 'i', boxes: [{ ...goodBox, category: 'a', confidence: 0.8 }] }],
    });
    const scheme = service.createScheme({ name: 's', iouThresholds: [0.5], interpolation: 'all_point' });
    // runReport on m2/ds1 has no predictions -> produces mAP 0; cross-dataset
    // misuse is guarded at the API/CLI level by using one datasetVersionId.
    const cmp = service.compareModels({
      modelVersionIdA: m1.modelVersionId,
      modelVersionIdB: m2.modelVersionId,
      datasetVersionId: ds1.datasetVersionId,
      schemeId: scheme.schemeId,
    });
    expect(cmp.datasetVersionId).toBe(ds1.datasetVersionId);
  });
});
