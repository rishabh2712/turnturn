// @vitest-environment happy-dom
//
// Task 8.5 ("Implement scroll behaviour") and the repo-wide gotcha "happy-dom has no
// layout": every assertion here is on the pinned/unpinned *state* and the arrived-since
// *count*, never on a pixel value happy-dom cannot honestly produce. Where a DOM element
// is involved at all, `scrollTop`/`scrollHeight`/`clientHeight` are set directly as
// writable numeric properties (happy-dom implements them as always-zero no-ops), which is
// exactly the pattern the task description calls for.
import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { isWithinPinZone, SCROLL_PIN_THRESHOLD_PX, useScrollPin } from "../src/lib/scroll-pin";

test("isWithinPinZone: pure pin/unpin decision over plain numbers, no DOM involved", () => {
  // Exactly at the bottom.
  expect(isWithinPinZone(1000, 1000, 0)).toBe(true);
  // Exactly at the 48px threshold.
  expect(isWithinPinZone(1000 - SCROLL_PIN_THRESHOLD_PX, 1000, 0)).toBe(true);
  // One pixel past the threshold.
  expect(isWithinPinZone(1000 - SCROLL_PIN_THRESHOLD_PX - 1, 1000, 0)).toBe(false);
  // clientHeight taken into account: scrolled to the visible bottom of a viewport.
  expect(isWithinPinZone(400, 500, 100)).toBe(true);
  // Scrolled well away from the bottom.
  expect(isWithinPinZone(0, 1000, 200)).toBe(false);
});

/** A minimal stand-in for the scrollable element, since happy-dom's own layout is always zero. */
function makeScrollElement(scrollTop: number, scrollHeight: number, clientHeight: number): HTMLDivElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "scrollTop", { value: scrollTop, writable: true });
  Object.defineProperty(element, "scrollHeight", { value: scrollHeight, writable: true });
  Object.defineProperty(element, "clientHeight", { value: clientHeight, writable: true });
  return element;
}

test("starts pinned", () => {
  const { result } = renderHook(() => useScrollPin(0));
  expect(result.current.pinned).toBe(true);
  expect(result.current.newItemCount).toBe(0);
});

test("attaching the viewport while pinned starts at the latest content", () => {
  const { result } = renderHook(() => useScrollPin(2));
  const element = makeScrollElement(0, 1000, 200);

  act(() => result.current.containerRef(element));

  expect(element.scrollTop).toBe(1000);
  expect(result.current.pinned).toBe(true);
});

test("while pinned, new content auto-scrolls (scrollTop follows scrollHeight) and stays pinned", () => {
  const { result, rerender } = renderHook(({ count }) => useScrollPin(count), { initialProps: { count: 1 } });
  const element = makeScrollElement(0, 500, 500);
  act(() => {
    result.current.containerRef(element);
  });

  act(() => {
    Object.defineProperty(element, "scrollHeight", { value: 900, writable: true });
    rerender({ count: 2 });
  });

  expect(result.current.pinned).toBe(true);
  expect(result.current.newItemCount).toBe(0);
  // The only assertion this test makes about the element is that the pin mechanism drove
  // its scrollTop to the (fake) scrollHeight — not that any real layout occurred.
  expect(element.scrollTop).toBe(900);
});

test("a user scroll away from the bottom unpins", () => {
  const { result } = renderHook(() => useScrollPin(1));
  const element = makeScrollElement(0, 500, 500);
  act(() => {
    result.current.containerRef(element);
  });
  expect(result.current.pinned).toBe(true);

  act(() => {
    Object.defineProperty(element, "scrollTop", { value: 0, writable: true });
    Object.defineProperty(element, "scrollHeight", { value: 1000, writable: true });
    Object.defineProperty(element, "clientHeight", { value: 200, writable: true });
    result.current.handleScroll();
  });

  expect(result.current.pinned).toBe(false);
});

test("while unpinned, new content never moves the viewport and the arrived-since count increments", () => {
  const { result, rerender } = renderHook(({ count }) => useScrollPin(count), { initialProps: { count: 1 } });
  const element = makeScrollElement(0, 1000, 200);
  act(() => {
    result.current.containerRef(element);
  });
  element.scrollTop = 0;
  act(() => result.current.handleScroll());
  expect(result.current.pinned).toBe(false);

  act(() => {
    Object.defineProperty(element, "scrollTop", { value: 0, writable: true });
    rerender({ count: 2 });
  });

  expect(result.current.pinned).toBe(false);
  expect(result.current.newItemCount).toBe(1);
  // No scroll was driven by the pin mechanism: scrollTop is exactly what we set it to,
  // not moved to (a fake) scrollHeight.
  expect(element.scrollTop).toBe(0);
});

test("multiple items arriving while unpinned accumulate into one total count", () => {
  const { result, rerender } = renderHook(({ count }) => useScrollPin(count), { initialProps: { count: 1 } });
  const element = makeScrollElement(0, 1000, 200);
  act(() => {
    result.current.containerRef(element);
  });
  element.scrollTop = 0;
  act(() => result.current.handleScroll());

  act(() => rerender({ count: 4 })); // 3 items arrived at once
  expect(result.current.newItemCount).toBe(3);

  act(() => rerender({ count: 6 })); // 2 more items arrived
  expect(result.current.newItemCount).toBe(5);
});

test("jumpToLatest scrolls to bottom, re-pins, and resets the count", () => {
  const { result, rerender } = renderHook(({ count }) => useScrollPin(count), { initialProps: { count: 1 } });
  const element = makeScrollElement(0, 1000, 200);
  act(() => {
    result.current.containerRef(element);
  });
  element.scrollTop = 0;
  act(() => result.current.handleScroll());
  act(() => rerender({ count: 3 }));
  expect(result.current.newItemCount).toBe(2);

  act(() => result.current.jumpToLatest());

  expect(result.current.pinned).toBe(true);
  expect(result.current.newItemCount).toBe(0);
  expect(element.scrollTop).toBe(element.scrollHeight);
});

test("once re-pinned via jumpToLatest, the next new content auto-scrolls again", () => {
  const { result, rerender } = renderHook(({ count }) => useScrollPin(count), { initialProps: { count: 1 } });
  const element = makeScrollElement(0, 1000, 200);
  act(() => {
    result.current.containerRef(element);
  });
  element.scrollTop = 0;
  act(() => result.current.handleScroll());
  act(() => rerender({ count: 2 }));
  expect(result.current.pinned).toBe(false);

  act(() => result.current.jumpToLatest());
  expect(result.current.pinned).toBe(true);

  act(() => {
    Object.defineProperty(element, "scrollHeight", { value: 1300, writable: true });
    rerender({ count: 3 });
  });

  expect(result.current.pinned).toBe(true);
  expect(result.current.newItemCount).toBe(0);
  expect(element.scrollTop).toBe(1300);
});

test("pin() re-arms auto-follow without moving the viewport itself, for a future caller that does its own scroll", () => {
  const { result, rerender } = renderHook(({ count }) => useScrollPin(count), { initialProps: { count: 1 } });
  const element = makeScrollElement(0, 1000, 200);
  act(() => {
    result.current.containerRef(element);
  });
  element.scrollTop = 0;
  act(() => result.current.handleScroll());
  act(() => rerender({ count: 2 }));
  expect(result.current.pinned).toBe(false);
  expect(result.current.newItemCount).toBe(1);

  const scrollTopBeforePin = element.scrollTop;
  act(() => result.current.pin());

  expect(result.current.pinned).toBe(true);
  expect(result.current.newItemCount).toBe(0);
  // pin() itself never touches the element — a caller that already scrolled elsewhere is
  // not overridden.
  expect(element.scrollTop).toBe(scrollTopBeforePin);
});
