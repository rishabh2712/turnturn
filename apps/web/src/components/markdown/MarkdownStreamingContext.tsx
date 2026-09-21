import { createContext, useContext } from "react";

/** Whether the enclosing message is still streaming (not yet durable). 6.4. */
const MarkdownStreamingContext = createContext(false);

export function MarkdownStreamingProvider({
  streaming,
  children,
}: {
  readonly streaming: boolean;
  readonly children: React.ReactNode;
}) {
  return <MarkdownStreamingContext.Provider value={streaming}>{children}</MarkdownStreamingContext.Provider>;
}

export function useMarkdownStreaming(): boolean {
  return useContext(MarkdownStreamingContext);
}
