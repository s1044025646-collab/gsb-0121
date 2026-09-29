import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/api.js';

describe('HTTP API', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let closeDb: () => void;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'odet-api-'));
    const ctx = openDatabase(join(dir, 'api.sqlite'));
    closeDb = ctx.close;
    server = createApp(ctx.db).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it('health works', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('full flow: import -> predict -> scheme -> report -> paged errors', async () => {
    const ds = await fetch(`${base}/datasets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'd',
        idempotencyKey: 'd1',
        images: [
          {
            externalId: 'i',
            width: 100,
            height: 100,
            gt: [
              { left: 0, top: 0, right: 10, bottom: 10, category: 'a' },
              { left: 20, top: 20, right: 30, bottom: 30, category: 'a' },
            ],
          },
        ],
      }),
    }).then((r) => r.json());

    const pred = await fetch(`${base}/predictions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelName: 'm',
        datasetVersionId: ds.datasetVersionId,
        predictions: [
          {
            externalId: 'i',
            boxes: [
              { left: 0, top: 0, right: 10, bottom: 10, category: 'a', confidence: 0.9 },
              { left: 50, top: 50, right: 60, bottom: 60, category: 'a', confidence: 0.4 },
            ],
          },
        ],
      }),
    }).then((r) => r.json());

    const scheme = await fetch(`${base}/schemes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 's', iouThresholds: [0.5], interpolation: 'all_point' }),
    }).then((r) => r.json());

    const report = await fetch(`${base}/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelVersionId: pred.modelVersionId,
        datasetVersionId: ds.datasetVersionId,
        schemeId: scheme.schemeId,
      }),
    }).then((r) => r.json());
    // One TP, one missed GT -> AP 0.5.
    expect(report.report.mAP).toBeCloseTo(0.5, 9);

    const errors = await fetch(`${base}/reports/${report.reportId}/errors?page=0&pageSize=1`).then((r) => r.json());
    expect(errors.total).toBeGreaterThanOrEqual(2);
    expect(errors.items).toHaveLength(1);
    expect(errors.pageSize).toBe(1);
  });

  it('returns structured error codes on invalid input', async () => {
    const res = await fetch(`${base}/datasets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '', images: [] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects out-of-bounds boxes with OUT_OF_BOUNDS', async () => {
    const res = await fetch(`${base}/datasets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'd',
        images: [
          { externalId: 'i', width: 10, height: 10, gt: [{ left: 0, top: 0, right: 20, bottom: 20, category: 'a' }] },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('OUT_OF_BOUNDS');
  });

  it('404 on missing report', async () => {
    const res = await fetch(`${base}/reports/999`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });
});
