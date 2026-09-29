import { DatabaseSync, type DatabaseSyncType } from './sqlite.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from './errors.js';
import type { EvalOptions } from './eval.js';
import type { GtBox, PredBox } from './types.js';

export interface DbContext {
  db: DatabaseSyncType;
  close(): void;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS dataset_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_version_id INTEGER NOT NULL REFERENCES dataset_versions(id),
  external_id TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  UNIQUE(dataset_version_id, external_id)
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_version_id INTEGER NOT NULL REFERENCES dataset_versions(id),
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('gt','prediction')),
  UNIQUE(dataset_version_id, name)
);

CREATE TABLE IF NOT EXISTS gt_boxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER NOT NULL REFERENCES images(id),
  category TEXT NOT NULL,
  left REAL NOT NULL, top REAL NOT NULL, right REAL NOT NULL, bottom REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS model_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prediction_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_version_id INTEGER NOT NULL REFERENCES model_versions(id),
  dataset_version_id INTEGER NOT NULL REFERENCES dataset_versions(id),
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(model_version_id, dataset_version_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES prediction_batches(id),
  model_version_id INTEGER NOT NULL REFERENCES model_versions(id),
  dataset_version_id INTEGER NOT NULL REFERENCES dataset_versions(id),
  image_id INTEGER NOT NULL REFERENCES images(id),
  category TEXT NOT NULL,
  confidence REAL NOT NULL,
  seq INTEGER NOT NULL,
  left REAL NOT NULL, top REAL NOT NULL, right REAL NOT NULL, bottom REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pred_lookup ON predictions(model_version_id, dataset_version_id, image_id);

CREATE TABLE IF NOT EXISTS eval_schemes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  iou_thresholds TEXT NOT NULL,
  interpolation TEXT NOT NULL CHECK(interpolation IN ('all_point','11_point')),
  exclude_classes_without_gt INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_version_id INTEGER NOT NULL REFERENCES model_versions(id),
  dataset_version_id INTEGER NOT NULL REFERENCES dataset_versions(id),
  scheme_id INTEGER NOT NULL REFERENCES eval_schemes(id),
  input_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  frozen INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(model_version_id, dataset_version_id, scheme_id, input_hash)
);
`;

export function openDatabase(path: string): DbContext {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  migrate(db);
  let isOpen = true;
  return {
    db,
    close: () => {
      if (isOpen) {
        db.close();
        isOpen = false;
      }
    },
  };
}

/** Idempotent migration: safe to run repeatedly on an existing database. */
export function migrate(db: DatabaseSyncType): void {
  db.exec(SCHEMA);
}

export interface ImageRow {
  externalId: string;
  width: number;
  height: number;
  gt: GtBox[];
}

export function insertDatasetVersion(
  db: DatabaseSyncType,
  params: { name: string; idempotencyKey?: string; note?: string; createdAt: string; images: ImageRow[] },
): { id: number; replayed: boolean } {
  if (params.idempotencyKey) {
    const existing = db
      .prepare('SELECT id FROM dataset_versions WHERE idempotency_key = ?')
      .get(params.idempotencyKey) as { id: number } | undefined;
    if (existing) return { id: existing.id, replayed: true };
  }
  const tx = db.prepare(
    `INSERT INTO dataset_versions(name, idempotency_key, note, created_at) VALUES(?,?,?,?)`,
  );
  const insImage = db.prepare(
    `INSERT INTO images(dataset_version_id, external_id, width, height) VALUES(?,?,?,?)`,
  );
  const insGt = db.prepare(
    `INSERT INTO gt_boxes(image_id, category, left, top, right, bottom) VALUES(?,?,?,?,?,?)`,
  );
  const insertCategory = db.prepare(
    `INSERT OR IGNORE INTO categories(dataset_version_id, name, source) VALUES(?,?, 'gt')`,
  );

  let id = -1;
  db.exec('BEGIN');
  try {
    const info = tx.run(params.name, params.idempotencyKey ?? null, params.note ?? null, params.createdAt);
    id = Number(info.lastInsertRowid);
    for (const im of params.images) {
      const imageInfo = insImage.run(id, im.externalId, im.width, im.height);
      const imageId = Number(imageInfo.lastInsertRowid);
      for (const g of im.gt) {
        insGt.run(imageId, g.category, g.left, g.top, g.right, g.bottom);
        insertCategory.run(id, g.category);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw mapUnique(err);
  }
  return { id, replayed: false };
}

export function getOrCreateModel(db: DatabaseSyncType, name: string, createdAt: string): number {
  const existing = db.prepare('SELECT id FROM model_versions WHERE name = ?').get(name) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  const info = db.prepare('INSERT INTO model_versions(name, created_at) VALUES(?,?)').run(name, createdAt);
  return Number(info.lastInsertRowid);
}

export interface PredictionRow {
  externalId: string;
  boxes: PredBox[];
}

export function insertPredictionBatch(args: {
  db: DatabaseSyncType;
  modelVersionId: number;
  datasetVersionId: number;
  idempotencyKey?: string;
  createdAt: string;
  rows: PredictionRow[];
}): { batchId: number; replayed: boolean } {
  const { db, modelVersionId, datasetVersionId, idempotencyKey, createdAt, rows } = args;
  if (idempotencyKey) {
    const existing = db
      .prepare(
        'SELECT id FROM prediction_batches WHERE model_version_id=? AND dataset_version_id=? AND idempotency_key=?',
      )
      .get(modelVersionId, datasetVersionId, idempotencyKey) as { id: number } | undefined;
    if (existing) return { batchId: existing.id, replayed: true };
  }
  const insBatch = db.prepare(
    `INSERT INTO prediction_batches(model_version_id, dataset_version_id, idempotency_key, created_at) VALUES(?,?,?,?)`,
  );
  const findImage = db.prepare(
    `SELECT id FROM images WHERE dataset_version_id=? AND external_id=?`,
  );
  const insPred = db.prepare(
    `INSERT INTO predictions(batch_id, model_version_id, dataset_version_id, image_id, category, confidence, seq, left, top, right, bottom)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insCat = db.prepare(
    `INSERT OR IGNORE INTO categories(dataset_version_id, name, source) VALUES(?,?, 'prediction')`,
  );

  let batchId = -1;
  db.exec('BEGIN');
  try {
    const info = insBatch.run(modelVersionId, datasetVersionId, idempotencyKey ?? null, createdAt);
    batchId = Number(info.lastInsertRowid);
    for (const row of rows) {
      const image = findImage.get(datasetVersionId, row.externalId) as { id: number } | undefined;
      if (!image) throw new AppError('NOT_FOUND', `unknown image: ${row.externalId}`);
      row.boxes.forEach((b, seq) => {
        insPred.run(batchId, modelVersionId, datasetVersionId, image.id, b.category, b.confidence, seq, b.left, b.top, b.right, b.bottom);
        insCat.run(datasetVersionId, b.category);
      });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw mapUnique(err);
  }
  return { batchId, replayed: false };
}

export function upsertScheme(
  db: DatabaseSyncType,
  scheme: { name: string; options: Omit<EvalOptions, 'generatedAt'>; createdAt: string },
): number {
  const existing = db.prepare('SELECT id FROM eval_schemes WHERE name = ?').get(scheme.name) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  const info = db
    .prepare(
      `INSERT INTO eval_schemes(name, iou_thresholds, interpolation, exclude_classes_without_gt, created_at)
       VALUES(?,?,?,?,?)`,
    )
    .run(
      scheme.name,
      JSON.stringify(scheme.options.iouThresholds),
      scheme.options.interpolation,
      scheme.options.excludeClassesWithoutGt ? 1 : 0,
      scheme.createdAt,
    );
  return Number(info.lastInsertRowid);
}

export function getScheme(db: DatabaseSyncType, id: number) {
  const row = db.prepare('SELECT * FROM eval_schemes WHERE id = ?').get(id) as
    | {
        id: number;
        name: string;
        iou_thresholds: string;
        interpolation: 'all_point' | '11_point';
        exclude_classes_without_gt: number;
      }
    | undefined;
  if (!row) throw new AppError('NOT_FOUND', `eval scheme ${id} not found`);
  return {
    id: row.id,
    name: row.name,
    options: {
      iouThresholds: JSON.parse(row.iou_thresholds) as number[],
      interpolation: row.interpolation,
      excludeClassesWithoutGt: row.exclude_classes_without_gt === 1,
    },
  };
}

export function loadEvalImages(
  db: DatabaseSyncType,
  modelVersionId: number,
  datasetVersionId: number,
) {
  const images = db
    .prepare('SELECT id, external_id, width, height FROM images WHERE dataset_version_id=? ORDER BY id')
    .all(datasetVersionId) as { id: number; external_id: string; width: number; height: number }[];
  const gtStmt = db.prepare('SELECT category,left,top,right,bottom FROM gt_boxes WHERE image_id=?');
  const predStmt = db.prepare(
    'SELECT category,confidence,left,top,right,bottom FROM predictions WHERE model_version_id=? AND dataset_version_id=? AND image_id=? ORDER BY seq',
  );
  return images.map((im) => ({
    externalId: im.external_id,
    width: im.width,
    height: im.height,
    gt: (gtStmt.all(im.id) as any[]).map((g) => ({
      category: g.category,
      left: g.left,
      top: g.top,
      right: g.right,
      bottom: g.bottom,
    })),
    predictions: (predStmt.all(modelVersionId, datasetVersionId, im.id) as any[]).map((p) => ({
      category: p.category,
      confidence: p.confidence,
      left: p.left,
      top: p.top,
      right: p.right,
      bottom: p.bottom,
    })),
  }));
}

export function insertReport(args: {
  db: DatabaseSyncType;
  modelVersionId: number;
  datasetVersionId: number;
  schemeId: number;
  inputHash: string;
  payload: string;
  createdAt: string;
}): { id: number; replayed: boolean } {
  const existing = args.db
    .prepare(
      'SELECT id FROM reports WHERE model_version_id=? AND dataset_version_id=? AND scheme_id=? AND input_hash=?',
    )
    .get(args.modelVersionId, args.datasetVersionId, args.schemeId, args.inputHash) as
    | { id: number }
    | undefined;
  if (existing) return { id: existing.id, replayed: true };
  const info = args.db
    .prepare(
      `INSERT INTO reports(model_version_id, dataset_version_id, scheme_id, input_hash, payload, created_at)
       VALUES(?,?,?,?,?,?)`,
    )
    .run(
      args.modelVersionId,
      args.datasetVersionId,
      args.schemeId,
      args.inputHash,
      args.payload,
           args.createdAt,
    );
  return { id: Number(info.lastInsertRowid), replayed: false };
}

function mapUnique(err: unknown): unknown {
  if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
    return new AppError('CONFLICT', `idempotency key conflict or duplicate submission: ${err.message}`);
  }
  return err;
}
