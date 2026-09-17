---
name: review-before-code
description: Explain and review non-trivial coding changes before implementation, then implement one reviewable slice and teach the resulting code. When the repository uses OpenSpec, trace the selected task through its design decisions and required scenarios before coding. Use for behavioral, architectural, multi-file, public-API, persistence, or similarly substantive implementation work; skip tiny mechanical edits.
---

# Review Before Code

Help the user understand and approve how substantive code will change before writing it. The objective is informed collaboration, not ceremony.

## Before implementation

Inspect enough of the current code and tests to make the explanation evidence-based. Present one concise review packet containing:

1. The problem being solved and why it matters.
2. The current code flow, naming the important functions, boundaries, and source of truth.
3. The proposed flow and where responsibility will move or be added.
4. Small pseudocode showing the behavioral change. Avoid presenting finished production code as pseudocode.
5. The files expected to change and the purpose of each change.
6. The tests or observable checks that will prove the change.
7. Material trade-offs, risks, assumptions, and deliberately deferred work.

Calibrate depth to the task. Do not force seven headings when a few short paragraphs communicate the same information more clearly. Use clickable file links when the files are known.

End by asking whether the user understands and wants this slice implemented. Do not modify production code until the user explicitly approves the explained slice.

Approval of a milestone, plan, design, or earlier slice does not automatically approve every later implementation slice. A direct “go ahead” after the review packet approves the slice just explained.

## OpenSpec alignment

When the repository contains an `openspec/` root or the user names an OpenSpec change, ground the review in that change rather than treating a task checkbox as a standalone instruction.

1. Read the repository's OpenSpec project context and use it to identify which artifact owns each kind of fact.
2. Resolve the active change and read the apply context reported by the OpenSpec CLI when it is available. Otherwise read the change's proposal, design, tasks, and relevant delta specs directly.
3. Identify the exact pending task or smallest coherent group of tasks, including its dependencies, acceptance criteria, gotchas, and required verification.
4. Trace that task to the design decision that explains the architecture and to the spec requirement or scenario that defines observable behavior.
5. Inspect the current code and tests to show where the design is already represented and where the selected task adds or changes behavior.

Make that alignment visible in the review packet. A compact mapping is usually enough:

```text
task -> design decision -> required scenario -> code/tests
```

Explain both what the task asks the implementer to do and why it exists in the approved design. Read only the research needed to understand a cited decision or resolve a conflict; do not load every research artifact by default.

Do not implement through an unresolved design gate. If the task, design, spec, OpenSpec status, or current code disagree, stop before coding and show the exact conflict. Use the repository's declared source-of-truth rules to identify which artifact should be corrected; do not silently choose one, invent a workaround, or check off a narrower interpretation.

After implementation, mark an OpenSpec task complete only when its stated behavior and verification are complete. Record material departures in the owning OpenSpec artifact rather than leaving the plan and code inconsistent.

## Slice size

Explain and implement one coherent, reviewable task at a time. A slice should have one behavioral purpose and a testable completion condition. Do not silently continue into the next task, refactor, or milestone after completing it.

If safe inspection reveals that the proposed approach is wrong or materially incomplete, return with the evidence and a revised review packet before coding.

## After implementation

Teach the actual result rather than repeating the proposal:

- walk through the real execution path with clickable file links;
- explain the important data and control flow;
- identify any departure from the reviewed proposal and why it changed;
- report the tests and checks actually run, including anything unverified;
- state the next available slice, then pause.

Do not commit, push, merge, deploy, or begin the next slice unless the user explicitly asks.

## Bypass

If the user explicitly says “just do it,” “don’t pause,” “implement all,” or gives an equally clear instruction to skip review pauses, proceed without the pre-code approval stop. Still inspect and obey the relevant OpenSpec context, then explain the implemented code and verification afterward. A bypass skips the conversational pause; it does not bypass the design gate or permit silent divergence from the approved change.

Do not interpret urgency, a broad “start,” or approval of a design document as an implicit bypass.

## Boundaries

- This skill does not apply to explanations, read-only reviews, diagnosis without a requested fix, or tiny typo/format-only edits.
- Ask additional questions only when an answer would materially change the implementation. Otherwise make a reasonable assumption and include it in the review packet.
- Preserve the task's existing authorization and safety boundaries. Understanding a proposed change is not permission for unrelated mutations.
