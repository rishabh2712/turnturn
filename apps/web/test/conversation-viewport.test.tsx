// @vitest-environment happy-dom
//
// Component-level proof that `ConversationViewport` reflects the scroll-pin hook's state
// correctly. As in scroll-pin.test.ts, no assertion depends on happy-dom's (nonexistent)
// layout: pinned/unpinned is read from `data-pinned`, the count from the rendered "Jump to
// latest" pill text, and "did the viewport move" is asserted via `scrollTop`, which is a
// plain writable number happy-dom does track even without real layout.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ConversationViewport } from "../src/components/viewport/ConversationViewport";

afterEach(cleanup);

function setScrollGeometry(element: HTMLElement, scrollTop: number, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(element, "scrollTop", { value: scrollTop, writable: true, configurable: true });
  Object.defineProperty(element, "scrollHeight", { value: scrollHeight, writable: true, configurable: true });
  Object.defineProperty(element, "clientHeight", { value: clientHeight, writable: true, configurable: true });
}

test("starts pinned and no pill is shown", () => {
  render(
    <ConversationViewport contentRevision={1} itemCount={2}>
      <div>item one</div>
      <div>item two</div>
    </ConversationViewport>,
  );
  const transcript = screen.getByText("item one").parentElement as HTMLElement;
  expect(transcript.getAttribute("data-pinned")).toBe("true");
  expect(screen.queryByText(/Jump to latest/)).toBeNull();
});

test("user scrolls away: state becomes unpinned", () => {
  render(
    <ConversationViewport contentRevision={1} itemCount={2}>
      <div>item one</div>
      <div>item two</div>
    </ConversationViewport>,
  );
  const transcript = screen.getByText("item one").parentElement as HTMLElement;
  setScrollGeometry(transcript, 0, 1000, 200);
  fireEvent.scroll(transcript);

  expect(transcript.getAttribute("data-pinned")).toBe("false");
});

test("new content while unpinned does not move the viewport and shows the arrived-since count", () => {
  const { rerender } = render(
    <ConversationViewport contentRevision={1} itemCount={2}>
      <div>item one</div>
      <div>item two</div>
    </ConversationViewport>,
  );
  const transcript = screen.getByText("item one").parentElement as HTMLElement;
  setScrollGeometry(transcript, 0, 1000, 200);
  fireEvent.scroll(transcript);
  expect(transcript.getAttribute("data-pinned")).toBe("false");

  // A third item arrives: itemCount increments to match, exactly as the real transcript's
  // `presentation.timeline.length` would when a new turn item is projected.
  rerender(
    <ConversationViewport contentRevision={2} itemCount={3}>
      <div>item one</div>
      <div>item two</div>
      <div>item three</div>
    </ConversationViewport>,
  );

  expect(transcript.scrollTop).toBe(0);
  expect(transcript.getAttribute("data-new-item-count")).toBe("1");
  expect(screen.getByText(/1 new message/)).toBeTruthy();
});

test("multiple items arriving while unpinned accumulate into one total count, not just the last", () => {
  const { rerender } = render(
    <ConversationViewport contentRevision={1} itemCount={1}>
      <div>item one</div>
    </ConversationViewport>,
  );
  const transcript = screen.getByText("item one").parentElement as HTMLElement;
  setScrollGeometry(transcript, 0, 1000, 200);
  fireEvent.scroll(transcript);

  // Three items arrive in one update.
  rerender(
    <ConversationViewport contentRevision={2} itemCount={4}>
      <div>item one</div>
      <div>item two</div>
      <div>item three</div>
      <div>item four</div>
    </ConversationViewport>,
  );

  expect(screen.getByText(/3 new messages/)).toBeTruthy();
});

test("clicking 'Jump to latest' scrolls to bottom, re-pins, and the pill disappears", () => {
  const { rerender } = render(
    <ConversationViewport contentRevision={1} itemCount={1}>
      <div>item one</div>
    </ConversationViewport>,
  );
  const transcript = screen.getByText("item one").parentElement as HTMLElement;
  setScrollGeometry(transcript, 0, 1000, 200);
  fireEvent.scroll(transcript);

  rerender(
    <ConversationViewport contentRevision={2} itemCount={2}>
      <div>item one</div>
      <div>item two</div>
    </ConversationViewport>,
  );
  expect(screen.getByText(/1 new message/)).toBeTruthy();

  fireEvent.click(screen.getByText(/Jump to latest/));

  expect(transcript.getAttribute("data-pinned")).toBe("true");
  expect(transcript.getAttribute("data-new-item-count")).toBe("0");
  expect(transcript.scrollTop).toBe(transcript.scrollHeight);
  expect(screen.queryByText(/Jump to latest/)).toBeNull();
});

test("once re-pinned, the next new content auto-scrolls again (state truly toggled back)", () => {
  const { rerender } = render(
    <ConversationViewport contentRevision={1} itemCount={1}>
      <div>item one</div>
    </ConversationViewport>,
  );
  const transcript = screen.getByText("item one").parentElement as HTMLElement;
  setScrollGeometry(transcript, 0, 1000, 200);
  fireEvent.scroll(transcript);

  rerender(
    <ConversationViewport contentRevision={2} itemCount={2}>
      <div>item one</div>
      <div>item two</div>
    </ConversationViewport>,
  );
  fireEvent.click(screen.getByText(/Jump to latest/));

  // Simulate the container having grown before more content arrives.
  setScrollGeometry(transcript, transcript.scrollTop, 1500, 200);
  rerender(
    <ConversationViewport contentRevision={3} itemCount={3}>
      <div>item one</div>
      <div>item two</div>
      <div>item three</div>
    </ConversationViewport>,
  );

  expect(transcript.getAttribute("data-pinned")).toBe("true");
  expect(transcript.getAttribute("data-new-item-count")).toBe("0");
  expect(transcript.scrollTop).toBe(1500);
});

test("streaming growth inside the same item follows while pinned", () => {
  const { rerender } = render(
    <ConversationViewport contentRevision={1} itemCount={1}>
      <div>partial</div>
    </ConversationViewport>,
  );
  const transcript = screen.getByText("partial").parentElement as HTMLElement;
  setScrollGeometry(transcript, 800, 1000, 200);

  setScrollGeometry(transcript, 800, 1300, 200);
  rerender(
    <ConversationViewport contentRevision={2} itemCount={1}>
      <div>partial plus more streamed text</div>
    </ConversationViewport>,
  );

  expect(transcript.scrollTop).toBe(1300);
  expect(screen.queryByText(/new message/)).toBeNull();
});

test("streaming growth inside the same item does not move or increment while unpinned", () => {
  const { rerender } = render(
    <ConversationViewport contentRevision={1} itemCount={1}>
      <div>partial</div>
    </ConversationViewport>,
  );
  const transcript = screen.getByText("partial").parentElement as HTMLElement;
  setScrollGeometry(transcript, 0, 1000, 200);
  fireEvent.scroll(transcript);

  setScrollGeometry(transcript, 0, 1300, 200);
  rerender(
    <ConversationViewport contentRevision={2} itemCount={1}>
      <div>partial plus more streamed text</div>
    </ConversationViewport>,
  );

  expect(transcript.scrollTop).toBe(0);
  expect(transcript.getAttribute("data-new-item-count")).toBe("0");
});
