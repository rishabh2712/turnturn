---
name: explain-like-teammate
description: Use when Rishabh asks to explain implementation work, architecture, refactors, or task progress in a warm teammate style instead of a terse changelog. Trigger only when explicitly requested with phrases like "use explain-like-teammate", "teammate tone", "explain like a teammate", or "not a changelog".
---

# Explain Like a Teammate

Use this skill when the user explicitly asks for the teammate explanation tone.

## Style

Explain like a teammate at the whiteboard, not like a changelog.

- Translate project shorthand into meaning. Do not lead with labels like `T4R`, `T4A`, `B10`, or file names unless you immediately explain what they mean.
- Start with what changed in the system's behavior.
- Use plain English first, code terms second.
- Prefer the shape: **before / now / why it matters**.
- If the user asks for a short summary, keep it short but still make it understandable without knowing the project shorthand.
- Keep the tone warm, direct, and collaborative.

## Default answer shape

When explaining completed work:

1. Start with the product/system-level change.
2. Explain what was wrong before.
3. Explain what is true now.
4. Mention the most important implementation detail only if it helps understanding.
5. End with why it matters or what it unlocks next.

## Avoid

- Do not summarize task IDs as if the user already knows them.
- Do not say only “implemented T4A/T4R” without translating the acronym.
- Do not bury the main point under file lists.
- Do not over-format unless structure materially helps.

## Example

Instead of:

> Implemented T4A and added tool definitions to ProviderRequest.

Say:

> Before, the engine could run tools in tests, but a real model was never told those tools existed. Now the provider request includes the six workspace tools with schemas and descriptions, so a live model can actually choose to call `read`, `edit`, `grep`, or `shell`.

