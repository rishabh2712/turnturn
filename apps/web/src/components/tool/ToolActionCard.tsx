import type { ToolActionPresentation } from "@turnturn/chat-client";

export function ToolActionCard({ action }: { readonly action: ToolActionPresentation }) {
  return (
    <details className={`tt-action-card is-${action.status}`} open={action.status !== "completed"}>
      <summary>
        <span className="tt-action-icon" aria-hidden="true">
          {icon(action.kind)}
        </span>
        <span>
          <strong>{action.displayName}</strong>
          <small>{action.headline}</small>
        </span>
        <span className="tt-action-status">{statusLabel(action.status)}</span>
      </summary>
      <div className="tt-action-detail">{renderDetail(action)}</div>
    </details>
  );
}

function renderDetail(action: ToolActionPresentation) {
  const detail = action.detail;
  switch (detail.presentation) {
    case "file-read":
      return (
        <>
          <Metadata
            rows={[
              ["Path", detail.path],
              ["Lines", lineRange(detail.startLine, detail.lineCount)],
            ]}
          />
          {detail.content === undefined ? null : <pre>{detail.content}</pre>}
        </>
      );
    case "file-write":
      return (
        <Metadata
          rows={[
            ["Path", detail.path],
            ["Bytes written", detail.bytesWritten],
          ]}
        />
      );
    case "file-edit":
      return (
        <>
          <Metadata
            rows={[
              ["Path", detail.path],
              ["Replacements", detail.replacements],
            ]}
          />
          <div className="tt-edit-comparison">
            <CodePanel label="Before" value={detail.oldText} />
            <CodePanel label="After" value={detail.newText} />
          </div>
        </>
      );
    case "search":
      return (
        <>
          <Metadata
            rows={[
              ["Query", detail.query],
              ["Matches", detail.matches.length],
            ]}
          />
          <ul className="tt-result-list">
            {detail.matches.map((match, index) => (
              <li key={`${match.path}:${match.lineNumber}:${index}`}>
                <code>
                  {match.path}:{match.lineNumber}
                </code>
                <span>{match.line}</span>
              </li>
            ))}
          </ul>
          {detail.truncated ? <p className="tt-omission">Search output was truncated by the tool.</p> : null}
        </>
      );
    case "paths":
      return (
        <>
          <Metadata
            rows={[
              ["Pattern", detail.pattern],
              ["Files", detail.paths.length],
            ]}
          />
          <ul className="tt-path-list">
            {detail.paths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          {detail.truncated ? <p className="tt-omission">File results were truncated by the tool.</p> : null}
        </>
      );
    case "shell":
      return (
        <>
          <Metadata
            rows={[
              ["Working directory", detail.cwd],
              ["Exit code", detail.exitCode],
            ]}
          />
          <CodePanel label="Exact command" value={detail.command} />
          <CodePanel label="stdout" value={detail.stdout} />
          <CodePanel label="stderr" value={detail.stderr} />
          {detail.truncated ? <p className="tt-omission">Command output was truncated by the tool.</p> : null}
        </>
      );
    case "json":
      return (
        <section className="tt-code-panel">
          <span>Raw details</span>
          <pre>{JSON.stringify(detail.value, null, 2)}</pre>
        </section>
      );
  }
}

function Metadata({ rows }: { readonly rows: readonly (readonly [string, string | number | undefined])[] }) {
  return (
    <dl className="tt-action-metadata">
      {rows.map(([label, value]) =>
        value === undefined ? null : (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ),
      )}
    </dl>
  );
}

function CodePanel({ label, value }: { readonly label: string; readonly value?: string }) {
  if (value === undefined || value.length === 0) return null;
  return (
    <section className="tt-code-panel">
      <span>{label}</span>
      <pre>{value}</pre>
    </section>
  );
}

function lineRange(start?: number, count?: number): string | undefined {
  if (start === undefined) return count === undefined ? undefined : String(count);
  return count === undefined ? String(start) : `${start}–${start + Math.max(0, count - 1)}`;
}

function statusLabel(status: ToolActionPresentation["status"]): string {
  return status.replaceAll("-", " ");
}

function icon(kind: ToolActionPresentation["kind"]): string {
  switch (kind) {
    case "read":
      return "◫";
    case "write":
    case "edit":
      return "±";
    case "search":
    case "paths":
      return "⌕";
    case "shell":
      return ">_";
    case "unknown":
      return "◇";
  }
}
