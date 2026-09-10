# turnturn

turnturn is a coding assistant. Development starts with a provider-neutral harness and serialized engine/client contracts.

## Toolchain

No Homebrew — this macOS user has no sudo/admin access. Node and pnpm are installed locally, and there is **no `~/.zshrc`**, so nothing is on `PATH` by default. Add it per shell:

```sh
export PATH="$HOME/.local/turnturn-node-v24.21.0/bin:$HOME/.local/turnturn-bin:$PATH"
node --version   # v24.21.0
pnpm --version   # 9.12.3
```

`python3` (3.9.6) and `curl` are available system-wide.

## Start Here

- [ROADMAP.md](ROADMAP.md) — v1 scope, milestone order, and what is deferred.
- [OpenSpec project context](openspec/project.md) — working rules, the design-review requirement, and the one-home-per-fact rule.
- [Architecture skill](.agents/skills/turnturn-architecture/SKILL.md) — where things live and what discipline applies.
- [Current change](openspec/changes/implement-sequential-agent-loop/) — Milestone 3, the sequential agent loop. Design is written and awaiting review; implementation has not started.

## Rules

- Every change has a `design.md`, reviewed before implementation starts.
- Each fact has one home. Link, do not restate.
- `packages/protocol` is frozen; changing it needs its own change with full research.
- Update the roadmap when a milestone completes.
- Do not commit unless explicitly asked.
