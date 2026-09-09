# turnturn

turnturn is a coding assistant. Development starts with a provider-neutral harness and serialized engine/client contracts.

## Current Machine Status

This machine has Apple Command Line Tools installed. Node.js and pnpm are installed locally under:

```sh
~/.local/turnturn-toolchain/node-current
```

Homebrew is not installed because this macOS user does not currently have sudo/admin access. To use the local toolchain in a new shell, make sure `~/.zshrc` is loaded or run:

```sh
source ~/.zshrc
```

## Start Here

- [ROADMAP.md](ROADMAP.md): milestone order and completion criteria.
- [OpenSpec project context](openspec/project.md): boundaries, reference discovery, and working rules.
- [Architecture skill](.agents/skills/turnturn-architecture/SKILL.md): research, challenge, synthesis, and implementation discipline.
- [Protocol and event log tasks](openspec/changes/design-protocol-event-log/tasks.md): current implementation work; design and raw research live in the same change.

Update the roadmap when a milestone completes. Do not commit unless explicitly asked.
