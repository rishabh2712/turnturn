# Design: Product-Grade Coding Turn

Status: **approved by Rishabh on 2026-09-22**. Scope and priority live in `ROADMAP.md`; task order lives in `tasks.md`. Approval of this design does not skip the review of each implementation slice.

## The question this design answers

Can you ask turnturn to fix a failing test, follow the model's work, approve or stop it when necessary, and return after a reload without wondering what happened? **Not yet with confidence.** The engine and browser already do much of the hard work, but the browser does not assemble it into one clear, controllable coding turn.

This is not a proposal to rebuild the engine or adopt a new chat SDK. It is a proposal to make existing capabilities legible and to give browser interactions a clear owner. Read the next two sections before the decisions; they distinguish working foundations from actual gaps.

## Walk through one turn today

Suppose you send “find the failing test and fix it.” The actual path is:

1. [`App.tsx`](../../../apps/web/src/App.tsx) creates or selects a conversation, then `sendTurn` in `apps/web/src/client-actions.ts` activates its session, shows an optimistic user message, and sends `turn.submit`.
2. The server writes records to the session log and emits live events. [`resume.ts`](../../../packages/chat-client/src/resume.ts) subscribes, catches up missing records by sequence, and forwards live events to [`ConversationStore`](../../../packages/chat-client/src/store.ts).
3. The store projects those facts into conversation state. [`turn-projector.ts`](../../../packages/chat-client/src/turn-projector.ts) groups user text, assistant steps, tools, approvals, and outcome into a turn suitable for display.
4. `ConversationPane` in `App.tsx` renders the timeline with `TurnBlock`. `TurnBlock` renders the assistant's message and `ToolActionCard` details. When a tool needs a decision, it renders `ApprovalCard` inside that historical step.
5. After reload, the browser reopens the conversation, fetches its records, and can rebuild a pending approval. The existing `approval-reload.test.tsx` proves this for one pending edit approval and exact Deny scope. `app-dogfood.test.tsx` proves a prompt can produce visible streamed text. These are **working foundations**, not bugs to reimplement.

```text
CURRENT COMPONENT OWNERSHIP

App
└─ RuntimeProvider + ConversationListProvider
   └─ AppShell                         workspace/list, model catalog, store map,
      │                                 new-chat draft and send
      ├─ ConversationSidebar
      └─ ConversationPane (in App.tsx) conversation fetch + resume, snapshot,
         │                             draft + submit, model switch, approval,
         │                             busy/error state, inspector selection
         ├─ header + ModelPicker
         ├─ ConversationViewport        scrolling only
         │  └─ TurnBlock                grouped turn
         │     ├─ ToolActionCard         typed tool detail
         │     └─ ApprovalCard           inline decision + local button state
         ├─ Composer
         └─ TurnInspector               optional diagnostic view
```

The authoritative state is the **server's durable session log**. `ConversationStore` is the browser's recovered view of it. Live text is provisional and is replaced by durable content. The inspector is a separate diagnostic view of exact provider requests and traces; it should not become the ordinary chat transcript.

## Exactly where today's design is brittle

| What you encounter | Where it comes from | Why it matters |
| --- | --- | --- |
| You must find the approval within a tool step, possibly above the current scroll position. | `TurnBlock` places `ApprovalCard` only inside the step; the presentation already exposes `pendingApproval`, but the pane does not use it as a prominent action. | The engine may be correctly waiting while the UI feels frozen or hides the next action. Reload recovery works, but discoverability does not. |
| There is no Stop button during a running turn. | The projected `activeTurn` says `canStop`; protocol and engine accept `turn.cancel`, but `App.tsx` only shows a phase line and disables Send. | A running action cannot be interrupted from this UI even though the underlying command exists. |
| “Retry” has no precise meaning yet. | There is `turn.submit` and `turn.cancel`, but no `turn.retry` command. | Re-sending the same prompt would create a **new turn**, not retry the same one. Showing a Retry control without deciding that distinction would mislead the user. |
| The approval card owns its own `pending/resolving/cancelled` state. | `ApprovalCard.tsx` uses local state and an in-flight ref while `App.tsx` handles the command and durable refresh. | A second approval surface would have a second, unsynchronized button state. Card state can also outlive a stale durable fact until catch-up replaces the item. This is a coupling risk, not proof that current reload is broken. |
| Changing one interaction touches many unrelated concerns. | `App.tsx` has `AppShell`, `ConversationPane`, `Composer`, provider catalog, store lifetime, resume lifecycle, send, approval, model switch, inspector, and layout in one 459-line file. | The same `busy`, `blocked`, `submittedTurnId`, and connection status affect Send and model switching. It is hard to tell which rule owns a disabled control or a preserved draft. |
| Tool work is typed but still not a coherent turn-level story. | `ToolActionCard` has useful per-tool variants, including completed edit before/after; `TurnBlock` renders them in step order. | The user has to scan cards and status lines to infer what happened, what is still running, and what requires them. The existing edit comparison is **after execution**, not a pre-apply proposal. |

None of this says that streaming, reconnection, or approval recovery is absent. The target is to preserve those tested behaviors while making control and presentation less scattered.

## What we want you to see instead

For the same “fix the test” request, the chat should read as one turn:

```text
You: Find the failing test and fix it.

Assistant is working…
  Read 2 files · searched for the test             [details]
  Wants to run: pnpm test --filter foo

  Decision needed: Run command in /workspace       [Deny] [Allow]
  (Also visible near the composer if the turn is scrolled away.)

  Command completed: exit 1                        [output]
  Edited src/foo.ts — applied                       [before / after]

Assistant: The test now passes because…
```

The exact command and tool output remain available, but routine details start collapsed. While the model works, the composer area shows a truthful running state and **Stop**. After a reload, the pending decision comes from recovered records, not from remembered React button state. A completed edit is explicitly *applied*; this milestone does not promise a diff before application.

## Proposed component design

```text
App
└─ existing runtime/list providers
   └─ WorkspaceShell
      ├─ ConversationSidebar
      ├─ NewConversationScreen       new-chat draft + model choice
      └─ ConversationScreen          renders one selected conversation
         ├─ useConversationController(conversationId, store, transport)
         │  ├─ opens/resumes/stops subscription
         │  ├─ exposes durable-derived presentation + connection state
         │  └─ owns submit, cancel, approve/deny, model activation status
         ├─ ConversationHeader       title, model picker, connection state
         ├─ PendingActionBar         current durable pending approval; same action as inline card
         ├─ ConversationViewport     scroll pin only
         │  └─ TurnView              user text, agent work, final answer, outcome
         │     └─ ToolGroup / ToolActionCard / ApprovalCard
         ├─ Composer                 draft, send, active-turn Stop
         └─ TurnInspector            opt-in trace/debug view
```

This is an **ownership map**, not a demand to create a file for every box. `TurnBlock`, `ToolActionCard`, `ApprovalCard`, and `ConversationViewport` already exist and should be evolved. The main new unit is the selected-conversation controller; small presentational components are extracted only when they have an independent responsibility. We should not create another giant `ConversationScreen` that simply receives 20 unrelated props.

| Responsibility | Source of truth / owner | Must not own |
| --- | --- | --- |
| Records, turn outcome, approval status | Server session log; projected by `chat-client` | React component-local copies of durable facts |
| Live catch-up, cursor, deduplication | Existing `resumeConversation` and `ConversationStore` | A second React reconnect algorithm |
| Which conversation is selected | Existing `ConversationListProvider` | Tool cards or composer |
| Selected conversation's subscription and commands | New web controller | Protocol-record construction inside view components |
| Unsaved draft | Web UI state, keyed by conversation/new-chat slot; cleared only on accepted send | Durable session log, tool card |
| Turn, tool, approval layout | React components fed by the presentation model | Policy or shell-command authorization |
| Provider request/response detail | Existing `TurnInspector` | Default transcript |

### How the controller would work

This is pseudocode for the ownership boundary, not a new public package API:

```ts
const conversation = useConversationController({ conversationId, store, transport });

// Derived from store, never copied into React state:
conversation.presentation;     // turns, tool groups, current pending approval
conversation.connection;       // connected / reconnecting

// UI-only command state, reset or reconciled when durable state changes:
conversation.commandStatus;    // sending / cancelling / resolving approval / error

conversation.submit(draft, modelProfileId);
conversation.cancelActiveTurn();
conversation.resolveApproval(approvalId, "allow" | "deny");
conversation.activateModel(modelProfileId);
```

`cancelActiveTurn` must derive the correct `sessionId` and `turnId` from the current projected turn, send `turn.cancel`, then wait for a durable terminal result before saying “Stopped.” `resolveApproval` uses the approval's exact durable identity and refreshes the session. The inline card and `PendingActionBar` call this **same** operation and read the **same** command status. On conversation switch, the old resume subscription stops; its late promise must not set the newly selected conversation's UI state. The store itself can remain cached per conversation, so returning to it does not require inventing new records.

The draft is different: it is user input that has not been accepted yet. Key it by conversation (and a separate new-chat slot) in web state so switching away and back does not erase it. Do not pretend it is durable across browser restart unless a later feature explicitly persists drafts.

### One approval, end to end

```text
Engine writes approval.requested
  → resume fetches the new durable record
  → ConversationStore projection exposes pendingApproval
  → controller exposes that approval + command status
  → inline ApprovalCard and PendingActionBar show the same decision
  → user clicks Allow in either place
  → controller marks this approvalId as resolving and sends approval.resolve
  → server writes approval.resolved (or rejects a stale request)
  → controller refreshes from records
  → both surfaces disappear or show the current outcome together
```

The card must not independently decide that the approval is still pending. The server record makes that decision. The only temporary local fact is “we have sent a command and are waiting to learn its outcome.” A rejected stale command causes a refresh; it is not treated as an authorization.

### One Stop action, end to end

```text
Projection says activeTurn.canStop
  → controller finds that turn's sessionId and turnId
  → composer shows Stop, not another Send
  → user clicks Stop; controller sends turn.cancel once
  → UI says “Stopping…” while the command/record is pending
  → durable turn.aborted is received
  → UI says “Stopped”; late live deltas cannot reopen the turn
```

If the turn has already ended, the server may reject cancellation as `TURN_NOT_RUNNING`. The controller then catches up and shows the actual terminal state. It must not say “Stopped” merely because the user clicked.

### File and component boundaries

These are proposed ownership locations, not a mandate to create every file before its behavior exists:

| Location | Proposed responsibility | Deliberately excluded |
| --- | --- | --- |
| `apps/web/src/App.tsx` | Provider composition and a small shell route between new/selected conversation. | Resume algorithm, approval button state, tool rendering details. |
| `apps/web/src/features/conversation/useConversationController.ts` | Selected-conversation subscription, projected view, command methods and their transient statuses. | Durable-record construction, tool policy, CSS. |
| `apps/web/src/features/conversation/ConversationScreen.tsx` | Lay out header, pending-action affordance, viewport, composer, inspector using controller output. | Calling the transport or parsing records. |
| `apps/web/src/features/conversation/useDrafts.ts` (or equivalent small owner) | Draft text keyed by conversation and the new-chat slot; clear only after accepted submit. | Durable transcript, server persistence. |
| `apps/web/src/components/approval/ApprovalCard.tsx` | Render exact input/scope and the decision state passed from the controller. | Its own independent approval lifecycle. |
| `apps/web/src/components/approval/PendingActionBar.tsx` | Keep a blocking decision discoverable near the composer; call the same controller command. | A second command path or copy of approval state. |
| `apps/web/src/components/turn/TurnBlock.tsx` and `tool/ToolActionCard.tsx` | Turn hierarchy, readable action summary, typed expandable detail and truthful edit status. | Data fetching, policy decisions, guessed shell authorization. |
| `apps/web/src/components/viewport/ConversationViewport.tsx` | Scroll pinning and jump-to-latest only, as today. | Turn or record interpretation. |
| `packages/chat-client/src/*` | Keep current store, resume, reconciliation and presentation behavior unless a test exposes an internal defect. | A React-specific controller or duplicate UI state. |

The first message in a brand-new conversation is a special boundary: the shell must create/select the conversation before `sendTurn` has an ID. Keep that small create-and-first-submit flow in a workspace action using the existing `sendTurn` helper; later turns belong to the selected-conversation controller. Both paths use the same helper and command semantics. Do not make the new screen wait for an effect and accidentally send the first message twice.

The first tests should verify the current reload behavior still works, then target what is missing: a visible decision while scrolled away, one shared resolving state across two approval surfaces, a working Stop command, and isolation when rapidly switching conversations. They should not be described as tests that currently fail merely because the present architecture is dense.

## Interaction grammar for one coding turn

Before adding another approval surface, give each element one job. This applies the reference lessons to turnturn's existing `ConversationStore` and presentation model; it is not a new component library or a second runtime. One turn reads as **request → model activity → tool action/result → decision when blocked → answer/outcome**. Render steps in that order, but do not make every provider or durable event a separate visible message.

| Role | What the user needs first | Default surface | Expand or inspect | Source of truth |
| --- | --- | --- | --- | --- |
| Request | Their submitted words | User message, once per turn | None required | Durable accepted input; optimistic text only before catch-up |
| Activity | What is happening *now* | Quiet, concise running status | Tool group/progress when useful | Live state is provisional; durable projection supersedes it |
| Action/result | What the agent did and whether it worked | Known-tool verb, target, and outcome in a grouped card | Exact arguments, output, paths, and errors; neutral raw fallback for unknown tools | Projected tool request/result |
| Decision | What will happen if they Allow or Deny | Full inline approval at its tool; compact persistent reminder near the composer while it blocks progress | Exact command/input, working directory, and available scope **before** either choice | Projected pending approval and its stable `approvalId` |
| Receipt | What choice was recorded | Read-only decision label at the original action | Preserve the inspected action context | Durable `approval.resolved` or terminal cancellation, never a click alone |
| Answer/outcome | What the assistant concluded; whether the turn ended | Final answer and unobtrusive terminal state | Opt-in trace inspector | Durable assistant message and terminal turn record |

The reference roles are **information** (read/search/edit result), **state** (generating/running/reconnecting), and **decision** (approval). A card may contain more than one, but its primary role should be obvious. Routine actions start collapsed with a useful headline; a blocking decision stays visible and inspectable. Avoid repeating the same full approval card above the composer: the persistent surface identifies the pending action and offers a route to its exact details. If it also exposes Allow/Deny, those controls use the same controller operation and command status as the inline card.

Decision labels describe the *decision*, not the tool result: “Allowed” means the approval was durably recorded, not that a write or command succeeded. “Denied” and “No longer pending” likewise come from the projection. While a command is in flight, both surfaces say “Resolving…” and disable duplicate choices; after a stale rejection, refresh records before showing the outcome. The existing `ToolCallView.approval` supplies a receipt after the pending-only `ApprovalRequestItem` disappears. `ToolActionPresentation` currently carries only pending approval, so the web controller passes a read-only receipt lookup from the projected tool activity to the turn view; it does not invent another lifecycle or change the public package API. A completed edit must still be labelled **applied**, never a preview.

For every surface, use the engine's stable turn/tool/approval IDs, never list indexes or render-time IDs. Use known schema fields for summaries; if the command purpose or consequence is uncertain, say what is known literally and expose the exact input. The chat surface must remain usable at narrow width, with keyboard-accessible decisions, visible focus, and no forced scroll jump when new content arrives. These are implementation constraints to verify in component and browser tests, not a reason to import the reference components wholesale.

The decisions below define the limits of this design. The [research](research/research.md) records the local reference evidence.

## D1 — One controller owns one selected conversation

Extract a `useConversationController`-style hook in the web app. It owns subscription to one `ConversationStore`, `resumeConversation` lifetime, submit, approval resolution, model activation, and turn-control pending/error states. On selected-conversation change it tears down the old subscription, does not transfer pending UI actions, and starts the new session from its own durable cursor. The server/session log remains the canonical state; local hook state only reports in-flight UI commands.

The controller returns a narrow view and commands to the pane. `AppShell` keeps sidebar and new-conversation creation; the conversation pane stops creating its own transport/resume machinery. We avoid a new generic framework or duplicating `ConversationStore` in React state.

## D2 — Durable projection defines the transcript; live data is provisional

`composeConversationPresentation` remains the semantic boundary. The UI renders turn, assistant text, action, approval, and outcome concepts; it does not map one component per durable record. The client store's sequence/cursor behavior owns reconnect and deduplication. Pending approvals are derived from the recovered projection on reload, not remembered only in a button component. A live delta may make the interface feel immediate but never overrides a terminal durable fact.

Do not change `packages/chat-client` public API unless a separate contract review justifies it. An internal correction with tests is permissible if a real reconnect defect is found and the public surface stays stable.

## D3 — A decision is visible where it blocks progress

A pending approval appears within its tool/action group and in a compact, persistent pending-action affordance that remains discoverable while the user scrolls. Both controls call the same controller operation using the same approval identity. The exact command, working directory, and scope remain inspectable before Allow. Deny has equal prominence; any stale approval response refreshes from durable state. The UI never treats optimistic local state as an approval grant.

Stop is wired through the existing `turn.cancel` command and shown only for a genuinely active turn. A cancelled/stale action is displayed as such, without pretending the turn was resumed. There is no retry command today. **Retry is deferred** until we choose whether it means “submit the same text as a new turn,” “resume the interrupted turn,” or “replay a failed provider step.” Do not add an inert or misleading Retry button to satisfy a mockup.

## D4 — Product UI and debug UI have different jobs

The default transcript shows user intent, model answer, concise tool activity, current wait state, and outcome. Tool cards expose typed details progressively; unknown inputs and ambiguous shell commands use literal, neutral labels. File edits show completed before/after text and a clear **applied** status, not a misleading “proposed” diff. Raw request/response, provider frames, and protocol records stay in the developer inspector.

Display classification must be pure and display-only. It must never feed policy, execution, approval scope, or provider history. The exact command and raw tool data remain reachable from the action detail.

## D5 — Visual system is subordinate to interaction correctness

Create a small, coherent set of layout, typography, spacing, color, focus, and state tokens in `apps/web/src/styles.css` (split CSS by component only where ownership becomes clearer). The shell has a conversation sidebar, a focused transcript column, and a stable composer. Within a turn, the user message and final assistant answer carry visual weight; model work is a quieter grouped activity strip; an approval interrupts that strip with explicit Allow/Deny controls. Running, reconnecting, awaiting-decision, failed, and completed states must be visually distinct without relying on color alone. Preserve scroll position when reading history, keyboard operation, focus management for approval decisions, and readable narrow-window layout. Avoid copying a reference project's component library wholesale.

## D6 — Evidence has provenance

Tests cover controller transitions, refresh/reconnect, duplicate live/durable delivery, stale approval, and action rendering. A real model/tool run should be recorded separately with provider, model, commit, date, observed steps, and gaps. It is evidence, not a claim that all browsers/providers have passed. The previous M3.5 waiver is not inherited as a waiver of correctness for this change.

## Rejected paths

- **Rebuild around Vercel AI SDK runtime.** Its transport/message patterns are useful, but turnturn already has durable records and a defined command/event protocol; replacing them adds a second source of truth.
- **Copy assistant-ui or Open WebUI component trees.** Their composition patterns are useful, but their runtime contracts differ and Open WebUI's large top-level chat module illustrates the coupling we want to remove.
- **Render all protocol events in the transcript.** This recasts the diagnostic inspector as the product UI and makes routine actions hard to scan.
- **Claim a pre-apply diff from post-apply records.** It would misstate safety. That requires an engine/policy design in M4/M6.
