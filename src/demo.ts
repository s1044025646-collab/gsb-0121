import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, migrate } from "./db/database.ts";
import { importDataset } from "./services/catalog.ts";
import { importPredictions } from "./services/models.ts";
import { upsertProtocol } from "./services/protocols.ts";
import { runEvaluation } from "./services/evaluate.ts";
import { compareReports, listErrorSamples } from "./services/queries.ts";
import {
  generateDataset,
  generatePredictions,
  perfectPredictions,
} from "./synth/generator.ts";

function main(): void {
  const dir = resolve("data/demo");
  rmSync(dir, { recursive: true, force: true });
  const db = openDatabase(resolve(dir, "demo.sqlite"));
  migrate(db);

  const dataset = generateDataset("demo", 42, { imageCount: 5, emptyImageCount: 1, boxCount: 2 });
  const ds = importDataset(db, dataset);
  console.log(`dataset v${ds.version} id=${ds.datasetVersionId} (images=${ds.imageCount}, gt=${ds.boxCount})`);

  const good = importPredictions(db, {
    modelName: "model-good",
    datasetVersionId: ds.datasetVersionId,
    predictions: perfectPredictions(dataset),
  });
  const noisy = importPredictions(db, {
    modelName: "model-noisy",
    datasetVersionId: ds.datasetVersionId,
    predictions: generatePredictions(dataset, 7, {
      recall: 0.8,
      jitter: 6,
      wrongClassRate: 0.1,
      duplicateRate: 0.2,
      backgroundRate: 0.3,
    }),
  });
  console.log(`models good=${good.modelVersionId} noisy=${noisy.modelVersionId}`);

  const protocol = upsertProtocol(db, {
    name: "voc-0.5",
    iouThresholds: [0.5],
    wrongClassIou: 0.1,
    duplicateIou: 0.5,
  });
  const reportGood = runEvaluation(db, ds.datasetVersionId, good.modelVersionId, protocol.id);
  const reportNoisy = runEvaluation(db, ds.datasetVersionId, noisy.modelVersionId, protocol.id);
  console.log(`mAP good=${reportGood.map} noisy=${reportNoisy.map}`);

  const errors = listErrorSamples(db, reportNoisy.reportId, { page: 1, pageSize: 5 });
  console.log(`noisy error kinds (first ${errors.data.length} of ${errors.total}):`);
  for (const e of errors.data) console.log(`  [${e.errorKind}] ${e.imageKey} cat=${e.categoryId} :: ${e.detail}`);

  const cmp = compareReports(db, reportGood.reportId, reportNoisy.reportId);
  console.log(`comparison delta overall mAP=${cmp.deltaOverallMap}`);

  const replay = runEvaluation(db, ds.datasetVersionId, noisy.modelVersionId, protocol.id);
  console.log(`replay report id ${replay.reportId} == ${reportNoisy.reportId} ? ${replay.reportId === reportNoisy.reportId}`);
  db.close();
}

main();
