# turnturn Project Context

turnturn is a coding assistant startup project. The near-term product goal is a coding harness that can run agentic coding turns with strong observability, provider-neutral protocol boundaries, tool policies, durable sessions, and replayable state.

## Source of Truth

- Root roadmap: `ROADMAP.md`
- Milestone planning and implementation: `openspec/changes/<change>/`
- Accepted behavior: `openspec/specs/`
- Raw research for a design phase: `openspec/changes/<change>/research/`
- Final design for a milestone: `openspec/changes/<change>/design.md`
- Implementation tasks: `openspec/changes/<change>/tasks.md`

Do not create parallel long-form architecture docs under `docs/` unless explicitly requested. If architectural information is durable, put it in this file, the root roadmap, an OpenSpec spec, or the relevant change design.

## Reference Repositories

Reference repos are discovered relative to the turnturn repo root. In the expected local workspace, they live as sibling directories:

- `../codex`
- `../gemini-cli`
- `../claude-code`
- `../turnturn-references/ai-sdk`
- `../turnturn-references/assistant-ui`
- `../turnturn-references/tool-ui`
- `../turnturn-references/open-webui`

Agents should first resolve the turnturn repo root, then check these sibling paths. If a sibling repo is missing, record that limitation in the research artifact instead of hardcoding a machine-specific absolute path.

Research artifacts created before 2026-09-09 refer to this third reference as `agentic-code`. That is the same reference under its former name; existing `research/agentic-code.md` files are not renamed.

Use these repos as design evidence. Do not copy their structure wholesale.

The `turnturn-references` siblings are local, read-only research snapshots, not workspace packages or runtime dependencies. Research records the commit inspected so later changes can distinguish a snapshot from current upstream behavior.

## Design Posture

- Codex is the strongest reference for conceptual harness layering.
- Gemini CLI is the strongest reference for TypeScript SDK and typed tool ergonomics.
- claude-code is the strongest reference for operational loop invariants and conversation lifecycle robustness.

The intended blend is Codex-inspired boundaries, Gemini-inspired ergonomics, and claude-code-inspired operational invariants.

## Required Design Phase

**Every change has a `design.md`, and the user reviews it before implementation starts.** There is no exception. A change whose design has not been validated does not get built, however small it looks.

Every change therefore has:

1. `proposal.md` — why this change exists.
2. `design.md` — the decisions, with the reasoning and the rejected options.
3. `tasks.md` — what to do, with conventions, acceptance criteria, and gotchas inline.
4. `research/research.md` — what is being borrowed and from which reference file.
5. A `ROADMAP.md` update when milestone status changes.

**Contract-altering changes** — protocol types, durable record formats, persisted policy semantics, public package APIs — additionally need `research/neutral-challenge.md` questioning the proposed path, and `research/synthesis.md` recording conflicts, tradeoffs, rejected options, and open questions. The full ritual exists for decisions that are irreversible and have no empirical feedback available; implementation work resolves empirically instead, by running code.

Do not write separate handoff documents. Implementation instructions belong in `tasks.md`, written so another model can execute them without the authoring conversation.

## One Home Per Fact

Duplicated information is the main way this repo becomes unreadable. Assign every fact one owner and link to it:

| File | Owns |
| --- | --- |
| `ROADMAP.md` | v1 scope, milestone order, deferred lists |
| `<change>/proposal.md` | why the change exists |
| `<change>/design.md` | decisions and tradeoffs |
| `<change>/tasks.md` | the work, and how to do it |
| `openspec/specs/` | accepted behavior |

Do not restate a milestone's scope inside its proposal, or its decisions inside its tasks. When a change is complete and its output lives in code and the roadmap, delete the change rather than leaving it beside live work.

## Agent Model Routing

When spawning subagents for turnturn work:

- Use `gpt-5.5` for research/explorer agents.
- Use `gpt-5.6-sol` for synthesis and reconciliation agents.
- Use `gpt-5.6-luna` for code-writing agents.

The main agent remains responsible for integrating findings into OpenSpec artifacts and the root roadmap.

## Commit Rule

Do not commit unless the user explicitly asks for a commit.
