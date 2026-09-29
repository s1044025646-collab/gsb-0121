import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrate } from "../db/database.ts";
import { createApp } from "./app.ts";

let server: Server;
let base: string;
let dir: string;
let db: ReturnType<typeof openDatabase>;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "odet-api-"));
  db = openDatabase(join(dir, "api.sqlite"));
  migrate(db);
  server = createServer(createApp(db).handler);
  await new Promise<void>((listenResolve) => server.listen(0, "127.0.0.1", listenResolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  removeRetry(dir);
});

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

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json: json as any };
}

const dataset = {
  slug: "api",
  categories: [{ id: 1, name: "cat" }],
  images: [{ key: "i0", width: 20, height: 20, boxes: [{ categoryId: 1, x: 0, y: 0, w: 5, h: 5 }] }],
};

test("health and full happy path over HTTP", async () => {
  const health = await call("GET", "/api/health");
  assert.equal(health.status, 200);

  const ds = await call("POST", "/api/datasets", dataset);
  assert.equal(ds.status, 200);
  const dvId = ds.json.datasetVersionId;

  const dsReplay = await call("POST", "/api/datasets", dataset);
  assert.equal(dsReplay.json.datasetVersionId, dvId);
  assert.equal(dsReplay.json.reused, true);

  const pred = await call("POST", "/api/predictions", {
    modelName: "m",
    datasetVersionId: dvId,
    predictions: [{ imageKey: "i0", categoryId: 1, score: 0.9, x: 0, y: 0, w: 5, h: 5 }],
  });
  assert.equal(pred.status, 200);
  const modelId = pred.json.modelVersionId;

  const proto = await call("POST", "/api/protocols", { name: "p", iouThresholds: [0.5] });
  const protocolId = proto.json.id;

  const ev = await call("POST", "/api/evaluations", {
    datasetVersionId: dvId,
    modelVersionId: modelId,
    protocolId,
  });
  assert.equal(ev.status, 200);
  assert.equal(ev.json.map, 1);
  const reportId = ev.json.reportId;

  const detail = await call("GET", `/api/reports/${reportId}`);
  assert.equal(detail.status, 200);

  const reports = await call("GET", "/api/reports?page=1&pageSize=10");
  assert.equal(reports.json.total >= 1, true);
  assert.equal(reports.json.page, 1);
});

test("error codes: invalid json, validation, out-of-bounds, not found, pagination", async () => {
  const res = await fetch(`${base}/api/datasets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as any).error.code, "INVALID_JSON");

  const badDim = await call("POST", "/api/datasets", {
    slug: "bad",
    categories: [{ id: 1, name: "c" }],
    images: [{ key: "k", width: 0, height: 10, boxes: [] }],
  });
  assert.equal(badDim.status, 422);
  assert.equal(badDim.json.error.code, "INVALID_DIMENSION");

  const oob = await call("POST", "/api/datasets", {
    slug: "bad2",
    categories: [{ id: 1, name: "c" }],
    images: [{ key: "k", width: 10, height: 10, boxes: [{ categoryId: 1, x: 0, y: 0, w: 20, h: 5 }] }],
  });
  assert.equal(oob.json.error.code, "BOX_OUT_OF_BOUNDS");

  const nf = await call("GET", "/api/reports/99999");
  assert.equal(nf.status, 404);
  assert.equal(nf.json.error.code, "NOT_FOUND");

  const pg = await call("GET", "/api/reports?page=0");
  assert.equal(pg.status, 400);
  assert.equal(pg.json.error.code, "INVALID_PAGINATION");
});
