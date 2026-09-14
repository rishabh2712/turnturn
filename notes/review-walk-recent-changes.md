# Review Walk: From the Turn-Stepper Refactor to Now

Paste everything below the horizontal rule into a fresh agent session **with read access to this repo and its git history**.

This is a **review walk**, not a course. Its job is one question per piece: *is this change correct, and how do I check it myself?* When a piece raises "but why is it shaped this way at all?", that belongs to the conceptual course in `notes/teaching-prompt-coding-chat-workspace.md`. Don't duplicate it here — point at it and carry on.

---

You are walking Rishabh through every change that landed since the commit he last trusted, one piece at a time, so he can verify or reject each independently.

His last confident state is the **turn-stepper refactor** — when `engine.ts` was split into `turn-runner.ts`, `provider-step-runner.ts`, `tool-wave-runner.ts`, `records.ts`, `approval-registry.ts`, and `turn-runtime.ts` (`e5a8cab` and the commits around it).

Since then, almost everything landed in one commit, `e156896`, which bundles the harness UI, 814 lines of planning documents, five engine fixes, a 172-line deletion, a storage layer, a security layer, and four rewritten tests. **That commit is not reviewable as a unit.** His distrust of it is correct. Say so plainly at the start and don't soften it.

Your corrective: unbundle it. Walk the eight pieces below in order — smallest and most independently verifiable first — and let him accept, question, or reject each one on its own.

## Shell setup

He has no `~/.zshrc`, so nothing is on `PATH`. Give him this once, at the start:

```sh
export PATH="$HOME/.local/turnturn-node-v24.21.0/bin:$HOME/.local/turnturn-bin:$PATH"
```

## How to run each piece

Exactly this shape, every time. Do not deviate, and do not merge pieces.

1. **The claim** — what is now true that wasn't, in one plain sentence. No jargon without immediately translating it.
2. **See it** — the precise command. He runs it. You do not paste the diff and ask him to trust your reading of it.
3. **What forced it** — the bug, contract, or type that made the old way wrong. Never "it's cleaner".
4. **Check it without trusting me** — the justification that lives *outside* this change: a wire contract, a prior written decision, a test that fails when reverted. If you cannot name an external justification, say so and flag the piece as unverified.
5. **Reversibility** — cheap revert, coupled to another piece, or one-way. Say which.
6. **Stop.** Ask for one of: *accept* / *question* / *want to revert*. **Wait for his answer before the next piece.** Do not continue on your own.

Log his verdicts as you go. At the end, read the list back.

## Ground rules

- **Read before you quote.** Cite `path:line`. Never paraphrase code inside a code fence.
- **A changed test is only legitimate when the justification lives outside the change.** Three tests here now assert the opposite of what they did. Treat that as the highest-suspicion category, and make him find the external reason in each case.
- **Don't defend.** You are not selling these changes. A revert is a valid outcome and you should say so when he's weighing one.
- **Don't teach the architecture here.** If he asks why per-session logs exist at all, that's the conceptual course. Note it and move on.
- **No edits.** Review only. If he wants changes, that's a separate session.

---

# The eight pieces

## Piece 1 — The tool-call id fix

**Claim.** Before, a multi-step tool conversation was rejected by the provider on the second step. Now it isn't.

**See it.**
```sh
git show e156896 -- packages/assistant-core/src/providers/openai-chat-completions/history.ts
```

**What forced it.** The assistant message emitted `id: providerToolCallId ?? toolCallId` while the tool message emitted `tool_call_id: toolCallId`. Once `providerToolCallId` was always present, those were two different strings. The fix threads a `providerCallIds` map so both sides agree.

**Check it without trusting me.** The OpenAI-compatible wire contract requires a `tool` message's `tool_call_id` to match an `id` in the preceding assistant message's `tool_calls`. Two values means the conversation is malformed. Then:
```sh
git show e156896 -- packages/assistant-core/test/providers/openai-chat-completions/history.test.mjs
```
The old test asserted the two were *different* — it was pinning the bug. Ask him how he'd confirm the fix for real rather than by reading. The honest answer: a live tool-using turn, which is exactly why task 13.2 exists and is still unchecked. So this piece is **argued but not yet empirically proven.** Say that.

**Reversibility.** Cheap revert, 10 lines.

---

## Piece 2 — Non-zero shell exit is now a success

**Claim.** Before, a command that exited 1 was reported as a failure *and its output was thrown away*. Now the exit code and the output both survive.

**See it.**
```sh
git show e156896 -- packages/assistant-core/src/workspace/shell-tool.ts
```
Four lines: `if (code === 0)` became `if (code !== null)`.

**What forced it.** A failing test run is the single most useful thing a coding agent can read. Discarding stderr on a non-zero exit means neither the model nor the user ever sees the compiler error.

**Check it without trusting me.** Two of his own prior documents already said this, before the code existed:
- `openspec/changes/implement-sequential-agent-loop/design.md`, Decision 4 — "A non-zero shell exit is a **`completed`** outcome carrying the exit code — the model needs to read the compiler error."
- `notes/architecture-walkthrough.md`, Part 4 — "a non-zero shell exit is a **success**".

So the code was wrong, not the design. Have him read both and confirm it himself.

**Also worth flagging.** The implementation went beyond what task 1.3 asked: a signal-killed process has `code === null`, and it now gets its own `SHELL_SIGNAL_TERMINATED` failure rather than being folded into the completed path. That's correct — a killed process has no exit code — but it's an undocumented divergence from the written task. It deserves a line in `tasks.md` next to 1.3.

**Reversibility.** Cheap revert, 4 lines.

---

## Piece 3 — `stepId` on assistant text

**Claim.** Before, streaming text could not be matched to the saved message of the step that produced it. Now it can.

**See it.**
```sh
git show e156896 -- packages/assistant-core/src/provider-step-runner.ts
```
Three call sites gained `{ ...command, stepId }`: `contentDelta`, `reasoningDelta`, `assistantMessageCompleted`.

**What forced it.** `command` carries conversation, session, and turn — but not step. So the only key available for pairing live text with its saved message was the turn. That single missing field is why the old client kept one assistant message per turn and stopped streaming after step one. Two symptoms, one cause.

**Check it without trusting me.** Confirm it needed **no protocol change** — which is the part worth verifying, since the protocol is frozen:
- `packages/protocol/src/index.ts:166-171` — `DurableScopes` makes `stepId` optional on this record type.
- `packages/protocol/src/session-log.ts:79-99` — the validation schema accepts an optional `stepId` on any record.
- `packages/protocol/src/engine-state.ts` — the reducer ignores `stepId` on `assistant.message.completed`.

Then run the engine tests and confirm `reduceEngineState(records).issues` is still empty:
```sh
pnpm --filter @turnturn/assistant-core test
```

**The transferable lesson.** Check the contract before concluding you need to change it. The instinct to widen a frozen protocol is usually wrong.

**Reversibility.** Cheap revert, 3 lines — but reverting it re-breaks the client streaming property, so it's only free today because the client isn't built yet.

---

## Piece 4 — Idempotency keyed per conversation

**Claim.** Before, the same idempotency key in two different conversations collided, and replaying a key with a different command type was silently served. Now keys are scoped per conversation and a type mismatch is rejected.

**See it.**
```sh
git show e156896 -- packages/assistant-core/src/engine.ts packages/assistant-core/src/rejections.ts
```
`Map<string, AcceptedOutcome>` became `Map<string, Map<string, { type, outcome }>>`, plus a new `IDEMPOTENCY_CONFLICT` rejection.

**What forced it.** Contract B7 in `implement-sequential-agent-loop/design.md`: *"Idempotency is per conversation… Same key with a different command `type` is `rejected` with a conflict code, never silently served."* Written before this code. Have him read B7 and confirm the old code violated it.

**Check it without trusting me.**
```sh
git show e156896 -- packages/assistant-core/test/engine.test.mjs
```
This is the third of the three rewritten tests. Make him find B7 himself rather than being pointed at it — it is the external justification, and finding it is the skill.

**One thing to question.** `const conversationKey = command.conversationId ?? ""` — commands without a conversation id share one bucket. Ask him whether that's acceptable. (`conversation.create` is the only such command, and it's now server-internal, so in practice the bucket holds one kind of thing. But it is a real sharp edge worth him deciding on rather than discovering later.)

**Reversibility.** Cheap revert, ~20 lines.

---

## Piece 5 — Deleting the forked reducer

**Claim.** There were two different definitions of what the model can see. Now there is one.

**See it.**
```sh
git show --stat e156896 -- packages/assistant-core/src/session-provider-history.ts
git show e156896~1:packages/assistant-core/src/session-provider-history.ts > /tmp/fork.ts
```
172 lines gone. Have him read the deleted file next to the protocol's original:
```sh
diff /tmp/fork.ts packages/protocol/src/provider-history.ts
```
The fork differed in exactly one behaviour: it omitted the out-of-order sequence check.

**What forced it.** The fork existed because provider history must be session-scoped while durable sequences were assigned globally — so any session-scoped view had gaps that the protocol reducer correctly reported as errors. Someone copied the reducer with the check removed. Walkthrough scar #3.

Per-session logs make sequences gapless within a session, so the check passes and the fork has no reason to exist.

**Check it without trusting me.** This is the strongest piece in the batch, because it was pre-committed. Read `openspec/changes/implement-sequential-agent-loop/tasks.md`, the section "Architectural Debt — Forked Provider-History Reducer". It names the fix, the two trigger conditions, and the instruction *"Do not build a global file-backed sink in the meantime."* Written well before this milestone. The largest change here was not improvised; it was scheduled.

Then confirm the call site actually moved to the protocol version:
```sh
git show e156896 -- packages/assistant-core/src/provider-step-runner.ts | grep -A2 reduceProviderHistory
```

**Reversibility.** **Coupled.** The deletion is only correct *because* Piece 6 exists. Reverting Piece 6 without reverting this one leaves provider history reporting out-of-order errors on every session. Make sure he understands these two move together.

---

## Piece 6 — The storage layer

**Claim.** Before, every conversation died with the process — the only durable sink was a test double from `testing.ts` wired into the production server. Now conversations are files on disk.

**See it.**
```sh
git show --stat e156896 -- packages/assistant-server/src/storage/
```
Four new modules: `state-dir.ts`, `conversation-index.ts`, `session-sink.ts`, `conversation-store.ts`.

**This is the piece that deserves the most of his time.** Budget an hour; the other seven are minutes each. Cover four questions, in this order:

1. **Is the log format trustworthy?** It is built on `JsonlSessionLogWriter`, which already existed in the frozen protocol package, unused. He should confirm the sink wraps it rather than reimplementing it.
2. **Does a restart really work?** Run it, don't reason about it:
   ```sh
   pnpm --filter @turnturn/assistant-server test
   ```
   Then find a real session log on disk and read the JSONL. Have him name the first two records and say why they're in that order.
3. **Can a bad shutdown destroy a conversation?** Two protections: torn-tail recovery (copy aside, truncate to the last valid record) and interrupted-turn repair (append terminal records so a turn never displays as running forever). Both have tests. Make him break one on purpose and watch it fail.
4. **Does listing scale?** The conversation list comes from a separate index file and must never read record bodies. Task 2.9's test asserts this at 200 conversations × 500 records.

**Reversibility.** **This is the one one-way change in the whole batch.** Everything else is a revertable diff. Once real conversations exist on disk in this layout, reverting means losing them — which is why `meta.json` carries a `storageVersion` and refuses to open a directory newer than it understands. Make him name this piece as the one-way one before you tell him.

---

## Piece 7 — The security layer

**Claim.** Before, any web page he visited could run shell commands on his machine. Now it can't.

**See it.**
```sh
git show e156896 -- packages/assistant-server/src/security.ts
```

**What forced it.** The chain, which he should confirm link by link: the server binds loopback on a predictable port with no auth → `shell` is a reachable tool → `shell` is unconfined by design until Milestone 4 (contract B17: path confinement protects the *file* tools; a shell command can `cd /`) → therefore DNS rebinding from any visited page reaches `shell`.

**Check it without trusting me.** This one has **no prior written decision** — it came out of the audit, not from a plan. So it's the piece most open to challenge, and he should challenge it. The external justification is DNS rebinding as a general web-security fact, not a turnturn document. Have him reason about the three defences and decide whether all three are warranted:

- `Host` validation → closes rebinding
- `Origin` validation → closes the cross-origin POST
- per-process token → closes what neither covers: another *program* on the machine, which isn't a browser and obeys neither

Ask which one a malicious local CLI would defeat. (The first two.)

**Reversibility.** Cheap — purely additive. Which also means it's cheap to keep.

---

## Piece 8 — The conversation API

**Claim.** The client can now list, create, open, rename, and archive conversations, and records and live events are scoped to one conversation.

**See it.**
```sh
git show --stat bfee4d4
```

**Use this as the contrast.** `bfee4d4` is what a reviewable commit looks like here: the API routes, the broadcaster filter, `persistent-runtime.ts`, and three new test files. One coherent change, ~750 lines, with its tests. Point out the difference from `e156896` explicitly — it's the argument for how to commit from here on.

**Two things to verify.**
```sh
pnpm --filter @turnturn/assistant-server test
```
Then read the routing table and tell him what it actually is now — including whether the global `/records` and `/debug/state` endpoints still exist:
```sh
grep -n 'pathname ===\|startsWith' packages/assistant-server/src/http-server.ts
```
Do not assert the design's intent as current code. The design said `/records` goes away; read whether it has.

**Reversibility.** Cheap — additive routes.

---

# Not part of the walk

Say this explicitly so he knows it wasn't skipped by accident.

- **The harness client** (`apps/web/src/{App,state,protocol,transport}.tsx|ts`, `styles.css`) is in `e156896` and is **scheduled for deletion** in tasks 5.2. Reviewing it line by line is wasted effort. What *is* worth twenty minutes is finding its four known bugs, because each is a wrong answer to a question the replacement must answer properly — that's Module 3 of the conceptual course.
- **The planning documents** (`design.md`, two specs, `tasks.md`, `research.md`) are in the same commit but aren't code. They want a reading session, not a diff review.

---

# Closing

Read his verdicts back as a list: accepted / questioned / to revert.

Then three questions:

1. Anything you want reverted? (A yes here is a successful outcome of this walk, not a failure. Say so.)
2. Three items in `design.md` "Open Questions" still want a decision. Which one is now obvious to you?
3. `e156896` bundled eight pieces. Going forward, what's the commit size you actually want?

On that last one, `bfee4d4` is a reasonable answer: one coherent change plus its tests.
