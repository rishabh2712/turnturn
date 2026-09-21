import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Task 8.5 / design.md "Scrolling": pinned while within 48px of the bottom, unpinned the
 * moment the reader scrolls away, "Jump to latest" carries a count of items that arrived
 * since, and the viewport is never moved while unpinned.
 *
 * This is deliberately a standalone hook rather than logic embedded in a single viewport
 * component: D31 documents a second caller (the pinned approval bar's future "View"
 * action) that needs to perform its own scroll and then re-arm auto-follow through this
 * same mechanism. That caller is not built here — it is gated on a separate, still-pending
 * design review — but `pin()` is exported for it to reuse without forking this state.
 */

export const SCROLL_PIN_THRESHOLD_PX = 48;

/**
 * Pure decision function, unit-testable with plain numbers. `happy-dom` (this repo's test
 * DOM) implements no real layout engine, so `scrollTop`/`scrollHeight`/`clientHeight` are
 * never authentic in a jsdom/happy-dom test — this function exists so the pin/unpin
 * decision can be verified directly, without asserting on any pixel value a fake DOM
 * produced.
 */
export function isWithinPinZone(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = SCROLL_PIN_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

export interface ScrollPinController<T extends HTMLElement = HTMLDivElement> {
  /** Attach to the scrollable element via `ref`. */
  readonly containerRef: (node: T | null) => void;
  /** Whether the viewport currently follows new content. */
  readonly pinned: boolean;
  /** Count of appended items the reader has not yet seen, reset to 0 once re-pinned. */
  readonly newItemCount: number;
  /** The scroll container's native `onScroll` handler — wire it up unconditionally. */
  readonly handleScroll: () => void;
  /** Scrolls to the bottom and re-pins; this is what "Jump to latest" calls. */
  readonly jumpToLatest: () => void;
  /**
   * Re-arms auto-follow without moving the viewport itself — for a caller that performs
   * its own scroll (e.g. a future "View" action scrolling to a specific card) and wants
   * subsequent new content to resume auto-scrolling exactly as clicking "Jump to latest"
   * would arrange, per D31's "Interaction with the pin/jump-to-latest mechanism".
   */
  readonly pin: () => void;
}

/**
 * `itemCount` is the length of whatever list is rendered in the scroll container (e.g. the
 * projected turn timeline). The hook does not know what an "item" is — it only reacts to
 * the count increasing — which keeps it free of any record/event interpretation.
 */
export function useScrollPin<T extends HTMLElement = HTMLDivElement>(
  itemCount: number,
  contentRevision: unknown = itemCount,
): ScrollPinController<T> {
  const elementRef = useRef<T | null>(null);
  const [pinned, setPinned] = useState(true);
  const [newItemCount, setNewItemCount] = useState(0);
  const previousItemCount = useRef(itemCount);
  const previousContentRevision = useRef(contentRevision);
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  const scrollToBottom = useCallback(() => {
    const element = elementRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
  }, []);

  const containerRef = useCallback(
    (node: T | null) => {
      elementRef.current = node;
      if (node !== null && pinnedRef.current) scrollToBottom();
    },
    [scrollToBottom],
  );

  useEffect(() => {
    if (Object.is(previousContentRevision.current, contentRevision)) return;
    previousContentRevision.current = contentRevision;
    if (pinnedRef.current) scrollToBottom();
  }, [contentRevision, scrollToBottom]);

  useEffect(() => {
    const delta = itemCount - previousItemCount.current;
    previousItemCount.current = itemCount;
    if (delta <= 0) return;
    if (pinnedRef.current) {
      scrollToBottom();
    } else {
      setNewItemCount((count) => count + delta);
    }
  }, [itemCount, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const element = elementRef.current;
    if (element === null) return;
    const nowPinned = isWithinPinZone(element.scrollTop, element.scrollHeight, element.clientHeight);
    setPinned(nowPinned);
    if (nowPinned) setNewItemCount(0);
  }, []);

  const pin = useCallback(() => {
    setPinned(true);
    setNewItemCount(0);
  }, []);

  const jumpToLatest = useCallback(() => {
    scrollToBottom();
    pin();
  }, [scrollToBottom, pin]);

  return { containerRef, pinned, newItemCount, handleScroll, jumpToLatest, pin };
}
