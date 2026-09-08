# Roadmap Validation

Status: complete
Date: 2026-09-08

## Validation Question

Is the proposed v1 roadmap the correct course for turnturn, or is it merely a restatement of desired features?

## Current Assessment

The roadmap is directionally correct as a baseline, but it should not yet be treated as the final recommended design. It captures the right problem areas:

- agent loop
- provider abstraction
- tools and policies
- execution status
- sequential execution before parallel waves
- session/conversation relationship
- persistence, hydration, recall, and replay
- localized error handling and approval aborts
- tracing and turn observability
- engine/renderer boundary
- future memory consolidation
- future subagents

However, the first version was mostly a synthesis of the requested scope plus a light reading of the reference repos. The design approach has now been validated by targeted exploration of Codex, Gemini CLI, and agentic-code.

## Validation Method

Use three parallel explorer subagents:

- Codex explorer: study session/turn/step orchestration, tool runtime, policies, persistence, tracing, parallelism, and subagents.
- Gemini CLI explorer: study TypeScript SDK ergonomics, `AgentLoopContext`, tool registry, confirmation bus, session/resume, and implemented/missing extension points.
- agentic-code explorer: study `QueryEngine`, SDK message adapters, permission flow, history/session persistence, remote/local rendering boundaries, memory, and task/subagent patterns.

The main agent then integrates the reports into:

- a recommended turnturn v1 architecture path
- roadmap changes
- architecture decision updates
- implementation sequencing
- OpenSpec task updates

## Preliminary Recommendation

Keep the roadmap structure, but treat it as a staged architecture validation artifact:

1. Build the TypeScript protocol and engine boundaries first.
2. Borrow Codex's conceptual layering: session, turn, step, tool runtime, event lifecycle, and traceability.
3. Borrow Gemini CLI's SDK ergonomics and typed registry style where it makes TypeScript implementation faster.
4. Borrow agentic-code's single conversation lifecycle owner and adapter boundary lessons, but avoid letting UI state become the source of truth.
5. Defer parallel tool execution until sequential tool lifecycle, approval, persistence, and replay are tested.

## Output Before Implementation

Completed:

- `docs/recommended-design-v1.md`
- `docs/reference-research-summary.md`
- `docs/architecture-decisions.md`
- `openspec/changes/define-v1-roadmap/design.md`
- `openspec/changes/define-v1-roadmap/tasks.md`
