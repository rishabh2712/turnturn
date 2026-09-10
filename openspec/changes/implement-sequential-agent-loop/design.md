# Design: Sequential Agent Loop

Milestone 3. Scope lives in `ROADMAP.md`; this file holds decisions only.

Status: approved 2026-09-10. No implementation exists — an earlier attempt was removed so the design could be validated first.

## What This Milestone Proves

That the Milestone 2 protocol contract survives contact with a real provider and real tools. One narrow path end to end: a real repository, a model, a tool call, an edit on disk.

## Decision 1: Ports, Not Callbacks

The engine talks to the outside world through seven injected ports. It holds no renderer callbacks, no shared client memory, no provider-native state, and passes no object references across a boundary.

```ts
ProviderPort      // model steps
ToolExecutorPort  // tool execution
ToolPolicyPort    // allow / deny / ask before execution
DurableSink       // persists records, assigns sequence
LiveSink          // publishes ephemeral events
EngineIds         // uuid(), injected so tests are deterministic
EngineClock       // now(), same reason
```

Why: the Milestone 2 contract already separates durable records from live events, so the engine should depend on those types directly rather than inventing a callback API. Ports cost more test plumbing than a direct `run(input)` function, and buy the transport shape immediately.

## Decision 2: The Provider Port Shape

This is the part most worth reviewing, because everything else depends on it.

```ts
interface ProviderPort {
  readonly name: string;
  run(request: ProviderRequest): AsyncIterable<ProviderEvent>;
}

type ProviderEvent =
  | { type: "text-delta";                  text: string }
  | { type: "reasoning-delta";             text: string }
  | { type: "tool-call-start";             callId: string; name: string }
  | { type: "tool-call-arguments-delta";   callId: string; text: string }
  | { type: "tool-call-complete";          call: ProviderToolCall }
  | { type: "usage";                       usage: ProviderUsage }
  | { type: "completed";                   reason: CompletionReason; usage?: ProviderUsage }
  | { type: "failed";                      error: ProviderFailure };

type CompletionReason = "complete" | "tool-use" | "output-limit" | "refused" | "cancelled";

interface ProviderFailure {
  kind: "transport" | "request-rejected" | "protocol" | "interrupted" | "context-limit";
  message: string;
  retryable: boolean;
  status?: number;
}
```

Four choices to check:

1. **`usage` is in the port.** Milestone 5 enforces a context budget and Milestone 8 shows cost. Both need token counts, both providers stream them. Leaving usage out would force a port change two milestones later.
2. **`"tool-use"` is a completion reason.** A turn stopping to run tools is a different terminal state from a turn that finished talking, and the loop branches on exactly this.
3. **`"context-limit"` is its own failure kind.** It arrives as a pre-stream rejection and Milestone 5 needs to distinguish it from a generic rejection.
4. **Request history is `ProviderHistory`** from `reduceProviderHistory`, not a new message type. That reducer is already the definition of model-visible history; a parallel type would drift from it.

Two rules the adapter owns:

- **Nothing provider-shaped escapes.** No SSE, no provider event names, no provider finish-reason strings. `ProviderStepCompleted.stopReason` is a free-form string in the protocol; persist the canonical `CompletionReason` into it, never the raw provider value.
- **`tool-call-complete` fires only after arguments parse.** A truncated tool call ends as `completed: "output-limit"` or `failed: "interrupted"`. A parse error must never reach the engine. This is the behaviour a naive adapter gets wrong.

## Decision 3: Five Policy Outcomes, Two Approval Decisions

The protocol's `ApprovalDecisions` enum has only `Allow` and `Deny`. The milestone requires five policy outcomes. These are not in conflict — the five are policy-port outcomes, and only the human-facing question collapses to two.

```ts
type PolicyDecision =
  | { kind: "allow" }
  | { kind: "allow-modified"; input: JsonValue }
  | { kind: "deny";           error: SerializedError }
  | { kind: "ask";            reason: string }
  | { kind: "abort";          error: SerializedError };
```

| Decision | Records written | Terminal tool status |
| --- | --- | --- |
| `allow` | execute immediately | `completed` / `failed` |
| `allow-modified` | execute with replaced input; `tool.requested` records the modified input | `completed` / `failed` |
| `deny` | `tool.result.denied` | `denied` |
| `ask` | `approval.requested`, wait, `approval.resolved`; then execute or deny | per resolution |
| `abort` | `tool.result.aborted`, then fail the turn | `aborted` |

Do not widen the protocol enum. `abort` and `allow-modified` resolve inside the engine before an approval exists.

## Decision 4: Tools Fail as Outcomes, Not Exceptions

`ToolExecutorPort.execute` returns `{ kind: "completed" | "failed" }` and does not throw for tool-level failure. A missing file is a `failed` outcome. A thrown error means the executor itself is broken and fails the turn.

This is the mechanism behind "recoverable tool errors stay inside the loop": a `failed` outcome becomes `tool.result.failed` and the loop continues to the next provider step with that error as the tool result. Only `abort`, provider failure, and cancellation end a turn early.

A non-zero shell exit is a **`completed`** outcome carrying the exit code — the model needs to read the compiler error. `failed` means the command could not be run at all.

## Decision 5: Sequential Execution, Strictly Ordered

One tool at a time, in `providerOrder`. Parallel waves are v1.x, because the real scheduler requirements only become visible once sequential execution has run against real workloads.

Sibling isolation still applies: when one tool in a step fails or is denied, completed siblings keep their results and remaining siblings still get terminal records.

## Decision 6: Durable Before Live

Persist the record, then publish the matching terminal live event. A renderer must never learn a terminal fact that is not yet durable.

Non-terminal live events — `content.delta`, `tool.progress`, `stdout.delta` — have no durable counterpart and stream freely. `LiveSink.publish` is fire-and-forget and never awaited; a slow or throwing subscriber cannot stall or break a turn.

Consequence: assistant text is durable only as one `AssistantMessageCompleted` record carrying the whole string. Deltas are never durable. Replay reconstructs the message, not the typing.

## Decision 7: The Renderer Subscribes Through the Transport

Not directly to the engine's `LiveSink`. Every command and event round-trips through `serializeJson` and `JSON.parse`, even in-process, even in tests.

This costs plumbing before anything renders. It buys the guarantee that a non-serializable value fails loudly rather than after a transport exists, and it stops the renderer depending on object identity that will not survive a real boundary.

Resume is by durable record `sequence`, never by live-event id. A resuming subscriber gets the durable records it missed but not the live events — the completed assistant message is how it recovers the text.

## Decision 8: Two Providers, Anthropic First

`ProviderPort` is designed against both Anthropic and OpenAI shapes so the interface is not shaped by whichever adapter is written first. Anthropic wires in first — its content-block deltas and `tool_use`/`tool_result` blocks map most directly onto the Milestone 2 tool-use state machine, so it exercises the contract with the least translation in between.

A fixture-driven **conformance suite** is derived from the first adapter, so the second adapter is a new fixture set rather than a new suite.

Model routing and automatic fallback stay v1.x. Two adapters is not the same capability as choosing between them.

## Decision 9: The Scripted Provider Stays

It is the default test double for every loop-invariant test, and the deterministic suite is the correctness gate. Real adapters are tested against recorded stream fixtures; live smoke tests stay out of the default run.

## Decision 10: The Protocol Is Frozen This Milestone

No adding, renaming, or widening a protocol type to make engine code easier. A protocol change is contract-altering and needs its own change with full research.

Master invariant: `reduceEngineState(records).issues` must always be empty. That reducer already validates duplicate entities, missing parents, invalid transitions, and ordering. Derive legal record ordering from it, not from prose — where this design and the reducer disagree, the reducer is right.

## Known Gap

There is **no durable record for token usage** in the Milestone 2 contract. Milestone 5 cannot enforce a context budget without one. Not filled here, because that is a protocol change. Milestone 5 must design it.

## Prior Attempt, Removed

An implementation of Decisions 1, 2, 4, 6 and part of the loop existed and was deleted on 2026-09-10, unreviewed. Two reasons, both worth knowing before the next attempt:

- It was written with line breaks removed — one 1,320-character line held the entire tool-execution loop. The repo has no formatter config, so nothing prevented it. Add one before restarting.
- It never called `ToolPolicyPort`. Approvals, cancellation, and the race behaviour — the hard half of Decision 3 and the loop — were absent, and cancel/approval commands returned `UNIMPLEMENTED`.

The port definitions it produced matched this design and are reproduced above.

## Open Questions

- Does the OpenAI adapter land in this milestone or Milestone 8 with its auth surface? Sequencing only.
- Is v1.x parallel-wave work still bound by the Milestone 2 sibling-ordering contract once real tools exist?
