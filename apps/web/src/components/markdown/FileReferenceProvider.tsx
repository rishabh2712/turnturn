import { createContext, useContext } from "react";

/** A workspace file reference recognized in assistant text (D19). */
export interface WorkspaceFileRef {
  readonly path: string;
  readonly line?: number;
}

export type OpenFileHandler = (ref: WorkspaceFileRef) => void;

const defaultOpenFile: OpenFileHandler = () => {
  // No host handler installed. Rendering still works — the anchor is inert
  // rather than silently failing to navigate (it never could; `turnturn://`
  // is not a resolvable scheme).
};

const FileReferenceContext = createContext<OpenFileHandler>(defaultOpenFile);

/** D19 — every click on a file-reference anchor goes through this one handler. */
export function FileReferenceProvider({
  openFile,
  children,
}: {
  readonly openFile: OpenFileHandler;
  readonly children: React.ReactNode;
}) {
  return <FileReferenceContext.Provider value={openFile}>{children}</FileReferenceContext.Provider>;
}

export function useFileReference(): OpenFileHandler {
  return useContext(FileReferenceContext);
}
