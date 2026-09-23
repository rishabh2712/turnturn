# Design: Codex Harness Comparison

Status: **discussion deferred until after parallel tools; architecture undecided**. Read [the research](research/research.md) before making a design choice. Rishabh wants to explore Codex's context management in more depth after the parallel-tools work, then review these points one by one. This document will record decisions after that discussion. Nothing here changes the design gate for `implement-parallel-tool-waves` or authorizes production code.

## Question to answer

Which harness behaviors account for observable differences on the same coding task, and which should Turnturn adopt through its existing engine, context, tool, policy, provider, and durable-log boundaries?

The current research establishes mechanisms in source code. It does not establish how much of Codex's task success comes from its harness versus model choice, model-specific API behavior, prompting, or task selection. A controlled comparison is required for a causal claim.

## Discussion order

1. What instructions and repository context enter each model request?
2. How is the model-visible history bounded and continued?
3. When may tool calls overlap, and how are calls/results ordered?
4. How does a long-running command remain usable to the model?
5. How are edits represented, applied, and verified?
6. What happens when a provider request fails or the user changes direction mid-turn?
7. Which policies allow supervised and unattended execution?
8. When do skills and cross-session memory add value, and how are they selected?

For each point, decide whether to borrow the mechanism, adapt it, or defer it; name its owner, observable behavior, required evidence, and any contract change. Record decisions here only after discussion. `tasks.md` tracks which questions have been settled. The [parallel-tools design](../implement-parallel-tool-waves/design.md) remains its own narrower decision.
