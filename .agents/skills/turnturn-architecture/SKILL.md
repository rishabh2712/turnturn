---
name: turnturn-architecture
description: Use when planning, designing, or implementing turnturn's coding-assistant harness so decisions follow the v1 roadmap, OpenSpec artifacts, and architecture decision discipline.
---

# turnturn Architecture

## Required Context

Read before making any architectural or implementation decision:

- `ROADMAP.md` — v1 scope and milestone order. The root source of truth.
- `openspec/project.md` — working rules, including the design-review requirement and one-home-per-fact.
- The current change under `openspec/changes/`, and `openspec/specs/` for accepted behavior.

Update `ROADMAP.md` in the same work that completes a milestone.

## The Design Gate

**Every change has a `design.md`, and the user reviews it before implementation starts.** No exceptions. If asked to implement a change whose design has not been validated, write or finish the design and stop for review.

Run `pnpm check:milestone <change-id>` before implementing. If it fails, complete the missing work rather than working around it.

Two tiers, per `openspec/project.md`:

- **Contract-altering** (protocol types, durable record formats, persisted policy semantics, public package APIs): also needs `research/neutral-challenge.md` and `research/synthesis.md`, and a `design.md` written from them.
- **Everything else**: `proposal.md`, `design.md`, `tasks.md`, and one `research/research.md` naming what is borrowed and from which reference file.

Do not write separate handoff documents. Implementation instructions go in `tasks.md`, written so another model can execute them without the authoring conversation.

Do not create parallel long-form docs under `docs/`. Durable architecture context goes in `openspec/project.md` or this skill, decisions in a change's `design.md`, accepted behavior in `openspec/specs/`, research in the change's `research/`.

## Reference Implementations

Sibling paths from the repo root:

- `../codex` — strongest reference for harness layering, sandboxing, patch application, and session persistence.
- `../gemini-cli` — strongest reference for TypeScript ergonomics, typed tools, context pipeline, and policy engine.
- `../claude-code` — strongest reference for operational loop invariants and conversation lifecycle. Research files written before 2026-09-09 call this `agentic-code`; same reference, former name.

Inspect the relevant reference before deciding, and cite the file path you took a pattern from. If a reference repo is missing, record that in the change's research rather than hardcoding an absolute path.

Reference breadth is not a target. codex is ~1.7M lines including cloud execution, voice, and four sandbox backends, none of which are in v1.

## Decision Discipline

Every major design choice records: the decision, how we got there, the reference path that informed it, the tradeoffs considered, the options rejected, and the consequences for engine, renderer, persistence, provider adapters, tools, approvals, tracing, memory, or subagents.

## v1 Architecture Rules

These are settled. Do not relitigate them inside an implementation change.

- Keep the engine separate from CLI, web, desktop, and SDK renderers.
- Keep provider-specific formats behind adapters. Persist canonical events, never provider-native messages.
- Model conversation, session, turn, step, tool call, and approval as separate concepts.
- Define protocol contracts before engine code depends on them.
- Build even local v1 through the serialized boundary: `CommandEnvelope -> Engine -> DurableRecord + LiveEvent`.
- No renderer callbacks, approval callbacks, shared client memory, or object references crossing the engine boundary.
- Approval is serializable messages, not callback ownership.
- Subscription and replay cursors use durable record ordering, never ephemeral live-event IDs.
- Sequential tool execution first; parallel waves only after lifecycle and error semantics are tested. Sequential still represents multiple tool calls from one provider step in stable provider order.
- Recoverable tool failures are structured tool results, not turn failures.
- Keep memory consolidation and subagents separate from raw renderer state.
- `packages/protocol` is frozen. Changing it is a contract-altering change with its own design.

## Code Conventions

`packages/protocol` sets them: ESM with `.js` extensions on relative imports, `NodeNext`, `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, tests as `node --test` on `.mjs` against built output. Payloads crossing a boundary must survive `serializeJson`, which rejects `undefined`, `Date`, class instances, `Map`, `Set`, and non-plain prototypes.

Write readable code. One statement per line, line breaks where a reader needs them. A prior implementation attempt was deleted partly for shipping a 1,320-character line holding an entire loop.

## Model Routing

For delegated work, when the tool supports model selection:

- Research and exploration: `gpt-5.5`
- Synthesis and reconciliation: `gpt-5.6-sol`
- Code writing: `gpt-5.6-luna`

The main agent stays responsible for integrating results, checking tradeoffs, and preserving research in OpenSpec.
