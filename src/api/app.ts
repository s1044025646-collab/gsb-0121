import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { AppError, ERROR_STATUS } from "../core/errors.ts";
import { importDataset } from "../services/catalog.ts";
import { importPredictions } from "../services/models.ts";
import { upsertProtocol } from "../services/protocols.ts";
import { runEvaluation } from "../services/evaluate.ts";
import {
  compareReports,
  getReportDetail,
  listErrorSamples,
  listReports,
  parsePage,
} from "../services/queries.ts";

type JsonHandler = (body: unknown, url: URL, req: IncomingMessage) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: (params: RegExpMatchArray, body: unknown, url: URL) => unknown;
}

export function createApp(db: DatabaseSync) {
  const routes: Route[] = [
    {
      method: "POST",
      pattern: /^\/api\/datasets$/,
      handler: (_m, body) => importDataset(db, body),
    },
    {
      method: "POST",
      pattern: /^\/api\/predictions$/,
      handler: (_m, body) => importPredictions(db, body),
    },
    {
      method: "POST",
      pattern: /^\/api\/protocols$/,
      handler: (_m, body) => upsertProtocol(db, body),
    },
    {
      method: "POST",
      pattern: /^\/api\/evaluations$/,
      handler: (_m, body) => {
        const b = body as { datasetVersionId?: number; modelVersionId?: number; protocolId?: number };
        if (!b || typeof b !== "object") throw new AppError("VALIDATION", "body required.");
        for (const k of ["datasetVersionId", "modelVersionId", "protocolId"] as const) {
          if (!Number.isInteger(b[k])) throw new AppError("VALIDATION", `${k} must be an integer.`);
        }
        return runEvaluation(db, b.datasetVersionId!, b.modelVersionId!, b.protocolId!);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/reports$/,
      handler: (_m, _b, url) => listReports(db, parsePage(url.searchParams)),
    },
    {
      method: "GET",
      pattern: /^\/api\/reports\/(\d+)$/,
      handler: (m) => getReportDetail(db, Number(m[1])),
    },
    {
      method: "GET",
      pattern: /^\/api\/reports\/(\d+)\/errors$/,
      handler: (m, _b, url) =>
        listErrorSamples(db, Number(m[1]), {
          kind: url.searchParams.get("kind") ?? undefined,
          iouThreshold: url.searchParams.has("iouThreshold")
            ? Number(url.searchParams.get("iouThreshold"))
            : undefined,
          categoryId: url.searchParams.has("categoryId")
            ? Number(url.searchParams.get("categoryId"))
            : undefined,
          ...parsePage(url.searchParams),
        }),
    },
    {
      method: "GET",
      pattern: /^\/api\/compare\/(\d+)\/(\d+)$/,
      handler: (m) => compareReports(db, Number(m[1]), Number(m[2])),
    },
    {
      method: "GET",
      pattern: /^\/api\/health$/,
      handler: () => ({ status: "ok" }),
    },
  ];

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!route) throw new AppError("NOT_FOUND", `no route for ${req.method} ${url.pathname}`, 404);

      const match = url.pathname.match(route.pattern)!;
      const body = req.method === "POST" ? await readJson(req) : null;
      const result = route.handler(match, body, url);
      sendJson(res, 200, await Promise.resolve(result));
    } catch (err) {
      const { status, payload } = normalizeError(err);
      sendJson(res, status, payload);
    }
  }

  return { handler };
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AppError("INVALID_JSON", "request body is not valid JSON.", 400));
      }
    });
    req.on("error", () => reject(new AppError("INVALID_JSON", "failed to read request body.", 400)));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function normalizeError(err: unknown): { status: number; payload: unknown } {
  if (err instanceof AppError) {
    return { status: err.status, payload: err.toBody() };
  }
  const message = err instanceof Error ? err.message : "unknown error";
  const code = message.includes("FOREIGN KEY") || message.includes("UNIQUE") ? "CONFLICT" : "INTERNAL";
  const status = ERROR_STATUS[code] ?? 500;
  return { status, payload: { error: { code, message } } };
}
