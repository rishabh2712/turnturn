import type { WorkspaceFile } from "@turnturn/chat-client";
import { useEffect } from "react";
import type { WorkspaceFileRef } from "./FileReferenceProvider";

export type FilePeekState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly region: WorkspaceFile }
  | { readonly status: "error"; readonly message: string };

/**
 * D19 — the browser host has no OS file integration, so a file reference
 * opens an in-app read-only "peek" instead: it fetches the referenced
 * region through `GET /api/workspaces/:key/file`, which the server confines
 * with `WorkspacePathGuard`. Content is rendered as literal text (D18's
 * "tool output/file contents never go through the Markdown pipeline"
 * applies here too — this is a raw file region, not assistant prose).
 */
export function FilePeekPanel({
  reference,
  state,
  onClose,
}: {
  readonly reference: WorkspaceFileRef;
  readonly state: FilePeekState;
  readonly onClose: () => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="tt-file-peek-backdrop">
      <button aria-label="Close preview" className="tt-file-peek-backdrop-button" onClick={onClose} type="button" />
      <div aria-label={`Preview of ${reference.path}`} aria-modal="true" className="tt-file-peek" role="dialog">
        <div className="tt-file-peek-header">
          <span className="tt-file-peek-path">
            {reference.path}
            {reference.line === undefined ? "" : `:${reference.line}`}
          </span>
          <div className="tt-file-peek-actions">
            <button onClick={() => void navigator.clipboard.writeText(reference.path)} type="button">
              Copy path
            </button>
            <button onClick={onClose} type="button">
              Close
            </button>
          </div>
        </div>
        <div className="tt-file-peek-body">
          {state.status === "loading" ? <p className="tt-muted">Loading…</p> : null}
          {state.status === "error" ? (
            <p role="alert">
              Could not load {reference.path}: {state.message}
            </p>
          ) : null}
          {state.status === "ready" ? (
            <pre>
              {state.region.content.split("\n").map((line, offset) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines within one fetched, immutable region never reorder.
                <div className={line === undefined ? "" : "tt-file-peek-line"} key={offset}>
                  <span className="tt-file-peek-lineno">{state.region.start + offset}</span>
                  <span>{line}</span>
                </div>
              ))}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}
