import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './db.js';
import { EvalService, utcClock } from './service.js';
import { generateDataset } from './generate.js';

function fixedClock() {
  let n = 0;
  return { now: () => `2026-01-01T00:00:${String(n++).padStart(2, '0')}.000Z` };
}

export function runDemo(): { dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'odet-demo-'));
  const dbPath = join(dir, 'demo.sqlite');
  const { db, close } = openDatabase(dbPath);
  const service = new EvalService(db, fixedClock());

  // 1. Synthetic dataset v1 (deterministic seed).
  const gen = generateDataset({
    seed: 7,
    imageCount: 12,
    categories: ['cat', 'dog', 'car'],
    emptyRate: 0.15,
    missRate: 0.15,
    duplicateRate: 0.2,
    localizationErrorRate: 0.15,
    wrongClassRate: 0.1,
    backgroundFpRate: 0.15,
  });
  const ds1 = service.importDataset({ name: 'demo-v1', idempotencyKey: 'demo-v1', images: gen.images });
  const mA = service.importPredictions({
    modelName: 'model-A',
    datasetVersionId: ds1.datasetVersionId,
    idempotencyKey: 'demo-v1-A',
    rows: gen.predictions,
  });

  // 2. Annotation revision: append a brand-new immutable version; old reports stay valid.
  const revised = gen.images.map((im) => ({
    ...im,
    gt: im.gt.filter((_, i) => i % 2 === 0),
  }));
  const ds2 = service.importDataset({
    name: 'demo-v2-revised',
    idempotencyKey: 'demo-v2',
    note: 'revision: half the GT removed',
    images: revised,
  });

  // 3. Second model on v1 for comparison.
  const genB = generateDataset({
    seed: 99,
    imageCount: 12,
    categories: ['cat', 'dog', 'car'],
    emptyRate: 0.1,
    missRate: 0.3,
    duplicateRate: 0.05,
    localizationErrorRate: 0.1,
    wrongClassRate: 0.05,
    backgroundFpRate: 0.05,
  });
  const mB = service.importPredictions({
    modelName: 'model-B',
    datasetVersionId: ds1.datasetVersionId,
    idempotencyKey: 'demo-v1-B',
    rows: genB.predictions,
  });

  const cocoLike = service.createScheme({
    name: 'coco-like',
    iouThresholds: [0.5, 0.75],
    interpolation: 'all_point',
  });

  const reportA = service.runReport({
    modelVersionId: mA.modelVersionId,
    datasetVersionId: ds1.datasetVersionId,
    schemeId: cocoLike.schemeId,
  });
  service.runReport({
    modelVersionId: mB.modelVersionId,
    datasetVersionId: ds1.datasetVersionId,
    schemeId: cocoLike.schemeId,
  });

  const comparison = service.compareModels({
    modelVersionIdA: mA.modelVersionId,
    modelVersionIdB: mB.modelVersionId,
    datasetVersionId: ds1.datasetVersionId,
    schemeId: cocoLike.schemeId,
  });
  const errors = service.listErrors(reportA.reportId, {}, 0, 5);

  console.log('=== ODET end-to-end demo ===');
  console.log(`dataset versions: v1=${ds1.datasetVersionId} (${gen.images.length} images), revised v2=${ds2.datasetVersionId}`);
  console.log(`models: A=${mA.modelVersionId}, B=${mB.modelVersionId}; scheme=${cocoLike.schemeId}`);
  reportA.report.iouThresholds.forEach((t, i) => {
    console.log(`model-A mAP@${t} = ${reportA.report.mAPPerThreshold[i].toFixed(4)}`);
  });
  console.log(`model-A mAP(0.5:0.75) = ${reportA.report.mAP.toFixed(4)}`);
  console.log(`comparison delta mAP B-A = ${comparison.deltaMAP.toFixed(4)}`);
  console.log(`error samples (first page): ${errors.items.length}/${errors.total}`);
  for (const e of errors.items) console.log(`  - [${e.type}] ${e.imageExternalId} ${e.category}: ${e.detail}`);
  void utcClock;

  close();
  return { dbPath, dir };
}

const { dir } = runDemo();
rmSync(dir, { recursive: true, force: true });
