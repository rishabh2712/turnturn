# Proposal: Product-Grade Coding Turn

Companion to the M3.6 priority in `ROADMAP.md`. The roadmap owns ordering; this change owns the reason for the next slice. Design is draft and implementation must wait for review.

## Why

The browser can send a prompt and show a transcript, but the experience still asks the user to infer too much from protocol-shaped tool activity. An approval can interrupt the flow without a sufficiently prominent, durable action surface. The current `apps/web/src/App.tsx` also owns transport state, conversation selection, submit/resume, approval resolution, model choice, and rendering, so refining one interaction risks disturbing another. The archived M3.5 change recorded these gaps; its remaining acceptance work was waived, not completed.

The next question is whether a person can follow and control one real tool-using turn without opening the diagnostic inspector. It is a product and reliability question, not a request for another provider or a wider tool catalog.

## What changes

Build a browser interaction slice around the existing transport, durable projection, and engine contracts. Separate stateful conversation control from presentation, make pending decisions and turn controls visible in the chat, and replace protocol-like tool presentation with a cohesive, accessible chat surface. Keep the raw trace inspector available on demand.

## Boundaries

- This is a frontend/client composition change. Existing protocol types, durable records, policy decisions, provider adapter semantics, and public package APIs remain unchanged.
- A completed edit may show a truthful before/after comparison. Pre-apply diff preview is **not** provided by the current records and belongs to the later safety/edit-trust change.
- The live model run is a learning task. Record what was observed and what could not be verified; do not rewrite the waived M3.5 checklist as passed.
- No CLI, Electron packaging, new model adapter, sandbox, compaction, memory, parallel tools, MCP, subagents, or background execution.
- If implementation exposes a need to alter a public or durable contract, pause this change and open the full contract-design gate rather than inventing a client-side substitute.

## Capability

Adds a `product-grade-coding-turn` delta. The archived `coding-chat-workspace` spec remains historical and was not promoted to accepted behavior; this change defines only the next observable interaction behavior.
