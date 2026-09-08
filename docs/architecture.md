# Architecture Notes

## Suggested Monorepo

The initial architecture should separate product surface from assistant logic:

- `apps/web`: user interface, auth, task history, and project views.
- `packages/assistant-core`: task state, tool interfaces, planning loop, and result summaries.
- `packages/workspace-tools`: filesystem, shell, git, and test-runner adapters.
- `packages/model-gateway`: provider abstraction, request logging, retry policy, and eval hooks.

Only `apps/web` should know about the web framework. Assistant packages should stay framework-agnostic so they can later power CLI, desktop, IDE, and cloud workers.

## Early Technical Decisions

- Use TypeScript across the app and shared packages.
- Keep tool execution behind narrow interfaces.
- Store task events as append-only records.
- Make every assistant action auditable.
- Add eval fixtures as soon as the first workflow exists.

## Open Questions

- Will the first product run locally, in the cloud, or hybrid?
- Which repositories and languages must the MVP support first?
- Is the main interface web, CLI, IDE extension, or desktop?
- What permissions model should apply to file edits and shell commands?

