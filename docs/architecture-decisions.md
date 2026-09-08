# Architecture Decisions

Each decision records how we got there and the tradeoffs considered.

## ADR-001: Engine and Renderer Boundary

Decision: turnturn v1 separates the agent engine from every renderer. CLI, web, desktop, and SDK surfaces consume canonical events rather than calling private engine state.

How we got there: Codex separates core session/turn handling from TUI/app rendering. agentic-code's `QueryEngine` owns conversation lifecycle while UI adapters translate stream events. Gemini CLI exposes SDK session APIs over a core loop.

Tradeoffs considered: A UI-first implementation would move faster for a demo, but it would trap orchestration inside presentation state. An engine-first boundary costs more upfront type design, but keeps CLI, SDK, and future UI surfaces honest.

## ADR-002: Canonical Provider-Neutral Messages

Decision: store and orchestrate canonical messages/events, then adapt them at provider boundaries.

How we got there: The roadmap requires provider-specific transforms without letting OpenAI, Gemini, Anthropic, or local models leak into persistence. Gemini CLI's content generator and agentic-code's SDK adapters show the adapter need clearly.

Tradeoffs considered: Provider-native history is simpler at first, but makes resume, replay, testing, and provider switching brittle. Canonical messages require richer adapters but preserve product control.

## ADR-003: Session, Conversation, Turn, and Step Are Separate

Decision: v1 models conversation, session, turn, and provider step as separate concepts.

How we got there: Codex has durable thread/session/turn/step concepts and uses step context for provider/runtime settings. agentic-code documents one engine per conversation with each submit creating a turn.

Tradeoffs considered: A single `ChatSession` object is easier to code, but it blurs persistence, runtime environment, and user-visible continuity. Separate concepts add naming overhead but prevent future resume and multi-environment pain.

## ADR-004: Sequential First, Parallel Waves Later

Decision: v1 starts with sequential tool execution, then adds wave-based parallelism with explicit parallel-safety metadata.

How we got there: Codex supports parallel tool calls only when handler metadata allows it and tests deterministic grouping/order. The user explicitly wants sequential first, then parallel using waves.

Tradeoffs considered: Immediate full parallelism improves latency, but makes approvals, filesystem mutation, cancellation, and result ordering risky. Sequential first gives correctness; waves add controlled speed once invariants are tested.

## ADR-005: Tool Policy Is a First-Class Runtime Gate

Decision: every tool invocation flows through a policy decision that can allow, deny, ask, abort, or modify input before execution.

How we got there: Codex permission profiles and agentic-code interactive permission handlers both make approval a runtime path, not a UI-only concern.

Tradeoffs considered: Tool-local permission checks are easy but inconsistent. A central policy gate is more ceremony but gives auditability, testability, and consistent approval semantics.

## ADR-006: Recoverable Tool Errors Stay Inside the Loop

Decision: tool failures should become structured tool results whenever possible; engine-fatal errors are reserved for failures that prevent safe continuation.

How we got there: The requested behavior says approval aborts and tool errors should not affect siblings or hamper the flow. Gemini and Codex both expose explicit error events and tool response events.

Tradeoffs considered: Throwing exceptions is simple but lets one tool collapse the turn. Structured errors require careful taxonomy, but they let the model recover and keep the event log complete.

## ADR-007: Persistence Is Append-Only First

Decision: v1 persists append-only canonical events, then derives hydrated state, replay history, summaries, and indexes from those events.

How we got there: Codex keeps session state/history and supports rollout reconstruction. agentic-code records transcript/session events early to avoid orphaned resume state.

Tradeoffs considered: Snapshot-only persistence is fast to implement but loses causality. Append-only logs are more verbose, but they power replay, debugging, migrations, and observability.

## ADR-008: Memory Is a Separate Consolidation Layer

Decision: memory is not raw chat history. v1 prepares explicit summaries/facts and a future consolidation layer that can be audited.

How we got there: The user wants eventual memory building and consolidation. Existing harnesses distinguish context compaction, memory files, and history injection.

Tradeoffs considered: Injecting all history is simple but expensive and noisy. Automatic memory is powerful but dangerous if silent. A separate consolidation layer makes memory useful without hiding what changed.

