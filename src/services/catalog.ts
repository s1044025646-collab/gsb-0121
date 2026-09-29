import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../core/errors.ts";
import { isFiniteNumber } from "../core/geometry.ts";
import { contentHash } from "./serial.ts";
import { inTransaction } from "../db/tx.ts";

export interface DatasetImageInput {
  key: string;
  width: number;
  height: number;
  boxes: DatasetBoxInput[];
}

export interface DatasetBoxInput {
  categoryId: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DatasetInput {
  slug: string;
  note?: string;
  categories: { id: number; name: string }[];
  images: DatasetImageInput[];
}

export interface DatasetImportResult {
  datasetVersionId: number;
  slug: string;
  version: number;
  reused: boolean;
  imageCount: number;
  boxCount: number;
}

function assert(cond: unknown, code: string, message: string): asserts cond {
  if (!cond) throw new AppError(code, message, code === "NOT_FOUND" ? 404 : 422);
}

export function validateDataset(input: unknown): DatasetInput {
  assert(typeof input === "object" && input !== null, "VALIDATION", "Dataset must be an object.");
  const d = input as Record<string, unknown>;
  assert(typeof d.slug === "string" && d.slug.trim().length > 0, "VALIDATION", "slug is required.");
  assert(Array.isArray(d.categories) && d.categories.length > 0, "VALIDATION", "categories must be a non-empty array.");
  assert(Array.isArray(d.images), "VALIDATION", "images must be an array.");

  const categories: { id: number; name: string }[] = [];
  const catIds = new Set<number>();
  for (const raw of d.categories as unknown[]) {
    const c = raw as Record<string, unknown>;
    assert(isFiniteNumber(c.id) && Number.isInteger(c.id) && c.id > 0, "VALIDATION", "category id must be a positive integer.");
    assert(typeof c.name === "string" && c.name.trim().length > 0, "VALIDATION", "category name required.");
    assert(!catIds.has(c.id), "VALIDATION", `duplicate category id ${c.id}.`);
    catIds.add(c.id);
    categories.push({ id: c.id, name: c.name });
  }

  const images: DatasetImageInput[] = [];
  const keys = new Set<string>();
  (d.images as unknown[]).forEach((raw, imageIdx) => {
    const img = raw as Record<string, unknown>;
    const ref = `images[${imageIdx}]`;
    assert(typeof img.key === "string" && img.key.trim().length > 0, "VALIDATION", `${ref}.key required.`);
    assert(!keys.has(img.key), "VALIDATION", `duplicate image key ${img.key}.`);
    keys.add(img.key);
    assert(
      isFiniteNumber(img.width) && Number.isInteger(img.width) && img.width > 0,
      "INVALID_DIMENSION",
      `${ref}.width must be a positive integer (got ${String(img.width)}).`,
    );
    assert(
      isFiniteNumber(img.height) && Number.isInteger(img.height) && img.height > 0,
      "INVALID_DIMENSION",
      `${ref}.height must be a positive integer (got ${String(img.height)}).`,
    );
    assert(Array.isArray(img.boxes), "VALIDATION", `${ref}.boxes must be an array.`);

    const boxes: DatasetBoxInput[] = [];
    (img.boxes as unknown[]).forEach((braw, boxIdx) => {
      const b = braw as Record<string, unknown>;
      const bref = `${ref}.boxes[${boxIdx}]`;
      assert(isFiniteNumber(b.categoryId) && Number.isInteger(b.categoryId), "VALIDATION", `${bref}.categoryId must be an integer.`);
      assert(catIds.has(b.categoryId as number), "VALIDATION", `${bref}.categoryId ${String(b.categoryId)} is not in category mapping.`);
      for (const k of ["x", "y", "w", "h"] as const) {
        assert(isFiniteNumber(b[k]), "INVALID_BOX", `${bref}.${k} must be a finite number.`);
      }
      const box = {
        categoryId: b.categoryId as number,
        x: b.x as number,
        y: b.y as number,
        w: b.w as number,
        h: b.h as number,
      };
      assert(box.w > 0 && box.h > 0, "INVALID_BOX", `${bref} must have positive w/h; silent clipping is not allowed.`);
      assert(box.x >= 0 && box.y >= 0, "BOX_OUT_OF_BOUNDS", `${bref} has negative origin.`);
      assert(
        box.x + box.w <= (img.width as number) + 1e-9 &&
          box.y + box.h <= (img.height as number) + 1e-9,
        "BOX_OUT_OF_BOUNDS",
        `${bref} exceeds image ${String(img.width)}x${String(img.height)}.`,
      );
      boxes.push(box);
    });
    images.push({ key: img.key, width: img.width, height: img.height, boxes });
  });

  return { slug: d.slug.trim(), note: typeof d.note === "string" ? d.note : undefined, categories, images };
}

export function importDataset(
  db: DatabaseSync,
  raw: unknown,
  now: () => string = () => new Date().toISOString(),
): DatasetImportResult {
  const input = validateDataset(raw);
  const hash = contentHash(input);

  const existing = db
    .prepare("SELECT id FROM dataset_versions WHERE content_hash = ?")
    .get(hash) as { id: number } | undefined;
  if (existing) {
    const row = db
      .prepare("SELECT slug, version FROM dataset_versions WHERE id = ?")
      .get(existing.id) as { slug: string; version: number };
    return {
      datasetVersionId: existing.id,
      slug: row.slug,
      version: row.version,
      reused: true,
      imageCount: input.images.length,
      boxCount: input.images.reduce((n, i) => n + i.boxes.length, 0),
    };
  }

  const maxRow = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM dataset_versions WHERE slug = ?")
    .get(input.slug) as { v: number };
  const version = maxRow.v + 1;

  const run = () => inTransaction(db, () => {
    const info = db
      .prepare(
        "INSERT INTO dataset_versions(slug, version, note, content_hash, created_at) VALUES (?,?,?,?,?)",
      )
      .run(input.slug, version, input.note ?? null, hash, now());
    const dvId = Number(info.lastInsertRowid);

    const insCatGlobal = db.prepare("INSERT OR IGNORE INTO category_mappings(name) VALUES (?)");
    const insCat = db.prepare(
      "INSERT INTO dataset_categories(dataset_version_id, category_id, name) VALUES (?,?,?)",
    );
    for (const c of input.categories) {
      insCatGlobal.run(c.name);
      insCat.run(dvId, c.id, c.name);
    }

    const insImg = db.prepare(
      "INSERT INTO images(dataset_version_id, image_key, width, height) VALUES (?,?,?,?)",
    );
    const insBox = db.prepare(
      "INSERT INTO gt_boxes(dataset_version_id, image_id, category_id, x,y,w,h) VALUES (?,?,?,?,?,?,?)",
    );
    let boxCount = 0;
    for (const img of input.images) {
      const imgInfo = insImg.run(dvId, img.key, img.width, img.height);
      const imageId = Number(imgInfo.lastInsertRowid);
      for (const b of img.boxes) {
        insBox.run(dvId, imageId, b.categoryId, b.x, b.y, b.w, b.h);
        boxCount += 1;
      }
    }
    return { dvId, boxCount };
  });

  const { dvId, boxCount } = run();
  return {
    datasetVersionId: dvId,
    slug: input.slug,
    version,
    reused: false,
    imageCount: input.images.length,
    boxCount,
  };
}
