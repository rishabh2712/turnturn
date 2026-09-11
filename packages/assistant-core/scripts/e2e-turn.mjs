#!/usr/bin/env node
// End-to-end runner spike. See tasks.md, "T4E — End-to-End Runner Spike".
//
// Composes the real provider adapter, real workspace tools, a policy that asks
// before running shell commands, and the real engine loop, then runs one turn
// against a real repository. This is the first time those four run in the same
// process; every test until now exercised them in isolation.
//
// Deliberately uses MemoryDurableSink. Do not add a file-backed sink here --
// that decision belongs with the session-scoped durable log work, and making it
// under spike pressure is how the global version gets built by accident.
//
//   TURNTURN_BASE_URL=... TURNTURN_API_KEY=... TURNTURN_MODEL=... \
//     node scripts/e2e-turn.mjs "make the failing test pass" --workspace ../some-repo
//
// For local Ollama-compatible /v1/chat/completions:
//   TURNTURN_PROVIDER=ollama TURNTURN_MODEL=llama3.2 \
//     node scripts/e2e-turn.mjs "read README.md" --workspace ../some-repo

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { argv, env, exit, stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  ApprovalDecisions,
  CommandTypes,
  formatApprovalId,
  formatCommandId,
  formatConversationId,
  formatEventId,
  formatRecordId,
  formatSessionId,
  formatStepId,
  formatToolCallId,
  formatTurnId,
  LiveEventTypes,
  SCHEMA_VERSION,
} from "@turnturn/protocol";
import {
  createAssistantEngine,
  createWorkspaceToolExecutor,
  MemoryDurableSink,
  OpenAIChatCompletionsAdapter,
  ollamaChatCompletions,
} from "../dist/index.js";
import { buildChatCompletionsRequestBody } from "../dist/providers/openai-chat-completions/request.js";

// ---- input ----

const args = argv.slice(2);
const workspaceFlag = args.indexOf("--workspace");
const inspectProvider = args.includes("--inspect-provider");
const workspace = workspaceFlag === -1 ? process.cwd() : resolve(args[workspaceFlag + 1] ?? ".");
const prompt = args
  .filter((arg, index) => arg !== "--inspect-provider" && index !== workspaceFlag && index !== workspaceFlag + 1)
  .join(" ")
  .trim();

const baseUrl = env.TURNTURN_BASE_URL;
const apiKey = env.TURNTURN_API_KEY;
const model = env.TURNTURN_MODEL;
const providerName = env.TURNTURN_PROVIDER ?? "openai-chat-completions";

const missing = [
  ["TURNTURN_MODEL", model],
  ...(providerName === "ollama"
    ? []
    : [
        ["TURNTURN_BASE_URL", baseUrl],
        ["TURNTURN_API_KEY", apiKey],
      ]),
]
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (!prompt || missing.length > 0 || !["openai-chat-completions", "ollama"].includes(providerName)) {
  stdout.write(`usage: node scripts/e2e-turn.mjs "<prompt>" [--workspace <path>] [--inspect-provider]\n`);
  stdout.write(`providers: TURNTURN_PROVIDER=openai-chat-completions|ollama  (default: openai-chat-completions)\n`);
  if (missing.length > 0) stdout.write(`missing env: ${missing.join(", ")}\n`);
  if (!["openai-chat-completions", "ollama"].includes(providerName)) {
    stdout.write(`unknown provider: ${providerName}\n`);
  }
  exit(2);
}

// ---- infrastructure ports ----

const ids = {
  conversationId: () => formatConversationId(randomUUID()),
  sessionId: () => formatSessionId(randomUUID()),
  turnId: () => formatTurnId(randomUUID()),
  stepId: () => formatStepId(randomUUID()),
  toolCallId: () => formatToolCallId(randomUUID()),
  approvalId: () => formatApprovalId(randomUUID()),
  commandId: () => formatCommandId(randomUUID()),
  recordId: () => formatRecordId(randomUUID()),
  eventId: () => formatEventId(randomUUID()),
};

const clock = { now: () => new Date().toISOString() };
const durable = new MemoryDurableSink();

const command = (type, scope, payload) => ({
  schemaVersion: SCHEMA_VERSION,
  commandId: ids.commandId(),
  type,
  createdAt: clock.now(),
  ...scope,
  payload,
});

// ---- policy: B17 defaults ----
// shell asks every time and is NOT confined -- a command can cd out of the
// workspace. Path confinement protects the file tools only. Milestone 4 adds the
// sandbox; until then approval is the only gate.

const ASK_ALWAYS = new Set(["shell"]);

const policy = {
  async decide(request) {
    if (ASK_ALWAYS.has(request.name)) {
      return { kind: "ask", reason: describe(request) };
    }
    return { kind: "allow" };
  },
};

function describe(request) {
  const input = request.input;
  if (input && typeof input === "object" && typeof input.command === "string") return input.command;
  return `${request.name} ${JSON.stringify(input ?? null)}`;
}

// ---- live sink: timeline + approval prompt ----

let streaming = false;
const pendingApprovals = [];

function line(text) {
  if (streaming) {
    stdout.write("\n");
    streaming = false;
  }
  stdout.write(`${text}\n`);
}

const live = {
  publish(event) {
    const { payload, type } = event;
    switch (type) {
      case LiveEventTypes.TurnStarted:
        line(`turn ${short(event.turnId)}  started`);
        return;
      case LiveEventTypes.ContentDelta:
        stdout.write(payload.text);
        streaming = true;
        return;
      case LiveEventTypes.ToolStarted:
        line(`  tool.started    ${payload.name}  ${short(event.toolCallId)}`);
        return;
      case LiveEventTypes.ToolCompleted:
        line(`  tool.completed  ${short(event.toolCallId)}`);
        return;
      case LiveEventTypes.ToolFailed:
        line(`  tool.failed     ${short(event.toolCallId)}  ${payload.error?.code ?? ""}`);
        return;
      case LiveEventTypes.ToolProgress:
        line(`  tool.progress   ${payload.message}`);
        return;
      case LiveEventTypes.StdoutDelta:
      case LiveEventTypes.StderrDelta:
        line(`  | ${payload.text.replace(/\n$/, "").split("\n").join("\n  | ")}`);
        return;
      case LiveEventTypes.ApprovalRequested:
        pendingApprovals.push(handleApproval(event));
        return;
      case LiveEventTypes.ApprovalResolved:
        line(`  approval        ${payload.decision}`);
        return;
      case LiveEventTypes.Warning:
        line(`  warning         ${payload.message}`);
        return;
      case LiveEventTypes.TurnCompleted:
        line(`turn ${short(event.turnId)}  completed  ${payload.stopReason ?? ""}`);
        return;
      case LiveEventTypes.TurnFailed:
        line(`turn ${short(event.turnId)}  failed     ${payload.error?.message ?? ""}`);
        return;
      case LiveEventTypes.TurnAborted:
        line(`turn ${short(event.turnId)}  aborted    ${payload.reason ?? ""}`);
        return;
      default:
        return;
    }
  },
};

class InspectingProvider {
  constructor(name, options) {
    this.options = options;
    this.name = `${name}-inspected`;
  }

  async *run(request) {
    line("");
    line("PROVIDER REQUEST");
    line(JSON.stringify(buildChatCompletionsRequestBody(this.options, request), null, 2));
    line("");
    line("PROVIDER HISTORY");
    line(JSON.stringify(request.history, null, 2));
    line("");
    line("inspect-provider: exiting without calling upstream provider");
    yield* [];
    return;
  }
}

// Resolving an approval submits a second command while turn.submit is still in
// flight. That concurrency is required by B8 and this is its first real exercise.
async function handleApproval(event) {
  line(`\n  approve? ${event.payload.reason}`);
  const rl = createInterface({ input: stdin, output: stdout });
  let answer = "n";
  try {
    answer = (await rl.question("  [y/N] ")).trim().toLowerCase();
  } finally {
    rl.close();
  }
  const decision = answer === "y" || answer === "yes" ? ApprovalDecisions.Allow : ApprovalDecisions.Deny;
  await engine.submit(
    command(
      CommandTypes.ApprovalResolve,
      {
        conversationId: event.conversationId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        approvalId: event.approvalId,
      },
      { decision },
    ),
  );
}

const short = (id) => (id ? id.slice(0, 13) : "-");

// ---- compose ----

const engine = createAssistantEngine({
  provider: createProvider(),
  tools: createWorkspaceToolExecutor({ roots: [workspace], defaultRoot: workspace }),
  policy,
  durable,
  live,
  ids,
  clock,
});

function createProvider() {
  const maxTokens = 4096;
  switch (providerName) {
    case "ollama": {
      const options = {
        ...(baseUrl === undefined ? {} : { baseUrl }),
        model,
        maxTokens,
      };
      const provider = ollamaChatCompletions(options);
      return inspectProvider ? new InspectingProvider(provider.name, { model, maxTokens }) : provider;
    }
    case "openai-chat-completions": {
      const options = { apiKey, baseUrl, model, maxTokens };
      const provider = new OpenAIChatCompletionsAdapter(options);
      return inspectProvider ? new InspectingProvider(provider.name, options) : provider;
    }
    default:
      throw new Error(`unknown provider: ${providerName}`);
  }
}

// ---- run one turn ----

const conversationId = ids.conversationId();
const sessionId = ids.sessionId();
const turnId = ids.turnId();

let cancelling = false;
process.on("SIGINT", () => {
  if (cancelling) return;
  cancelling = true;
  line("\ncancelling -- waiting for a terminal record");
  void engine.submit(command(CommandTypes.TurnCancel, { conversationId, sessionId, turnId }, { reason: "sigint" }));
});

line(`workspace ${workspace}`);
line(`provider  ${providerName}`);
if (providerName === "ollama") line(`baseUrl   ${baseUrl ?? "http://127.0.0.1:11434"}`);
else line(`baseUrl   ${baseUrl}`);
line(`model     ${model}`);
if (inspectProvider) line("inspect   print provider request and skip upstream call");

await engine.submit(
  command(CommandTypes.ConversationCreate, { conversationId, sessionId }, { title: prompt.slice(0, 60) }),
);
await engine.submit(command(CommandTypes.SessionCreate, { conversationId, sessionId }, { provider: providerName }));

const outcome = await engine.submit(
  command(CommandTypes.TurnSubmit, { conversationId, sessionId, turnId }, { input: prompt }),
);

await Promise.allSettled(pendingApprovals);

// ---- report ----

const state = engine.state();
const turn = state.turns.get(turnId);

line("");
line(`outcome   ${outcome.kind}`);
line(`turn      ${turn?.status ?? "missing"}`);
line(`records   ${durable.records().length}`);

// The master invariant from design.md Decision 10. A non-empty issues array means
// the engine emitted a record sequence the protocol considers illegal.
if (state.issues.length > 0) {
  line(`\nENGINE STATE ISSUES (${state.issues.length}) -- this is a bug:`);
  for (const issue of state.issues) line(`  ${issue.code}  seq=${issue.sequence}  ${issue.message}`);
  exit(1);
}
line("issues    none");

exit(turn?.status === "completed" ? 0 : 1);
