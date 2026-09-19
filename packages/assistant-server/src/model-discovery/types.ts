/**
 * A discovery response proves a model id is visible to a connection. It never proves
 * tool-call correctness (D30). `unknown` is the honest default when a provider does not
 * declare tool support one way or the other; `unsupported` is reserved for a model a
 * provider explicitly reports as not accepting completions/tools at all.
 */
export type ToolCompatibility = "supported" | "unsupported" | "unknown";

export interface DiscoveredModelOption {
  readonly modelId: string;
  readonly label: string;
  readonly toolCompatibility: ToolCompatibility;
}

export type DiscoveryErrorCode =
  | "TIMEOUT"
  | "ABORTED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "SERVER_ERROR"
  | "MALFORMED_RESPONSE"
  | "UNEXPECTED_SHAPE"
  | "NETWORK_ERROR";

export type DiscoveryOutcome =
  | { readonly status: "ok"; readonly models: readonly DiscoveredModelOption[] }
  | { readonly status: "error"; readonly code: DiscoveryErrorCode };
