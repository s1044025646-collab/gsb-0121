import { test } from "node:test";
import assert from "node:assert/strict";
import { iou, intersectionArea, validateBoxInImage } from "./geometry.ts";
import { AppError } from "./errors.ts";

test("iou is hand-computable for overlapping unit-like boxes", () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  const b = { x: 5, y: 5, w: 10, h: 10 };
  assert.equal(intersectionArea(a, b), 25);
  assert.equal(iou(a, b), 25 / (100 + 100 - 25));
});

test("iou of disjoint boxes is exactly zero", () => {
  assert.equal(iou({ x: 0, y: 0, w: 1, h: 1 }, { x: 5, y: 5, w: 1, h: 1 }), 0);
});

test("iou of identical boxes is exactly one", () => {
  const b = { x: 2, y: 3, w: 4, h: 5 };
  assert.equal(iou(b, b), 1);
});

test("validation rejects non-positive size instead of clipping", () => {
  assert.throws(
    () => validateBoxInImage({ x: 0, y: 0, w: 0, h: 5 }, 10, 10, "t"),
    (e: unknown) => e instanceof AppError && e.code === "INVALID_BOX",
  );
});

test("validation rejects out-of-bounds boxes", () => {
  assert.throws(
    () => validateBoxInImage({ x: 0, y: 0, w: 11, h: 5 }, 10, 10, "t"),
    (e: unknown) => e instanceof AppError && e.code === "BOX_OUT_OF_BOUNDS",
  );
  assert.throws(
    () => validateBoxInImage({ x: -1, y: 0, w: 5, h: 5 }, 10, 10, "t"),
    (e: unknown) => e instanceof AppError && e.code === "BOX_OUT_OF_BOUNDS",
  );
});
