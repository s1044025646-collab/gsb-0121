#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { openDatabase } from './db.js';
import { EvalService } from './service.js';
import { validateImages, validatePredictions } from './validation.js';
import { AppError } from './errors.js';
import { generateDataset } from './generate.js';

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function count(db: import('node:sqlite').DatabaseSync, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...(params as never[])) as { n: number };
  return row.n;
}

type CliOptions = Record<string, unknown>;

function run(
  action: (
    service: EvalService,
    db: import('./sqlite.js').DatabaseSyncType,
    opts: Record<string, string>,
  ) => void,
) {
  return (...args: unknown[]) => {
    const command = args[args.length - 1] as {
      opts(): CliOptions;
      parent?: { opts(): CliOptions };
    };
    const options = { ...command.parent?.opts(), ...command.opts() };
    const opts = Object.fromEntries(
      Object.entries(options).map(([k, v]) => {
        if (Array.isArray(v)) return [k, v.join(',')];
        if (k === 'thresholds' && typeof v === 'string') {
          // PowerShell may hand a comma list over as space-separated argv.
          return [k, v.trim().split(/[\s,]+/).join(',')];
        }
        return [k, String(v ?? '')];
      }),
    ) as Record<string, string>;
    const ctx = openDatabase(opts.db ?? 'data/odet.sqlite');
    try {
      const service = new EvalService(ctx.db);
      action(service, ctx.db, opts);
    } catch (err) {
      if (err instanceof AppError) {
        console.error(`[error ${err.code}] ${err.message}`);
        if (err.details) console.error(JSON.stringify(err.details, null, 2));
        process.exitCode = 1;
      } else {
        throw err;
      }
    } finally {
      ctx.close();
    }
  };
}

const program = new Command();
program
  .name('odet')
  .description('Object-detection evaluation & false-positive attribution CLI')
  .option('--db <path>', 'SQLite database path', 'data/odet.sqlite');

program
  .command('import-annotations')
  .description('Import a dataset version from a JSON file (creates an immutable new version)')
  .requiredOption('--file <path>', 'annotations JSON')
  .requiredOption('--name <name>', 'dataset version name')
  .option('--note <note>', 'revision note')
  .option('--idempotency-key <key>', 'idempotency key')
  .action(
    run((service, db, opts) => {
      const raw = loadJson(opts.file);
      const payload = (Array.isArray(raw) ? raw : (raw as { images: unknown[] }).images) as unknown[];
      const before = count(db, 'SELECT COUNT(*) n FROM dataset_versions');
      const images = validateImages(payload);
      const result = service.importDataset({
        name: opts.name,
        note: opts.note,
        idempotencyKey: opts.idempotencyKey,
        images,
      });
      const after = count(db, 'SELECT COUNT(*) n FROM dataset_versions');
      console.log(`dataset versions: ${before} -> ${after}`);
      console.log(
        `imported ${images.length} images / ${images.reduce((n, i) => n + i.gt.length, 0)} GT boxes; ` +
          `datasetVersionId=${result.datasetVersionId}${result.replayed ? ' (idempotent replay)' : ''}`,
      );
    }),
  );

program
  .command('import-predictions')
  .description('Import predictions for a model version against a dataset version')
  .requiredOption('--file <path>', 'predictions JSON')
  .requiredOption('--model <name>', 'model version name')
  .requiredOption('--dataset-version-id <id>', 'dataset version id')
  .option('--idempotency-key <key>', 'idempotency key')
  .action(
    run((service, db, opts) => {
      const datasetVersionId = Number.parseInt(opts.datasetVersionId, 10);
      const raw = loadJson(opts.file);
      const payload = Array.isArray(raw)
        ? (raw as unknown[])
        : ((raw as { predictions: unknown[] }).predictions);
      const images = db
        .prepare('SELECT external_id, width, height FROM images WHERE dataset_version_id=?')
        .all(datasetVersionId) as { external_id: string; width: number; height: number }[];
      const lookup = new Map(images.map((i) => [i.external_id, { width: i.width, height: i.height }]));
      const rows = validatePredictions(payload, lookup);
      const before = count(db, 'SELECT COUNT(*) n FROM predictions WHERE dataset_version_id=?', datasetVersionId);
      const result = service.importPredictions({
        modelName: opts.model,
        datasetVersionId,
        idempotencyKey: opts.idempotencyKey,
        rows,
      });
      const after = count(db, 'SELECT COUNT(*) n FROM predictions WHERE dataset_version_id=?', datasetVersionId);
      console.log(`predictions for dataset ${datasetVersionId}: ${before} -> ${after}`);
      console.log(
        `modelVersionId=${result.modelVersionId} batchId=${result.batchId}` +
          `${result.replayed ? ' (idempotent replay)' : ''}`,
      );
    }),
  );

program
  .command('create-scheme')
  .description('Create (or fetch by name) an evaluation scheme')
  .requiredOption('--name <name>', 'scheme name')
  .option('--thresholds <list>', 'comma-separated IoU thresholds', '0.5')
  .option('--interpolation <mode>', 'all_point or 11_point', 'all_point')
  .option('--include-zero-gt-classes', 'include classes with no GT in the mAP mean (default: exclude)')
  .action(
    run((service, _db, opts) => {
      const rawThresholds = Array.isArray(opts.thresholds)
        ? opts.thresholds.join(',')
        : String(opts.thresholds);
      const thresholds = rawThresholds.split(',').map((s) => Number.parseFloat(s.trim()));
      const result = service.createScheme({
        name: opts.name,
        iouThresholds: thresholds,
        interpolation: opts.interpolation as 'all_point' | '11_point',
        excludeClassesWithoutGt: !opts.includeZeroGtClasses,
      });
      console.log(`schemeId=${result.schemeId} name=${opts.name} thresholds=${thresholds.join(',')}`);
    }),
  );

program
  .command('evaluate')
  .description('Run an evaluation and store a frozen report')
  .requiredOption('--model-version-id <id>', 'model version id')
  .requiredOption('--dataset-version-id <id>', 'dataset version id')
  .requiredOption('--scheme-id <id>', 'eval scheme id')
  .action(
    run((service, db, opts) => {
      const before = count(db, 'SELECT COUNT(*) n FROM reports');
      const result = service.runReport({
        modelVersionId: Number.parseInt(opts.modelVersionId, 10),
        datasetVersionId: Number.parseInt(opts.datasetVersionId, 10),
        schemeId: Number.parseInt(opts.schemeId, 10),
      });
      const after = count(db, 'SELECT COUNT(*) n FROM reports');
      console.log(`reports: ${before} -> ${after}${result.replayed ? ' (identical inputs, frozen report reused)' : ''}`);
      console.log(`reportId=${result.reportId}`);
      result.report.iouThresholds.forEach((t, i) => {
        console.log(`  mAP@${t} = ${result.report.mAPPerThreshold[i].toFixed(4)}`);
      });
      console.log(`  mAP    = ${result.report.mAP.toFixed(4)}`);
      console.log(`  images=${result.report.totals.images} gt=${result.report.totals.gt} pred=${result.report.totals.predictions}`);
    }),
  );

program
  .command('errors')
  .description('List attributable error samples for a report with paging')
  .requiredOption('--report-id <id>', 'report id')
  .option('--type <type>', 'missed_gt|duplicate|localization|wrong_class|background_fp')
  .option('--category <name>', 'filter by category')
  .option('--image <externalId>', 'filter by image external id')
  .option('--page <n>', 'zero-based page', '0')
  .option('--page-size <n>', 'page size', '50')
  .action(
    run((service, _db, opts) => {
      const result = service.listErrors(
        Number.parseInt(opts.reportId, 10),
        { type: opts.type, category: opts.category, imageExternalId: opts.image },
        Number.parseInt(opts.page, 10),
        Number.parseInt(opts.pageSize, 10),
      );
      console.log(`errors ${result.items.length} shown / ${result.total} total (page ${result.page}, size ${result.pageSize})`);
      for (const e of result.items) {
        const where = `iou=${e.iouThreshold} img=${e.imageExternalId} cat=${e.category}`;
        console.log(`- [${e.type}] ${where} conf=${e.confidence ?? '-'} iou=${e.iou ?? '-'} :: ${e.detail}`);
      }
    }),
  );

program
  .command('compare')
  .description('Compare two model versions on the SAME dataset version and scheme')
  .requiredOption('--model-a <id>', 'model version id A')
  .requiredOption('--model-b <id>', 'model version id B')
  .requiredOption('--dataset-version-id <id>', 'shared dataset version id')
  .requiredOption('--scheme-id <id>', 'shared eval scheme id')
  .action(
    run((service, _db, opts) => {
      const result = service.compareModels({
        modelVersionIdA: Number.parseInt(opts.modelA, 10),
        modelVersionIdB: Number.parseInt(opts.modelB, 10),
        datasetVersionId: Number.parseInt(opts.datasetVersionId, 10),
        schemeId: Number.parseInt(opts.schemeId, 10),
      });
      console.log(`dataset=${result.datasetVersionId} scheme=${result.schemeId}`);
      console.log(`  A mAP=${result.modelA.mAP.toFixed(4)}  B mAP=${result.modelB.mAP.toFixed(4)}  delta=${result.deltaMAP.toFixed(4)}`);
      result.iouThresholds.forEach((t, i) => {
        console.log(`  @${t}: A=${result.modelA.mAPPerThreshold[i].toFixed(4)} B=${result.modelB.mAPPerThreshold[i].toFixed(4)} delta=${result.deltaPerThreshold[i].toFixed(4)}`);
      });
    }),
  );

program
  .command('export-report')
  .description('Export a frozen report to a JSON file inside this project')
  .requiredOption('--report-id <id>', 'report id')
  .requiredOption('--out <path>', 'output JSON path')
  .action(
    run((service, _db, opts) => {
      const report = service.getReport(Number.parseInt(opts.reportId, 10));
      writeFileSync(resolve(opts.out), JSON.stringify(report, null, 2));
      console.log(`exported frozen report ${report.reportId} -> ${opts.out}`);
    }),
  );

program
  .command('generate')
  .description('Generate synthetic annotations + predictions JSON files')
  .requiredOption('--out-dir <dir>', 'output directory')
  .option('--seed <n>', 'PRNG seed', '42')
  .option('--images <n>', 'image count', '20')
  .option('--categories <list>', 'categories', 'cat,dog,car')
  .action((opts) => {
    const data = generateDataset({
      seed: Number.parseInt(opts.seed, 10),
      imageCount: Number.parseInt(opts.images, 10),
      categories: opts.categories.split(',').map((s: string) => s.trim()),
    });
    const dir = resolve(opts.outDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'annotations.json'), JSON.stringify(data.images, null, 2));
    writeFileSync(resolve(dir, 'predictions.json'), JSON.stringify(data.predictions, null, 2));
    console.log(`wrote annotations.json + predictions.json to ${dir} (seed=${opts.seed})`);
  });

program.parseAsync(process.argv);
