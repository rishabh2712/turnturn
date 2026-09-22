# Tasks: Product-Grade Coding Turn

Status: **design approved 2026-09-22; implementation underway**. Follow `ROADMAP.md` M3.6 priority and `design.md` D1–D6. The historical M3.5 unchecked tasks remain in the archive; this is not a retroactive claim that they passed.

## Working conventions

- Do not edit `packages/protocol`, durable record formats, policy semantics, or provider adapters here. If a public `chat-client` API must change, stop and use the full contract-altering design gate.
- Keep `ConversationStore`/durable projection as the source of transcript truth. UI-local state is for draft text, open panels, and pending commands only.
- Keep shell-command interpretation display-only and conservative. Unknown means unknown; never use a display label for authorization.
- No credential, full provider request, or raw diagnostic frame in the default chat UI. The inspector remains opt-in.
- Use a disposable workspace for real edit/tool dogfooding. Record provider/model and observed sequence; do not claim unobserved cases passed.
- Run the web/client/server test and typecheck/build commands appropriate to every affected package after each reviewable slice. Do not commit unless Rishabh explicitly asks.
- User explicitly skipped the old acceptance-criteria review. Keep ordinary tests and observed evidence; do not manufacture an acceptance sign-off.

## 0. Review design and establish a baseline

- [x] Review D1–D6 with Rishabh before code. Approved 2026-09-22 after expanding the current/proposed component design and deferring Retry.
- [x] Trace a current prompt through `apps/web/src/App.tsx`, `packages/chat-client/src/store.ts`, `resume.ts`, and `turn-projector.ts`; ownership map recorded in `design.md`.
- [x] Run existing client/web tests and a scripted turn. Record existing failures without “fixing” assertions to conceal them.
  - Baseline 2026-09-22: `@turnturn/chat-client` 111/111 and `@turnturn/web` 89/89 pass. The existing end-to-end runner against intentionally refused `127.0.0.1:1` exited 1 as expected, emitted a terminal failed turn, 7 records, and `reduceEngineState` issues none. This verifies the failure path, not a real provider/tool turn.

## 1. Make one turn reliably controllable

- [ ] Deferred at Rishabh's request on 2026-09-22: repair the browser-token/CSP conflict. The checked-in `apps/web/index.html` uses `script-src 'self'`, while `assistant-server` injects the token as an inline script. The CSP meta tag is removed **only from ignored `apps/web/dist/index.html`** for local dogfooding; rebuilding restores the conflict and requires repeating that temporary workaround. Before shipping or relying on a fresh build, design a narrow nonce/hash bootstrap fix and verify in a real browser without weakening the default policy.
- [ ] Preserve the passing reload-approval, streaming, resume, and deduplication tests. Add failing tests only for missing behavior: selected-conversation switch with a late response, approval visible while scrolled away, two approval surfaces sharing one in-flight command state, and a real Stop action. Use existing `chat-client` reconciliation rather than reimplementing it in React.
- [x] Extract one selected-conversation controller from `App.tsx`. Keep `AppShell` limited to shell/sidebar/new-conversation concerns. The pane receives view state and commands, and never constructs its own resume pipeline.
  - 2026-09-22: `useConversationController` owns selected-conversation loading, resume cleanup, send, model switch, and approval resolution. Regression tests cover a late response after selection changes and an accepted send whose sidebar refresh fails. Web lint/typecheck/build and 91/91 tests pass; chat-client 111/111 pass. No visual behavior was intentionally changed.
- [ ] Wire Stop through the existing `turn.cancel` command, with current-state checks and pending/error handling until the terminal record arrives. Do not add Retry: no retry command or agreed retry semantics exist yet. Record that as a later design choice.
- [ ] Give pending approvals one controller operation and one command status shared by inline and persistent affordances. Preserve the currently passing reload behavior: the approval identity must come from the recovered projection, not component-local state.
- [ ] Verify affected tests and reducer issues for any record-producing test; do not alter record sequence numbers to make a test pass.

## 2. Give the turn an intentional presentation

- [ ] Refine the turn composition from `composeConversationPresentation` into a readable sequence: request, model progress/answer, grouped action/result, waiting decision, outcome. Do not expose provider-step or durable-record jargon by default.
- [ ] Keep concise tool headlines and typed detail renderers. Give edit results an unambiguous applied-state label and honest before/after comparison; do not call it a pre-apply preview.
- [ ] Add explicit empty, loading, connecting, running, awaiting approval, failed, and completed states, with no blank freeze while a turn is active.
- [ ] Keep unknown/ambiguous tool details literal and provide a path from action detail to exact input/output or diagnostic inspector.
- [ ] Add component tests for tool, edit, approval, and fallback states with keyboard-accessible controls.

## 3. Finish the chat surface

- [ ] Establish focused layout and visual tokens; make sidebar, transcript, composer, model picker, tool cards, and approval surfaces coherent on desktop and narrow windows.
- [ ] Keep composer available and visually stable while streaming; do not allow a draft to be lost on navigation or an unsuccessful send.
- [ ] Check focus after send/approval, keyboard navigation, accessible status announcements, and scroll pinning while reading earlier content.
- [ ] Run build/typecheck/lint/tests for affected packages and review the resulting UI in a browser; record visual defects as tasks rather than accepting a “tests green” proxy.

## 4. Dogfood and close out honestly

- [ ] Run one real model turn that reads a disposable repository, asks for a tool decision, executes an allowed action, and returns a final answer. Note the provider, model, date, commit, exact observed stages, and unverified branches. Do not use a real edit in a valued workspace for the first pass.
- [ ] Record any new defects in this task list and link the next safety/edit-trust OpenSpec need to M4/M6 in `ROADMAP.md`.
- [ ] Reconcile this change's spec scenarios against tests and observed behavior. Do not mark historical M3.5 tasks completed by this work.
