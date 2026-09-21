import { useEffect, useState } from "react";
import { FilePeekPanel, type FilePeekState } from "../../components/markdown/FilePeekPanel";
import { FileReferenceProvider, type WorkspaceFileRef } from "../../components/markdown/FileReferenceProvider";
import { useChatTransport } from "../../providers/TransportProvider";

const FILE_WINDOW_LINES = 200;

function windowFor(line: number | undefined): { start: number; end: number } {
  if (line === undefined) return { start: 1, end: FILE_WINDOW_LINES };
  const start = Math.max(1, line - Math.floor(FILE_WINDOW_LINES / 2));
  return { start, end: start + FILE_WINDOW_LINES - 1 };
}

/**
 * D19/D33 feature controller. It owns the active file reference and the
 * transport request lifecycle. The panel below it receives render state and
 * callbacks only; no Markdown leaf constructs a route or calls `fetch`.
 */
export function WorkspaceFilePeekProvider({
  workspaceKey,
  children,
}: {
  readonly workspaceKey: string | undefined;
  readonly children: React.ReactNode;
}) {
  const transport = useChatTransport();
  const [active, setActive] = useState<WorkspaceFileRef | null>(null);
  const [state, setState] = useState<FilePeekState>({ status: "loading" });

  useEffect(() => {
    if (active === null || workspaceKey === undefined) return;
    let current = true;
    setState({ status: "loading" });
    const { start, end } = windowFor(active.line);
    void transport.getWorkspaceFile(workspaceKey, active.path, start, end).then(
      (region) => {
        if (current) setState({ status: "ready", region });
      },
      (cause: unknown) => {
        if (current) {
          setState({ status: "error", message: cause instanceof Error ? cause.message : String(cause) });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [active, transport, workspaceKey]);

  return (
    <FileReferenceProvider
      openFile={(reference) => {
        if (workspaceKey === undefined) return;
        setActive(reference);
      }}
    >
      {children}
      {active !== null && workspaceKey !== undefined ? (
        <FilePeekPanel onClose={() => setActive(null)} reference={active} state={state} />
      ) : null}
    </FileReferenceProvider>
  );
}
