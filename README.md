# turnturn

This repository is the starting point for a coding-assistant product: a web app, shared assistant core, and workspace tooling that can grow into agentic coding workflows.

## Current Machine Status

This machine has Apple Command Line Tools installed. Node.js and pnpm are installed locally under:

```sh
~/.local/turnturn-toolchain/node-current
```

Homebrew is not installed because this macOS user does not currently have sudo/admin access. To use the local toolchain in a new shell, make sure `~/.zshrc` is loaded or run:

```sh
source ~/.zshrc
```

## Project Shape

- `apps/web`: future product web app
- `packages/assistant-core`: shared assistant orchestration primitives
- `docs`: product, architecture, and operating notes
- `scripts`: local setup helpers

## First Milestones

1. Install machine prerequisites.
2. Initialize git after Command Line Tools are available.
3. Choose the first product slice: chat UI, repo indexing, terminal agent, or IDE integration.
4. Add the app framework and assistant runtime dependencies.
