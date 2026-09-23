# Synthesis: Deadline Configuration and Failure Boundaries

The user accepted five guarantees before implementation: admission/barriers, isolated tool failures, bounded per-call deadlines, turn cancellation, and deterministic durable order. The challenge above narrows the timeout guarantee to the `read`, `glob`, and `grep` calls admitted to parallel waves. It does not imply user-facing `tool.cancel` or logical timeouts for mutating tools.

**Chosen boundary.** Add one optional field to exported `AssistantServerConfig`:

```ts
readOnlyToolTimeouts?: {
  defaultMs?: number;
  maxMs?: number;
  byTool?: Partial<Record<"read" | "glob" | "grep", number>>;
};
```

The server validates positive finite integer milliseconds, `defaultMs <= maxMs`, and each override `<= maxMs` at startup. Defaults are 30,000 ms and 120,000 ms respectively; reject values beyond the runtime's safe timer range rather than silently clamping. The effective deadline for a call is its per-tool override or the default. The server wraps its workspace `ToolExecutorPort` once at composition, before it is passed to either memory or persistent session engines. The wrapper preserves `definitions()` and `validate()` exactly and changes only execution of the three allowlisted read-only names. This is one backward-compatible public server-options addition; no public core port, provider, protocol, or durable-record change is authorized.

**Outcome boundary.** Each admitted call gets an independent timer and controller linked to the turn signal. On timeout, the wrapper aborts that call and resolves once with `failed({code: "TOOL_TIMEOUT"})`. Later executor fulfillment, rejection, or callbacks cannot change the recorded outcome or produce model-visible output. A turn cancellation signals all active calls; the runner preserves existing cancellation metadata if a tool returns after the cancel. A read/search implementation should cooperate with abort, but the wrapper bounds the logical wait even if it does not. A recoverable tool failure or executor throw affects only its call. Policy `abort`, turn cancellation, policy-service failure, and durable-writer failure remain different turn-wide/infrastructure paths.

**Rejected for this change.** Fixed-only timeout, model-controlled read/search deadline, all-tool logical `Promise.race`, and threading a new timeout field through `AssistantEngineOptions` or `ToolExecutionRequest`. Shell retains its own sequential runtime timeout. Physical interruption guarantees for arbitrary executors, managed processes, and timeouts for mutating tools need separate design.

**Verification before implementation is considered complete.** Force timeout of one sibling while another succeeds; reverse completion order; ignored abort with late resolution and callback; turn cancellation mid-wave; policy abort; executor throw; a policy-service exception after an earlier request; writer failure; interrupted-log repair; and two-step provider-history replay. Assert every persisted request has exactly one terminal result and both reducers report no issues whenever the writer is healthy. The design gate remains open until Rishabh reviews D1–D6 and these trade-offs.
