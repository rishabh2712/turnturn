# Proposal: Sequential Agent Loop

Milestone 3. Scope in `ROADMAP.md`, decisions in `design.md`, work in `tasks.md`.

## Why

Milestone 2 defined the protocol and replay substrate. The open risk is whether real engine code stays inside that shape once provider steps, tool requests, approvals, cancellation, and recoverable errors enter the loop.

A scripted provider cannot answer that. It validates the contract against our own assumptions, not against provider reality — partial tool-call JSON, interleaved text and tool deltas, mid-stream refusals, and context limits reached inside a turn are shapes it never produces. The same holds for tools: an edit that does not apply is the most common real failure, and no scripted tool surfaces it.

So this milestone is a vertical slice rather than a layer. If the plan is wrong, it is wrong after there is a working agent rather than before.

## What Changes

A new `packages/assistant-core` holding the engine, its ports, the six tools, one real provider adapter, and an in-process transport; plus a minimal CLI renderer in `apps/cli`.

Milestone 2's contract is not reopened.

## Non-Goals

Milestone 4 owns persisted allow/deny rules, shell command classification, and sandboxing. Milestone 5 owns compaction and token budgeting. Milestone 6 owns fuzzy edit matching. Milestone 7 owns hydration and resume. Additional providers, model routing, parallel tool waves, MCP, subagents, skills, and memory are v1.x or later.

## Status

Design approved 2026-09-10; implementation starts at T1. An earlier implementation attempt was removed unreviewed; see `design.md`, "Prior Attempt, Removed".
