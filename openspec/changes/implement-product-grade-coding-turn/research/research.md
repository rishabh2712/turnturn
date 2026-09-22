# Research: Product-Grade Coding Turn

Local reference snapshots are sibling clones under `../turnturn-references/`, not package dependencies. Inspected 2026-09-22. Their design patterns are evidence, not contracts for turnturn. If a clone is missing on another machine, use the upstream repository at the recorded commit rather than assuming these local paths exist.

| Reference | Snapshot | Specific evidence | Borrow | Do not borrow |
| --- | --- | --- | --- | --- |
| [Vercel AI SDK](https://github.com/vercel/ai) | `4e8c387` | `../turnturn-references/ai-sdk/packages/react/src/use-chat.ts`; `packages/ai/src/ui/chat-transport.ts`; `ui-messages.ts` | Thin React subscription around a headless chat owner; typed message parts and explicit send/reconnect transport responsibilities. | Its UI-message state as a replacement for turnturn's durable log or engine commands. |
| [assistant-ui](https://github.com/assistant-ui/assistant-ui) | `16bd899` | `../turnturn-references/assistant-ui/packages/ui/src/components/react/assistant-ui/elements/thread.aui.tsx`; `tool-group.aui.tsx`; `packages/core/src/runtimes/tool-invocations/ToolInvocationTracker.ts` | Composable thread slots, collapsed tool groups with detailed expansion, and a headless tool lifecycle separate from presentation. | Its entire runtime/component hierarchy or tool lifecycle as a second source of truth. |
| [Tool UI](https://github.com/assistant-ui/tool-ui) | `49a8702` | `../turnturn-references/tool-ui/apps/www/app/docs/overview/content.mdx`; `components/tool-ui/approval-card/approval-card.tsx`; `components/tool-ui/code-diff/code-diff.tsx` | Purpose-built tool result/approval displays; schema-aware renderer fallback; durable receipt idea after a choice. | A generic JSON viewer as the primary surface, or a visual diff that implies an edit is still pending after it was applied. |
| [Open WebUI](https://github.com/open-webui/open-webui) | `8bd8b4f` | `../turnturn-references/open-webui/src/lib/components/chat/Chat.svelte`; `MessageInput.svelte`; specialized message subcomponents | Study mature chat states and feature discoverability. | Large top-level chat component ownership: `Chat.svelte` in this snapshot is about 4,684 lines and mixes many app concerns. |

## Local evidence and resulting choice

`apps/web/src/App.tsx` currently mixes shell, selected conversation, transport/resume, submit, approval, model activation, and composer state. `packages/chat-client/src/store.ts`, `resume.ts`, and `turn-projector.ts` already provide the headless data path. The smallest architectural move is therefore a web controller over those existing client primitives, not adopting another runtime.

`apps/web/src/components/tool/ToolActionCard.tsx` already has semantic detail variants. The next work is to improve the relationship between those details, the running turn, and the pending decision; replacing the renderer wholesale would discard existing typed behavior. In particular, a completed edit currently shows old/new text. That is useful evidence of an applied action, not a pre-application safety preview.

## Reference lesson → proposed change

| Lesson | Concrete turnturn change |
| --- | --- |
| Vercel AI SDK keeps the React hook thin over a separate chat/transport owner. | Extract a selected-conversation controller from `apps/web/src/App.tsx` that subscribes to the existing `ConversationStore` and owns commands. Do not import the SDK or replace the durable log. |
| assistant-ui composes a thread from message, tool-group, fallback, and composer pieces. | Keep `TurnBlock`, `ToolActionCard`, `ConversationViewport`, and `Composer` focused; add a discoverable pending-action surface and move command state out of the cards. Do not copy its runtime or component tree wholesale. |
| Tool UI renders known tool outputs intentionally and preserves the result of a choice. | Retain typed tool details, improve action summaries, and show a durable approval outcome. Unknown data remains a neutral fallback. Our edit comparison must be labelled *applied*, not proposed. |
| Open WebUI has rich interaction states but a very large chat root. | Borrow the attention to loading/running/composer states while preventing `App.tsx` from becoming an even larger coordinator. |

## Resolved limits and one remaining question

- `packages/protocol/src/index.ts` contains `turn.cancel`, and the engine handles it; the browser lacks its control. No `turn.retry` command exists. Retrying is deferred rather than disguised as resubmission.
- The current `ConversationPresentation` exposes `pendingApproval`, and `approval-reload.test.tsx` proves its identity can be recovered after reload. A persistent pending-action affordance can reuse it; do not add a server object just for display.
- `ToolActionCard.tsx` already has completed edit old/new text. That supports an **applied** comparison only, not a pre-apply diff. The latter belongs to M4/M6.
- Remaining design choice: should a later Retry mean a new turn with the same input, resumption of an interrupted turn, or provider-step retry? It should be answered in a separate contract/interaction change before a Retry button appears.
