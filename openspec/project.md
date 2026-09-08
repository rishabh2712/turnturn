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
- `../agentic-code`

Agents should first resolve the turnturn repo root, then check these sibling paths. If a sibling repo is missing, record that limitation in the research artifact instead of hardcoding a machine-specific absolute path.

Use these repos as design evidence. Do not copy their structure wholesale.

## Design Posture

- Codex is the strongest reference for conceptual harness layering.
- Gemini CLI is the strongest reference for TypeScript SDK and typed tool ergonomics.
- agentic-code is the strongest reference for operational loop invariants and conversation lifecycle robustness.

The intended blend is Codex-inspired boundaries, Gemini-inspired ergonomics, and agentic-code-inspired operational invariants.

## Required Design Phase

Before implementing a major harness milestone:

1. Create or update an OpenSpec change.
2. Preserve raw explorer reports in the change's `research/` folder.
3. Run a neutral challenge that questions the proposed path.
4. Write synthesis with conflicts, tradeoffs, rejected options, and open questions.
5. Update the change design with the conclusion.
6. Update `ROADMAP.md` when the milestone status changes.

## Agent Model Routing

When spawning subagents for turnturn work:

- Use `gpt-5.5` for research/explorer agents.
- Use `gpt-5.6-sol` for synthesis and reconciliation agents.
- Use `gpt-5.6-luna` for code-writing agents.

The main agent remains responsible for integrating findings into OpenSpec artifacts and the root roadmap.

## Commit Rule

Do not commit unless the user explicitly asks for a commit.
