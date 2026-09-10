import { describe, expect, test } from "vitest";
import {
  layoutMagnifier,
  makeRect,
  rectHeight,
  rectWidth,
  type ScreenRect,
} from "../../../src/primitives/overlay/magnifier/layout";

const bounds: ScreenRect = { left: 0, top: 0, right: 800, bottom: 600 };

function expectInside(rect: ScreenRect, container: ScreenRect): void {
  expect(rect.left).toBeGreaterThanOrEqual(container.left);
  expect(rect.top).toBeGreaterThanOrEqual(container.top);
  expect(rect.right).toBeLessThanOrEqual(container.right);
  expect(rect.bottom).toBeLessThanOrEqual(container.bottom);
}

describe("layoutMagnifier", () => {
  test("clamps the inset inside the bounds when the source hugs a corner", () => {
    const layout = layoutMagnifier(makeRect(0, 0, 80), bounds, 200, 0, undefined, undefined);
    expectInside(layout.inset, bounds);
    expect(rectWidth(layout.inset)).toBe(200);
    expect(rectHeight(layout.inset)).toBe(200);
  });

  test("reserves the panel strip on the panel side when a panel width is given", () => {
    const panelWidth = 210;
    const layout = layoutMagnifier(makeRect(600, 250, 100), bounds, 200, panelWidth, undefined, undefined);
    const framed = layout.panelSide === "right"
      ? { ...layout.inset, right: layout.inset.right + panelWidth }
      : { ...layout.inset, left: layout.inset.left - panelWidth };
    expectInside(framed, bounds);
  });

  test("keeps the previous placement while it still clears the frame gap", () => {
    const first = layoutMagnifier(makeRect(300, 200, 100), bounds, 200, 0, undefined, undefined);
    const moved = layoutMagnifier(
      makeRect(304, 203, 100), bounds, 200, 0, first.placement, first.connectorCorners,
    );
    expect(moved.placement).toBe(first.placement);
  });

  test("recomputes placement when the previous slot loses the frame gap", () => {
    const first = layoutMagnifier(makeRect(300, 200, 100), bounds, 200, 0, undefined, undefined);
    const moved = layoutMagnifier(
      makeRect(620, 0, 100), bounds, 200, 0, first.placement, first.connectorCorners,
    );
    expect(moved.placement).not.toBe(first.placement);
    expectInside(moved.inset, bounds);
  });

  test("connects the closest source and inset corners", () => {
    const layout = layoutMagnifier(makeRect(100, 100, 80), bounds, 200, 0, undefined, undefined);
    expect(layout.panelSide).toBe("right");
    expect(layout.connectorCorners).toEqual([1, 0]);
    expect(layout.connector.from).toEqual({ x: 180, y: 100 });
    expect(layout.connector.to).toEqual({ x: 196, y: 40 });
  });

  test("retains connector corners under small moves but switches on large ones", () => {
    const first = layoutMagnifier(makeRect(100, 100, 80), bounds, 200, 0, undefined, undefined);
    const nudged = layoutMagnifier(
      makeRect(102, 101, 80), bounds, 200, 0, first.placement, first.connectorCorners,
    );
    expect(nudged.connectorCorners).toEqual(first.connectorCorners);
    const jumped = layoutMagnifier(
      makeRect(500, 400, 80), bounds, 200, 0, undefined, first.connectorCorners,
    );
    expect(jumped.connectorCorners).not.toEqual(first.connectorCorners);
    expect(jumped.connectorCorners).toEqual([1, 2]);
  });
});
