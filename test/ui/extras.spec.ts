import { expect, test } from "@playwright/test";
import { visibleRange } from "../../src/webview/virtual";

test("visibleRange renders a short list in full", () => {
  expect(visibleRange(12, 0, 600, 40, 2)).toEqual({ start: 0, end: 12 });
  expect(visibleRange(1, 0, 600, 40, 2)).toEqual({ start: 0, end: 1 });
});

test("visibleRange follows the scroll position with overscan", () => {
  // Row 20 is at the top of the viewport; two rows of overscan on each side.
  expect(visibleRange(100, 1000, 400, 50, 5)).toEqual({ start: 15, end: 33 });
});

test("visibleRange clamps at the end and handles an empty list", () => {
  expect(visibleRange(40, 2000, 300, 50, 10)).toEqual({ start: 30, end: 40 });
  expect(visibleRange(0, 0, 300, 50, 10)).toEqual({ start: 0, end: 0 });
});
