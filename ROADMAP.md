# turnturn Roadmap

Status: root source of truth for milestones
Date: 2026-09-08

## Operating Rule

This file tracks product and architecture milestones. OpenSpec tracks implementation proposals, design details, specs, research, and tasks for each milestone.

When a milestone is completed, update this roadmap in the same change that archives or completes the corresponding OpenSpec work.

Milestones are ordered by dependency, not just by implementation convenience. Later implementation can be deferred, but contracts that earlier work depends on must be defined first.

## Dry Structure

```text
turnturn/
  ROADMAP.md
  README.md
  package.json
  pnpm-workspace.yaml
  openspec/
    project.md
    specs/
      agent-harness/
        spec.md
    changes/
      <milestone-change>/
        proposal.md
        design.md
        tasks.md
        specs/
          <capability>/
            spec.md
        research/
          codex.md
          gemini-cli.md
          agentic-code.md
          neutral-challenge.md
          synthesis.md
  .agents/
    skills/
      turnturn-architecture/
        SKILL.md
```

No separate architecture document set should compete with OpenSpec. Research stays inside the change that produced it. Final decisions for a milestone stay in that change's `design.md`; accepted behavior graduates into `openspec/specs/`.

## Milestone 0: Architecture Curriculum

Goal: establish the project operating model so every agent knows where to find roadmap, research, design, specs, and tasks.

OpenSpec change:

- `define-v1-roadmap`

Exit criteria:

- Root roadmap exists.
- OpenSpec project context exists.
- Architecture skill points agents to root roadmap and OpenSpec.
- Document bloat has a consolidation plan.

## Milestone 1: Harness Boundary Hypothesis

Goal: define the boundary map and the questions each boundary must answer before writing engine code. This milestone is a hypothesis, not approval to implement protocol-dependent engine internals.

OpenSpec change:

- `design-harness-boundaries`

Required boundary questions:

- Engine boundary.
- Client/renderer boundary.
- Transport boundary.
- App/session server boundary.
- Runtime executor boundary.
- Provider boundary.
- Tool and policy boundary.
- Persistence/hydration/replay boundary.
- Observability boundary.
- Memory and subagent boundary.

Exit criteria:

- Raw reference research is preserved under the change's `research/` folder.
- Neutral challenge is completed.
- Design states which boundaries are hypothesized for v1, which are deferred, and which must be proven by later contract work.
- Design explicitly gates engine implementation on the protocol/event-log contract.

## Milestone 2: Protocol and Event Log Contract Gate

Status: in progress. Protocol types, JSON serialization fixtures, JSONL writer/reader storage, and engine-state replay are implemented; provider-history replay, idempotency, and lifecycle race validation remain open in OpenSpec.

Goal: define and implement canonical IDs, messages, events, statuses, errors, serialization fixtures, replay fixtures, and append-only persistence before engine scaffolding depends on them.

OpenSpec change:

- `design-protocol-event-log`

Exit criteria:

- Provider-neutral protocol package.
- Event schema versioning.
- Durable record vs live event distinction.
- JSON serialization round-trip fixtures for commands, durable records, live events, and structured errors.
- Record identity, writer-assigned ordering, typed semantic IDs, and durable cursor semantics.
- Tool-use/tool-result state machine.
- Approval and cancellation command semantics.
- Append-only JSONL writer/reader semantics.
- Separate engine-state and provider-history replay projections.
- Replay fixtures for completed turn, denial, cancellation races, duplicate commands, corrupt tail, cursor resume, and multiple tool calls in one provider step.

## Milestone 3: Sequential Agent Loop

Goal: implement the minimal engine loop with a scripted provider and sequential tool execution through the Milestone 2 command/event contracts.

OpenSpec change:

- TBD

Exit criteria:

- Conversation/session/turn/step lifecycle.
- Engine accepts `CommandEnvelope` input and emits `DurableRecord` plus `LiveEvent` output even for local in-process tests.
- Engine does not rely on renderer callbacks, shared client memory, provider-native durable state, or object references across the boundary.
- Tool use/tool result invariant.
- Policy gate with allow, deny, ask, abort, and modified input.
- Recoverable tool errors remain inside the loop.

## Milestone 4: Local Transport and Renderer

Goal: expose the engine through an in-process transport and a minimal CLI/debug renderer, proving that local clients use the same serialized protocol shape future clients will use.

OpenSpec change:

- TBD

Exit criteria:

- In-process transport serializes/deserializes command and event envelopes in tests.
- Subscription resume uses durable record sequence/cursor semantics, not live-event IDs.
- Approval response and cancellation commands.
- Debug turn timeline.

## Milestone 5: Hydration, Recall, and Replay

Goal: make sessions durable across process restarts.

OpenSpec change:

- TBD

Exit criteria:

- Hydration rebuilds engine state.
- Replay reconstructs model-visible history.
- Recall injects summaries/facts without mutating raw history.

## Milestone 6: Parallel Tool Waves

Goal: add opt-in parallel-safe tool waves after sequential execution exposes the real scheduler requirements.

OpenSpec change:

- TBD

Exit criteria:

- Parallel-safe tools overlap under test.
- Mutating tools serialize by default.
- Results return in original call order.
- Sibling failures do not corrupt successful sibling results.
