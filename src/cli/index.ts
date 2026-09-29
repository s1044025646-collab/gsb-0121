import { resolve } from "node:path";
import { openDatabase, migrate } from "../db/database.ts";
import { importDataset } from "../services/catalog.ts";
import { importPredictions } from "../services/models.ts";
import { upsertProtocol } from "../services/protocols.ts";
import { runEvaluation } from "../services/evaluate.ts";
import {
  compareReports,
  getReportDetail,
  listErrorSamples,
  listReports,
} from "../services/queries.ts";
import { count, fail, readJsonArg, writeExport } from "./util.ts";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, "true");
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

function usage(): void {
  console.log(`odet — object detection evaluation CLI

usage:
  npm run cli -- migrate
  npm run cli -- import-dataset <file.json>
  npm run cli -- import-predictions <file.json>
  npm run cli -- create-protocol <file.json>
  npm run cli -- evaluate --dataset <id> --model <id> --protocol <id>
  npm run cli -- reports [--page n] [--page-size n]
  npm run cli -- report <id>
  npm run cli -- errors <reportId> [--kind missed|duplicate|localization|wrong_class|background_fp] [--iou 0.5] [--page n]
  npm run cli -- compare <reportA> <reportB>
  npm run cli -- export <reportId> --out <file.json>

env:
  ODET_DB   path to sqlite file (default data/odet.sqlite)
`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = process.env.ODET_DB ?? resolve("data/odet.sqlite");
  const db = openDatabase(dbPath);

  try {
    switch (args.command) {
      case "migrate": {
        console.log(`before: database ${dbPath}`);
        const info = migrate(db);
        console.log(`after:  schema ${info.from} -> ${info.to}${info.applied.length ? ` (applied ${info.applied.join(",")})` : " (up to date)"}`);
        break;
      }
      case "import-dataset": {
        const path = requirePositional(args, 0, "dataset json path");
        const before = count(db, "dataset_versions");
        const r = importDataset(db, readJsonArg(path));
        const after = count(db, "dataset_versions");
        console.log(`before: dataset_versions=${before}`);
        console.log(
          `after:  datasetVersionId=${r.datasetVersionId} slug=${r.slug} version=${r.version} images=${r.imageCount} gtBoxes=${r.boxCount} versions=${after}${r.reused ? " (idempotent replay)" : ""}`,
        );
        break;
      }
      case "import-predictions": {
        const path = requirePositional(args, 0, "predictions json path");
        const before = count(db, "model_versions");
        const r = importPredictions(db, readJsonArg(path));
        const after = count(db, "model_versions");
        console.log(`before: model_versions=${before}`);
        console.log(
          `after:  modelVersionId=${r.modelVersionId} datasetVersionId=${r.datasetVersionId} predictions=${r.predictionCount} models=${after}${r.reused ? " (idempotent replay)" : ""}`,
        );
        break;
      }
      case "create-protocol": {
        const path = requirePositional(args, 0, "protocol json path");
        const p = upsertProtocol(db, readJsonArg(path));
        console.log(`protocolId=${p.id} name=${p.name} iouThresholds=[${p.iouThresholds.join(",")}] wrongClass=${p.wrongClassIou} duplicate=${p.duplicateIou}`);
        break;
      }
      case "evaluate": {
        const dataset = Number(requireFlag(args, "dataset"));
        const model = Number(requireFlag(args, "model"));
        const protocol = Number(requireFlag(args, "protocol"));
        const before = count(db, "reports");
        const r = runEvaluation(db, dataset, model, protocol);
        const after = count(db, "reports");
        console.log(`before: reports=${before}`);
        console.log(`after:  reportId=${r.reportId} reports=${after} overall mAP=${r.map.toFixed(6)}${r.reused ? " (frozen replay)" : ""}`);
        for (const t of r.thresholds) {
          console.log(
          `        IoU=${t.iouThreshold} mAP=${t.map.toFixed(6)} TP=${t.totalTp} FP=${t.totalFp} FN=${t.totalFn}`,
          );
        }
        break;
      }
      case "reports": {
        const page = Number(args.flags.get("page") ?? "1");
        const pageSize = Number(args.flags.get("page-size") ?? "50");
        const r = listReports(db, { page, pageSize });
        console.log(`reports total=${r.total} page=${r.page}/${r.totalPages}`);
        for (const row of r.data) {
          console.log(`  #${row.id} dataset=${row.dataset_version_id} model=${row.model_version_id} protocol=${row.protocol_id} mAP=${row.map.toFixed(6)} frozen=${row.frozen} at=${row.created_at}`);
        }
        break;
      }
      case "report": {
        const id = Number(requirePositional(args, 0, "report id"));
        console.log(JSON.stringify(getReportDetail(db, id), null, 2));
        break;
      }
      case "errors": {
        const id = Number(requirePositional(args, 0, "report id"));
        const page = Number(args.flags.get("page") ?? "1");
        const pageSize = Number(args.flags.get("page-size") ?? "50");
        const r = listErrorSamples(db, id, {
          kind: args.flags.get("kind"),
          iouThreshold: args.flags.has("iou") ? Number(args.flags.get("iou")) : undefined,
          categoryId: args.flags.has("category") ? Number(args.flags.get("category")) : undefined,
          page,
          pageSize,
        });
        console.log(`error samples total=${r.total} page=${r.page}/${r.totalPages}`);
        for (const e of r.data) {
          console.log(
            `  [${e.errorKind}] IoUthr=${e.iouThreshold} image=${e.imageKey} cat=${e.categoryId}${e.categoryName ? `(${e.categoryName})` : ""} iou=${e.iou} score=${e.score ?? "-"} gt=${e.gtId ?? "-"} pred=${e.predId ?? "-"}`,
          );
          console.log(`      ${e.detail}`);
        }
        break;
      }
      case "compare": {
        const a = Number(requirePositional(args, 0, "report A"));
        const b = Number(requirePositional(args, 1, "report B"));
        const c = compareReports(db, a, b);
        console.log(`compare report#${a} -> report#${b} (dataset=${c.datasetVersionId}, protocol=${c.protocolId})`);
        console.log(`  overall mAP ${c.overallMapA.toFixed(6)} -> ${c.overallMapB.toFixed(6)}  delta=${c.deltaOverallMap.toFixed(6)}`);
        for (const t of c.byThreshold) {
          console.log(`  IoU=${t.iouThreshold} ${t.mapA.toFixed(6)} -> ${t.mapB.toFixed(6)}  delta=${t.deltaMap.toFixed(6)}`);
        }
        break;
      }
      case "export": {
        const id = Number(requirePositional(args, 0, "report id"));
        const out = requireFlag(args, "out");
        const detail = getReportDetail(db, id);
        writeExport(out, detail);
        console.log(`exported frozen report #${id} -> ${resolve(out)}`);
        break;
      }
      case "":
      case "help":
      case "--help":
      case "-h":
        usage();
        break;
      default:
        console.error(`unknown command: ${args.command}`);
        usage();
        process.exit(2);
    }
  } catch (err) {
    fail(err);
  } finally {
    db.close();
  }
}

function requirePositional(args: ParsedArgs, idx: number, name: string): string {
  const v = args.positional[idx];
  if (v === undefined) {
    console.error(`missing positional argument: ${name}`);
    usage();
    process.exit(2);
  }
  return v;
}

function requireFlag(args: ParsedArgs, name: string): string {
  const v = args.flags.get(name);
  if (v === undefined) {
    console.error(`missing required flag --${name}`);
    usage();
    process.exit(2);
  }
  return v;
}

main();
