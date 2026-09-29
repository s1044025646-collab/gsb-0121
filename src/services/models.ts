import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../core/errors.ts";
import { isFiniteNumber } from "../core/geometry.ts";
import { contentHash } from "./serial.ts";
import { inTransaction } from "../db/tx.ts";

export interface PredInput {
  imageKey: string;
  categoryId: number;
  score: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PredictionSubmission {
  modelName: string;
  datasetVersionId: number;
  predictions: PredInput[];
}

export interface PredictionImportResult {
  modelVersionId: number;
  datasetVersionId: number;
  reused: boolean;
  predictionCount: number;
}

function assert(cond: unknown, code: string, message: string): asserts cond {
  if (!cond) throw new AppError(code, message, 422);
}

export function validatePredictionSubmission(db: DatabaseSync, raw: unknown): PredictionSubmission {
  assert(typeof raw === "object" && raw !== null, "VALIDATION", "payload must be an object.");
  const p = raw as Record<string, unknown>;
  assert(typeof p.modelName === "string" && p.modelName.trim().length > 0, "VALIDATION", "modelName required.");
  assert(
    isFiniteNumber(p.datasetVersionId) && Number.isInteger(p.datasetVersionId),
    "VALIDATION",
    "datasetVersionId must be an integer.",
  );
  assert(Array.isArray(p.predictions), "VALIDATION", "predictions must be an array.");

  const dvId = p.datasetVersionId as number;
  const dv = db.prepare("SELECT id FROM dataset_versions WHERE id = ?").get(dvId);
  if (!dv) throw new AppError("NOT_FOUND", `dataset version ${dvId} not found.`, 404);

  const images = db
    .prepare("SELECT id, image_key, width, height FROM images WHERE dataset_version_id = ?")
    .all(dvId) as { id: number; image_key: string; width: number; height: number }[];
  const byKey = new Map(images.map((i) => [i.image_key, i]));
  const cats = new Set(
    (
      db
        .prepare("SELECT category_id FROM dataset_categories WHERE dataset_version_id = ?")
        .all(dvId) as { category_id: number }[]
    ).map((c) => c.category_id),
  );

  const predictions: PredInput[] = [];
  (p.predictions as unknown[]).forEach((rawPred, idx) => {
    const ref = `predictions[${idx}]`;
    const b = rawPred as Record<string, unknown>;
    assert(typeof b.imageKey === "string" && b.imageKey.length > 0, "VALIDATION", `${ref}.imageKey required.`);
    const image = byKey.get(b.imageKey as string);
    assert(!!image, "NOT_FOUND", `${ref}: image key "${String(b.imageKey)}" not in dataset version ${dvId}.`);
    assert(isFiniteNumber(b.categoryId) && Number.isInteger(b.categoryId), "VALIDATION", `${ref}.categoryId must be integer.`);
    assert(cats.has(b.categoryId as number), "VALIDATION", `${ref}.categoryId ${String(b.categoryId)} not in dataset category mapping.`);
    assert(isFiniteNumber(b.score), "INVALID_SCORE", `${ref}.score must be a finite number.`);
    assert(b.score >= 0 && b.score <= 1, "INVALID_SCORE", `${ref}.score ${String(b.score)} outside [0,1].`);
    for (const k of ["x", "y", "w", "h"] as const) {
      assert(isFiniteNumber(b[k]), "INVALID_BOX", `${ref}.${k} must be finite.`);
    }
    const box = {
      imageKey: b.imageKey as string,
      categoryId: b.categoryId as number,
      score: b.score as number,
      x: b.x as number,
      y: b.y as number,
      w: b.w as number,
      h: b.h as number,
    };
    assert(box.w > 0 && box.h > 0, "INVALID_BOX", `${ref} must have positive w/h; clipping is not allowed.`);
    assert(box.x >= 0 && box.y >= 0, "BOX_OUT_OF_BOUNDS", `${ref} negative origin.`);
    assert(
      box.x + box.w <= image!.width + 1e-9 && box.y + box.h <= image!.height + 1e-9,
      "BOX_OUT_OF_BOUNDS",
      `${ref} exceeds image ${image!.width}x${image!.height}.`,
    );
    predictions.push(box);
  });

  return { modelName: p.modelName.trim(), datasetVersionId: dvId, predictions };
}

export function importPredictions(
  db: DatabaseSync,
  raw: unknown,
  now: () => string = () => new Date().toISOString(),
): PredictionImportResult {
  const sub = validatePredictionSubmission(db, raw);
  const hash = contentHash(sub);

  const existing = db
    .prepare("SELECT id FROM model_versions WHERE content_hash = ?")
    .get(hash) as { id: number } | undefined;
  if (existing) {
    return {
      modelVersionId: existing.id,
      datasetVersionId: sub.datasetVersionId,
      reused: true,
      predictionCount: sub.predictions.length,
    };
  }

  const run = () => inTransaction(db, () => {
    const info = db
      .prepare("INSERT INTO model_versions(name, content_hash, created_at) VALUES (?,?,?)")
      .run(sub.modelName, hash, now());
    const modelId = Number(info.lastInsertRowid);

    const images = db
      .prepare("SELECT id, image_key FROM images WHERE dataset_version_id = ?")
      .all(sub.datasetVersionId) as { id: number; image_key: string }[];
    const byKey = new Map(images.map((i) => [i.image_key, i.id]));
    const ins = db.prepare(
      "INSERT INTO predictions(model_version_id, dataset_version_id, image_id, category_id, score, x,y,w,h) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    for (const pr of sub.predictions) {
      (ins.run as (...a: unknown[]) => unknown)(
        modelId,
        sub.datasetVersionId,
        byKey.get(pr.imageKey)!,
        pr.categoryId,
        pr.score,
        pr.x,
        pr.y,
        pr.w,
        pr.h,
      );
    }
    return modelId;
  });

  const modelId = run();
  return {
    modelVersionId: modelId,
    datasetVersionId: sub.datasetVersionId,
    reused: false,
    predictionCount: sub.predictions.length,
  };
}
