# turnturn Roadmap

Status: root source of truth for milestones
Date: 2026-09-08

## Operating Rule

This file tracks product and architecture milestones. OpenSpec tracks implementation proposals, design details, specs, research, and tasks for each milestone.

When a milestone is completed, update this roadmap in the same change that archives or completes the corresponding OpenSpec work.

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

## Milestone 1: Harness Boundary Design

Goal: define the first implementation design for the coding harness before writing engine code.

OpenSpec change:

- `design-harness-boundaries`

Required decisions:

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
- Design answers what is in v1, what is only designed for later, and what is explicitly out of scope.
- Tasks are ready for protocol and engine scaffolding.

## Milestone 2: Protocol and Event Log

Goal: define and implement canonical IDs, messages, events, statuses, errors, serialization fixtures, replay fixtures, and append-only persistence before engine scaffolding depends on them.

OpenSpec change:

- TBD

Exit criteria:

- Provider-neutral protocol package.
- Event schema versioning.
- Durable vs ephemeral event distinction.
- JSON serialization round-trip fixtures for transport commands/events.
- Event identity, ordering, parent/causal IDs, and subscription resume semantics.
- Tool-use/tool-result state machine.
- Approval and cancellation command semantics.
- Replay fixture for one completed turn.

## Milestone 3: Sequential Agent Loop

Goal: implement the minimal engine loop with a scripted provider and sequential tool execution.

OpenSpec change:

- TBD

Exit criteria:

- Conversation/session/turn/step lifecycle.
- Tool use/tool result invariant.
- Policy gate with allow, deny, ask, abort, and modified input.
- Recoverable tool errors remain inside the loop.

## Milestone 4: Local Transport and Renderer

Goal: expose the engine through an in-process transport and a minimal CLI/debug renderer.

OpenSpec change:

- TBD

Exit criteria:

- Transport-safe command/event protocol.
- Subscription with `afterEventId`.
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

Goal: add opt-in parallel-safe tool waves.

OpenSpec change:

- TBD

Exit criteria:

- Parallel-safe tools overlap under test.
- Mutating tools serialize by default.
- Results return in original call order.
- Sibling failures do not corrupt successful sibling results.
