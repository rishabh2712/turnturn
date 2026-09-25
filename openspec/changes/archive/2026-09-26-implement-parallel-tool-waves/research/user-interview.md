# User Interview: Parallel Tool Waves

Source: Rishabh's review conversation on 2026-09-23, following the initial parallel-tool-waves draft.

- Priority remains parallel tools before context economy and memory.
- Rishabh asked whether cancellation/abort is accounted for at each tool, whether one tool's failure leaves siblings intact, whether each tool call has a configurable timeout, how durable order is guaranteed, and which additional failures are covered.
- After reviewing the gap inventory, Rishabh accepted the recommendation to account for five guarantees in this change: admission/barriers, independent failures, bounded per-call deadlines, turn cancellation, and deterministic durable results. He asked for these to be logged in the design and tasks.
- Rishabh subsequently confirmed on 2026-09-23 that the complete design is approved. This closes the D1–D6 and full contract gate; the earlier five-goal agreement alone had not done so.

Interpretation for scope: deadline configuration applies to the read-only calls this milestone parallelizes. Shell keeps its existing timeout; mutating tools cannot safely receive a synthetic logical timeout without stronger side-effect control. User-facing per-tool cancel is not part of the accepted five guarantees.
