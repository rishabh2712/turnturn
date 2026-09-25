# Proposal: Parallel Tool Waves

The engine currently executes every tool call in a provider step to completion before starting the next. That keeps record order simple, but makes independent reads and searches unnecessarily slow. Real tool-using turns have now exercised the sequential path, so the scheduler requirement is concrete rather than speculative.

This change introduces bounded overlap only for contiguous, explicitly non-mutating tool calls in one provider step. All other calls remain ordered barriers. It must preserve one terminal result per requested call, an understandable provider-history order, and cancellation that cannot resurrect a terminal turn.

This is the next priority chosen by Rishabh on 2026-09-22. Context economy and cross-session memory follow it in `ROADMAP.md`. Safety/edit-trust work is not completed or weakened by this change.
