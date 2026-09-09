# User Interview: Sequential Agent Loop

Status: completed

Before implementation starts, answer these with the user and update `design.md` from the conclusions.

## Questions

- What are we designing in Milestone 3?
- How should the implementation be approached?
- Which failure modes must Milestone 3 address?
- Which failure modes are explicitly parked for a later milestone?
- What would make this design unacceptable even if the code works?

## Answers

### What Milestone 3 Must Prove

Milestone 3 must prove that turnturn can run a real agent turn through the protocol boundary without becoming callback-shaped, UI-shaped, or provider-shaped.

The accepted spine is:

```text
turn.submit
-> user.input.accepted
-> provider.step.started
-> tool.requested
-> approval.requested
-> approval.resolve allow
-> tool.result.completed
-> provider receives tool result
-> assistant.message.completed
-> turn.completed
-> replay reconstructs engine state and provider history
```

### Implementation Approach

Start with a deterministic scripted provider, not a real model provider. The engine should still accept `CommandEnvelope`, append `DurableRecord`, and publish `LiveEvent` so local implementation proves the same shape future transports will use.

The first implementation should show conversation/session setup, one submitted turn, one provider step, approval, one tool execution, a follow-up provider step after the tool result, assistant completion, and replay through both existing reducers.

### Failure Modes Milestone 3 Must Address

- Duplicate submit, approval, and cancellation commands must not repeat side effects.
- Every durable tool request must reach exactly one terminal result.
- Policy denial must avoid executor invocation and still produce a safe terminal result when provider history requires one.
- Recoverable tool failure must stay inside the turn loop as a model-visible tool result where safe.
- Cancellation must handle a pending approval, running tool, and running turn without corrupting replay state.
- Engine output must replay through engine-state and provider-history reducers.
- The engine must work without renderer callbacks or shared UI state.

### Explicitly Parked

- Real OpenAI, Gemini, or other provider adapters.
- Remote HTTP, SSE, or WebSocket transport.
- CLI/debug timeline renderer polish.
- Memory consolidation.
- Subagents.
- Parallel tool waves.
- Production sandboxing.

### Unacceptable Even If Code Works

- The engine is implemented around callbacks such as `onApproval` or `onEvent` instead of protocol messages.
- The engine persists provider-native messages or SDK objects.
- Replay depends on live events, renderer state, timestamps, or in-memory objects.
- Tool failures disappear instead of becoming terminal durable records or explicit turn failures.
- The scripted local path cannot later be replaced by a remote transport without changing engine semantics.
