import type { ReactNode } from "react";
import { useScrollPin } from "../../lib/scroll-pin";
import { JumpToLatest } from "./JumpToLatest";

interface ConversationViewportProps {
  readonly itemCount: number;
  /** Changes for in-place streaming growth even when the timeline length stays stable. */
  readonly contentRevision: unknown;
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * Task 8.5: the scrollable transcript, with scroll-pin/"Jump to latest" behaviour applied
 * around whatever is rendered as `children`. This component owns scroll anchoring only —
 * it renders no item and interprets no record or event (see design.md's Surface table:
 * "Viewport … Must not: Interpret records or events").
 */
export function ConversationViewport(props: ConversationViewportProps) {
  const scrollPin = useScrollPin<HTMLDivElement>(props.itemCount, props.contentRevision);

  return (
    <div className="tt-viewport-wrapper">
      <div
        aria-live="polite"
        className={props.className ? `tt-transcript ${props.className}` : "tt-transcript"}
        ref={scrollPin.containerRef}
        onScroll={scrollPin.handleScroll}
        data-pinned={scrollPin.pinned}
        data-new-item-count={scrollPin.newItemCount}
      >
        {props.children}
      </div>
      <JumpToLatest count={scrollPin.newItemCount} onClick={scrollPin.jumpToLatest} />
    </div>
  );
}
