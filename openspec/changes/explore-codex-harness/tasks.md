# Tasks: Codex Harness Comparison

Status: research captured; discussion deferred until after `implement-parallel-tool-waves`. No implementation tasks are authorized by this change. Return to Codex's context management first, then work through the comparison questions one by one. The [research](research/research.md) is the evidence; `design.md` is the future decision log. Keep the roadmap as the sole owner of milestone priority.

## Design Gate

- [ ] Review each comparison point with Rishabh; record architecture choices and unresolved questions in `design.md` before opening implementation work from this research.

## Research and discussion

- [x] Pin the inspected Codex and Turnturn commits, check the relevant code paths, and distinguish observed mechanics from quality hypotheses.
- [ ] Decide the model-request instruction/context assembly boundary (research §1).
- [ ] Decide context budget and continuation behavior across provider wires (research §2).
- [ ] Reconcile the read-only parallel-wave design with Codex's tool scheduler (research §3).
- [ ] Decide whether managed shell sessions belong in the v1 coding workflow (research §4).
- [ ] Decide the edit operation and verification contract (research §5).
- [ ] Decide retry, user steering, and restart semantics separately (research §6).
- [ ] Decide policy and sandbox scope for greater autonomy (research §7).
- [ ] Decide when model-visible skills and cross-session memory are warranted (research §8).
- [ ] Run a same-model task comparison before claiming a quality or speed improvement from any adopted mechanism. Record the task, model, wire, both harness revisions, observed results, and failure categories.
