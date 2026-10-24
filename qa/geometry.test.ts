// Pure-logic tests for the placement/compositing helpers (no browser needed).
// Run with `npm run test:unit`.
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeCropRegion,
  boxRelativeTo,
  isBoxOffFrame,
  fitRegionToAspect,
  boxToCover,
  boxContains,
  ASPECT_CANDIDATES
} from "../src/utils/imageCompose";
import { fitWithin } from "../src/utils/photo";

const ratioOf = (label: string) => ASPECT_CANDIDATES.find((c) => c.label === label)!.value;

test("computeCropRegion pads proportionally but caps the margin and stays on the photo", () => {
  assert.deepEqual(computeCropRegion({ x: 40, y: 40, width: 10, height: 10 }), { x: 35, y: 35, width: 20, height: 20 });
  const big = computeCropRegion({ x: 5, y: 5, width: 80, height: 90 });
  assert.equal(big.x, 0);
  assert.equal(big.y, 0);
  assert.ok(big.x + big.width <= 100 && big.y + big.height <= 100);
});

test("boxRelativeTo re-expresses a box inside its crop", () => {
  const region = computeCropRegion({ x: 40, y: 40, width: 10, height: 10 });
  assert.deepEqual(boxRelativeTo({ x: 40, y: 40, width: 10, height: 10 }, region), { x: 25, y: 25, width: 50, height: 50 });
});

test("isBoxOffFrame", () => {
  assert.equal(isBoxOffFrame({ x: -1, y: 0, width: 10, height: 10 }), true);
  assert.equal(isBoxOffFrame({ x: 95, y: 0, width: 10, height: 10 }), true);
  assert.equal(isBoxOffFrame({ x: 0, y: 0, width: 100, height: 100 }), false);
});

test("fitRegionToAspect yields an exactly supported ratio, containing the box, inside the photo", () => {
  const cases: Array<[number, number, { x: number; y: number; width: number; height: number }]> = [
    [3024, 4032, { x: 40, y: 40, width: 10, height: 10 }],
    [4000, 3000, { x: 10, y: 20, width: 30, height: 25 }],
    [900, 1200, { x: 30, y: 55, width: 35, height: 25 }],
    [1080, 1920, { x: 2, y: 2, width: 20, height: 12 }],
    [3000, 3000, { x: 70, y: 75, width: 28, height: 22 }],
    [1500, 2000, { x: 0, y: 0, width: 100, height: 30 }]
  ];
  for (const [W, H, box] of cases) {
    const region = computeCropRegion(box);
    const fit = fitRegionToAspect(region, box, W, H);
    const r = fit.region;
    const ratio = ((r.width / 100) * W) / ((r.height / 100) * H);
    assert.ok(Math.abs(ratio / ratioOf(fit.aspectRatio) - 1) < 1e-6, `${W}x${H}: ratio ${ratio} vs ${fit.aspectRatio}`);
    assert.ok(boxContains(r, box, 1e-6), `${W}x${H}: box not contained`);
    assert.ok(r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.width <= 100 + 1e-6 && r.y + r.height <= 100 + 1e-6, `${W}x${H}: off photo`);
    // Crops should only grow modestly to reach a supported ratio (box is tiny vs photo here, so allow generous slack).
    assert.ok(r.width <= region.width * 1.3 + 1e-6 && r.height <= region.height * 1.3 + 1e-6, `${W}x${H}: grew too much`);
  }
});

test("boxToCover keeps the box's aspect, encloses the target with margin, and refuses the impossible", () => {
  const box = { x: 30, y: 30, width: 20, height: 30 };
  const target = { x: 25, y: 20, width: 40, height: 25 };
  const fit = boxToCover(box, target, 3)!;
  assert.ok(fit);
  assert.ok(Math.abs(fit.width / fit.height - box.width / box.height) < 1e-9);
  assert.ok(boxContains(fit, target, 1e-9));
  assert.ok(fit.x >= 0 && fit.y >= 0 && fit.x + fit.width <= 100 && fit.y + fit.height <= 100);
  assert.equal(boxToCover(box, { x: 0, y: 0, width: 100, height: 100 }), null);
});

test("boxContains tolerance", () => {
  assert.equal(boxContains({ x: 10, y: 10, width: 50, height: 50 }, { x: 9.8, y: 10, width: 20, height: 20 }, 0.5), true);
  assert.equal(boxContains({ x: 10, y: 10, width: 50, height: 50 }, { x: 9, y: 10, width: 20, height: 20 }, 0.5), false);
});

test("fitWithin only ever scales down, preserving aspect", () => {
  assert.deepEqual(fitWithin(4000, 3000, 2560), { width: 2560, height: 1920 });
  assert.deepEqual(fitWithin(100, 50, 2560), { width: 100, height: 50 });
  assert.deepEqual(fitWithin(1, 5000, 2560), { width: 1, height: 2560 });
});
