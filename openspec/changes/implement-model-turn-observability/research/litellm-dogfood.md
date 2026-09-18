# LiteLLM trace inspector dogfood

Date: 2026-09-19

The local web/server composition completed a real LiteLLM turn against the configured Bedrock Claude model.
The prompt explicitly required the model to read the workspace `package.json` before answering.

Observed chain:

1. The first provider attempt received the projected conversation context and the workspace tool catalog.
2. The provider emitted a `read` tool call.
3. The engine validated and executed that call and durably recorded its result.
4. A second provider attempt received the tool interaction in its projected context.
5. The turn completed normally.

Verification:

- terminal durable record: `turn.completed`
- tool request present: yes
- terminal tool result present: yes
- provider attempts in reduced trace: 2
- reduced trace issues: 0
- trace status: `completed`

No credentials, cookies, configured headers, prompt text, raw payloads, or generated response text are copied into this note.

