import express, { type Express, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import type { DatabaseSyncType } from './sqlite.js';
import { EvalService } from './service.js';
import { AppError } from './errors.js';
import { validateImages, validatePredictions } from './validation.js';

const boxSchema = z.object({
  left: z.number(),
  top: z.number(),
  right: z.number(),
  bottom: z.number(),
});

const importDatasetSchema = z.object({
  name: z.string().min(1),
  idempotencyKey: z.string().min(1).optional(),
  note: z.string().optional(),
  images: z
    .array(
      z.object({
        externalId: z.string().min(1),
        width: z.number(),
        height: z.number(),
        gt: z.array(boxSchema.extend({ category: z.string().min(1) })),
      }),
    )
    .min(1),
});

const importPredictionsSchema = z.object({
  modelName: z.string().min(1),
  datasetVersionId: z.number().int().positive(),
  idempotencyKey: z.string().min(1).optional(),
  predictions: z.array(
    z.object({
      externalId: z.string().min(1),
      boxes: z.array(
        boxSchema.extend({
          category: z.string().min(1),
          confidence: z.number().min(0).max(1),
        }),
      ),
    }),
  ),
});

const schemeSchema = z.object({
  name: z.string().min(1),
  iouThresholds: z.array(z.number().gt(0).lt(1)).min(1),
  interpolation: z.enum(['all_point', '11_point']),
  excludeClassesWithoutGt: z.boolean().optional(),
});

const runSchema = z.object({
  modelVersionId: z.number().int().positive(),
  datasetVersionId: z.number().int().positive(),
  schemeId: z.number().int().positive(),
});

function sendError(res: Response, err: unknown): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'request validation failed',
        details: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
      },
    });
    return;
  }
  if (err instanceof AppError) {
    const status =
      err.code === 'NOT_FOUND'
        ? 404
        : err.code === 'CONFLICT' || err.code === 'RULE_MISMATCH'
          ? 409
          : 400;
    res.status(status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  const message = err instanceof Error ? err.message : 'internal error';
  res.status(500).json({ error: { code: 'INTERNAL', message } });
}

function parsePaging(req: Request): { page: number; pageSize: number } {
  const page = Math.max(0, Number.parseInt(String(req.query.page ?? '0'), 10) || 0);
  const rawSize = Number.parseInt(String(req.query.pageSize ?? '50'), 10);
  const pageSize = Math.min(200, Math.max(1, Number.isFinite(rawSize) ? rawSize : 50));
  return { page, pageSize };
}

export function createApp(db: DatabaseSyncType): Express {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  const service = new EvalService(db);

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.post('/datasets', (req, res) => {
    try {
      const parsed = importDatasetSchema.parse(req.body);
      const images = validateImages(parsed.images);
      const result = service.importDataset({
        name: parsed.name,
        idempotencyKey: parsed.idempotencyKey,
        note: parsed.note,
        images,
      });
      res.status(result.replayed ? 200 : 201).json({ ...result, images: images.length });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/predictions', (req, res) => {
    try {
      const parsed = importPredictionsSchema.parse(req.body);
      const images = db
        .prepare('SELECT external_id, width, height FROM images WHERE dataset_version_id=?')
        .all(parsed.datasetVersionId) as { external_id: string; width: number; height: number }[];
      const lookup = new Map(images.map((i) => [i.external_id, { width: i.width, height: i.height }]));
      const rows = validatePredictions(parsed.predictions, lookup);
      const result = service.importPredictions({
        modelName: parsed.modelName,
        datasetVersionId: parsed.datasetVersionId,
        idempotencyKey: parsed.idempotencyKey,
        rows,
      });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/schemes', (req, res) => {
    try {
      const parsed = schemeSchema.parse(req.body);
      res.status(201).json(service.createScheme(parsed));
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/reports', (req, res) => {
    try {
      const parsed = runSchema.parse(req.body);
      const result = service.runReport(parsed);
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/reports/:id', (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) throw new AppError('VALIDATION_ERROR', 'report id must be an integer');
      res.json(service.getReport(id));
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/reports/:id/errors', (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) throw new AppError('VALIDATION_ERROR', 'report id must be an integer');
      const { page, pageSize } = parsePaging(req);
      const iouThreshold =
        req.query.iouThreshold !== undefined
          ? Number.parseFloat(String(req.query.iouThreshold))
          : undefined;
      const result = service.listErrors(
        id,
        {
          type: req.query.type as string | undefined,
          category: req.query.category as string | undefined,
          imageExternalId: req.query.image as string | undefined,
          iouThreshold,
        },
        page,
        pageSize,
      );
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/compare', (req, res) => {
    try {
      const parsed = z
        .object({
          modelVersionIdA: z.number().int().positive(),
          modelVersionIdB: z.number().int().positive(),
          datasetVersionId: z.number().int().positive(),
          schemeId: z.number().int().positive(),
        })
        .parse(req.body);
      res.json(service.compareModels(parsed));
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/models', (_req, res) => {
    const rows = db.prepare('SELECT id, name, created_at FROM model_versions ORDER BY id').all();
    res.json({ items: rows });
  });

  app.get('/datasets', (_req, res) => {
    const rows = db.prepare('SELECT id, name, note, created_at FROM dataset_versions ORDER BY id').all();
    res.json({ items: rows });
  });

  return app;
}
