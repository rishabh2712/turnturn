# Proposal: Understand the Codex Harness

Turnturn now has a working agent loop, durable sessions, tools, approvals, and traces. Rishabh wants to understand why the Codex harness can still feel more effective, apart from model quality, before choosing further architecture. This is a cross-cutting investigation: the findings span instructions, context, execution, editing, recovery, and memory, so they do not belong only to the parallel-tools change.

The research compares pinned local source snapshots and records what is implemented, what is absent, what effect we expect, and what we have not measured. We will review the topics one by one. `ROADMAP.md` continues to own priority and scope; this exploration does not authorize or implement a new architecture.
