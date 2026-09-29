import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrate } from "../db/database.ts";
import type { DatabaseSync } from "node:sqlite";
import { importDataset } from "./catalog.ts";
import { importPredictions } from "./models.ts";
import { upsertProtocol } from "./protocols.ts";
import { runEvaluation } from "./evaluate.ts";
import { compareReports, listErrorSamples, listReports } from "./queries.ts";
import { AppError } from "../core/errors.ts";

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "odet-"));
});
after(() => removeRetry(dir));

function removeRetry(target: string, attempts = 5): void {
  for (let i = 0; i < attempts; i += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      const until = Date.now() + 100;
      while (Date.now() < until) {}
    }
  }
}

function dataset() {
  return {
    slug: "fixture",
    categories: [{ id: 1, name: "cat" }, { id: 2, name: "dog" }],
    images: [
      { key: "empty", width: 50, height: 50, boxes: [] },
      {
        key: "a",
        width: 50,
        height: 50,
        boxes: [
          { categoryId: 1, x: 0, y: 0, w: 10, h: 10 },
          { categoryId: 2, x: 20, y: 20, w: 10, h: 10 },
        ],
      },
    ],
  };
}

test("invalid dimension and out-of-bound box reject before any version row (rollback)", () => {
  const db = openDatabase(join(dir, "rollback.sqlite"));
  migrate(db);
  const badSize = dataset();
  badSize.images[1]!.width = 0 as unknown as number;
  assert.throws(() => importDataset(db, badSize), (e: unknown) => e instanceof AppError && e.code === "INVALID_DIMENSION");

  const oob = dataset();
  oob.images[1]!.boxes[0]!.w = 999;
  assert.throws(() => importDataset(db, oob), (e: unknown) => e instanceof AppError && e.code === "BOX_OUT_OF_BOUNDS");

  assert.equal((db.prepare("SELECT COUNT(*) n FROM dataset_versions").get() as { n: number }).n, 0);
  db.close();
});

test("idempotent dataset replay returns same version; revision creates a new version", () => {
  const db = openDatabase(join(dir, "v.sqlite"));
  migrate(db);
  const first = importDataset(db, dataset());
  const replay = importDataset(db, dataset());
  assert.equal(replay.datasetVersionId, first.datasetVersionId);
  assert.equal(replay.reused, true);

  const revised = dataset();
  revised.images[1]!.boxes.push({ categoryId: 1, x: 5, y: 5, w: 5, h: 5 });
  const v2 = importDataset(db, revised);
  assert.notEqual(v2.datasetVersionId, first.datasetVersionId);
  assert.equal(v2.version, 2);
  db.close();
});

test("prediction score out of range rejected", () => {
  const db = openDatabase(join(dir, "score.sqlite"));
  migrate(db);
  const ds = importDataset(db, dataset());
  assert.throws(
    () =>
      importPredictions(db, {
        modelName: "m",
        datasetVersionId: ds.datasetVersionId,
        predictions: [{ imageKey: "a", categoryId: 1, score: 1.2, x: 0, y: 0, w: 1, h: 1 }],
      }),
    (e: unknown) => e instanceof AppError && e.code === "INVALID_SCORE",
  );
  db.close();
});

test("unknown category in prediction rejected", () => {
  const db = openDatabase(join(dir, "cat.sqlite"));
  migrate(db);
  const ds = importDataset(db, dataset());
  assert.throws(
    () =>
      importPredictions(db, {
        modelName: "m",
        datasetVersionId: ds.datasetVersionId,
        predictions: [{ imageKey: "a", categoryId: 99, score: 0.5, x: 0, y: 0, w: 1, h: 1 }],
      }),
    (e: unknown) => e instanceof AppError,
  );
  db.close();
});

test("full flow: perfect mAP=1, noisy mAP<1, replay identical, report survives reopen", () => {
  const file = join(dir, "flow.sqlite");
  const db = openDatabase(file);
  migrate(db);
  const ds = importDataset(db, dataset());
  const perfect = importPredictions(db, {
    modelName: "perfect",
    datasetVersionId: ds.datasetVersionId,
    predictions: [
      { imageKey: "a", categoryId: 1, score: 1, x: 0, y: 0, w: 10, h: 10 },
      { imageKey: "a", categoryId: 2, score: 1, x: 20, y: 20, w: 10, h: 10 },
    ],
  });
  const proto = upsertProtocol(db, { name: "p", iouThresholds: [0.5, 0.75] });
  const r1 = runEvaluation(db, ds.datasetVersionId, perfect.modelVersionId, proto.id);
  assert.equal(r1.map, 1);
  const r1replay = runEvaluation(db, ds.datasetVersionId, perfect.modelVersionId, proto.id);
  assert.equal(r1replay.reportId, r1.reportId);
  assert.equal(r1replay.reused, true);

  const noisy = importPredictions(db, {
    modelName: "noisy",
    datasetVersionId: ds.datasetVersionId,
    predictions: [
      { imageKey: "a", categoryId: 1, score: 0.9, x: 0, y: 0, w: 10, h: 10 },
      { imageKey: "a", categoryId: 1, score: 0.5, x: 0, y: 0, w: 10, h: 10 },
    ],
  });
  const r2 = runEvaluation(db, ds.datasetVersionId, noisy.modelVersionId, proto.id);
  assert.ok(r2.map < 1);

  const errors = listErrorSamples(db, r2.reportId, { page: 1, pageSize: 50 });
  assert.ok(errors.data.some((e) => e.errorKind === "missed"));
  assert.ok(errors.data.some((e) => e.errorKind === "duplicate"));

  const cmp = compareReports(db, r1.reportId, r2.reportId);
  assert.ok(cmp.deltaOverallMap < 0);

  const reports = listReports(db, { page: 1, pageSize: 10 });
  assert.ok(reports.total >= 2);

  db.close();

  const reopened = openDatabase(file);
  migrate(reopened);
  const again = runEvaluation(reopened, ds.datasetVersionId, perfect.modelVersionId, proto.id);
  assert.equal(again.reportId, r1.reportId);
  assert.equal(again.map, 1);
  reopened.close();
});

test("comparison across different dataset versions is rejected", () => {
  const db = openDatabase(join(dir, "cmp.sqlite"));
  migrate(db);
  const ds1 = importDataset(db, dataset());
  const revised = dataset();
  revised.slug = "fixture";
  revised.images[1]!.boxes[0]!.x = 1;
  const ds2 = importDataset(db, revised);
  const p1 = importPredictions(db, {
    modelName: "m",
    datasetVersionId: ds1.datasetVersionId,
    predictions: [{ imageKey: "a", categoryId: 1, score: 1, x: 0, y: 0, w: 10, h: 10 }, { imageKey: "a", categoryId: 2, score: 1, x: 20, y: 20, w: 10, h: 10 }],
  });
  const proto = upsertProtocol(db, { name: "p", iouThresholds: [0.5] });
  const r1 = runEvaluation(db, ds1.datasetVersionId, p1.modelVersionId, proto.id);

  const ds2preds = revised.images.flatMap((img) =>
    img.boxes.map((b) => ({ imageKey: img.key, categoryId: b.categoryId, score: 1, x: b.x, y: b.y, w: b.w, h: b.h })),
  );
  const p2 = importPredictions(db, { modelName: "m2", datasetVersionId: ds2.datasetVersionId, predictions: ds2preds });
  const r2 = runEvaluation(db, ds2.datasetVersionId, p2.modelVersionId, proto.id);

  assert.throws(() => compareReports(db, r1.reportId, r2.reportId), (e: unknown) => e instanceof AppError && e.code === "RULE_MISMATCH");
  db.close();
});

test("deterministic generator is repeatable", async () => {
  const { generateDataset, generatePredictions } = await import("../synth/generator.ts");
  const a = generateDataset("x", 123);
  const b = generateDataset("x", 123);
  assert.deepEqual(a, b);
  assert.deepEqual(
    generatePredictions(a, 9, { jitter: 3, duplicateRate: 0.5 }),
    generatePredictions(b, 9, { jitter: 3, duplicateRate: 0.5 }),
  );
});
