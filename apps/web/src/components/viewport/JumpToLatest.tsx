interface JumpToLatestProps {
  readonly count: number;
  readonly onClick: () => void;
}

/** design.md "Scrolling": a pill offered while unpinned, carrying a count of items that arrived since. */
export function JumpToLatest(props: JumpToLatestProps) {
  if (props.count <= 0) return null;
  return (
    <button type="button" className="tt-jump-to-latest" onClick={props.onClick}>
      {props.count === 1 ? "1 new message" : `${props.count} new messages`} · Jump to latest
    </button>
  );
}
