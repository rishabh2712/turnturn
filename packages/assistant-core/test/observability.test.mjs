import assert from "node:assert/strict";
import test from "node:test";
import {
  formatApprovalId,
  formatConversationId,
  formatSessionId,
  formatStepId,
  formatToolCallId,
  formatTurnId,
} from "@turnturn/protocol";
import { ContextContributionKinds, formatContextContributionId } from "../dist/context/index.js";
import { createSafeObservationPort } from "../dist/observability/context.js";

const uuid = (n) => `018f1f4e-8d5f-7abc-8123-823456789${String(n).padStart(3, "0")}`;
const turnScope = {
  conversationId: formatConversationId(uuid(1)),
  sessionId: formatSessionId(uuid(2)),
  turnId: formatTurnId(uuid(3)),
};
const stepScope = { ...turnScope, stepId: formatStepId(uuid(4)) };

test("model context keeps an extensible catalog separate from step selection", () => {
  const sourceId = formatContextContributionId("workspace:root:v1");
  const summaryId = formatContextContributionId("extension:summary:v1");
  const catalog = {
    contributions: [
      {
        id: sourceId,
        kind: ContextContributionKinds.WorkspaceInstructions,
        scope: "session",
        source: { kind: "agents-file", reference: { path: "AGENTS.md" } },
        content: [{ text: "Repository instructions" }],
      },
      {
        id: summaryId,
        kind: "acme/semantic-summary",
        scope: "turn",
        source: { kind: "extension", reference: { extension: "acme" } },
        content: [{ text: "Derived summary" }],
        provenance: { derivedFrom: [sourceId], operation: "summarize" },
      },
    ],
  };
  const firstStep = {
    history: { items: [], issues: [] },
    tools: [],
    catalog,
    selections: [
      { contributionId: sourceId, disposition: "included", order: 0 },
      { contributionId: summaryId, disposition: "excluded", reason: "not relevant to this step" },
      { kind: ContextContributionKinds.Memory, disposition: "unavailable", reason: "memory is not wired" },
    ],
  };
  const secondStep = {
    ...firstStep,
    selections: [{ contributionId: summaryId, disposition: "included", order: 0 }],
  };

  const observedContexts = [];
  const safe = createSafeObservationPort(
    recordingObservation({ terminals: [], issues: [], contexts: observedContexts }),
  );
  safe.startTurn(turnScope).startStep(stepScope).modelContext(firstStep);

  assert.equal(catalog.contributions[1].kind, "acme/semantic-summary");
  assert.deepEqual(catalog.contributions[1].provenance, {
    derivedFrom: [sourceId],
    operation: "summarize",
  });
  assert.notDeepEqual(firstStep.selections, secondStep.selections);
  assert.equal(firstStep.selections[1].disposition, "excluded");
  assert.equal(firstStep.selections[2].disposition, "unavailable");
  assert.deepEqual(observedContexts, [firstStep]);
});

test("context contribution ids reject empty identities", () => {
  assert.throws(() => formatContextContributionId("  "), /must not be empty/);
});

test("provider attempt keeps its first terminal outcome and reports competing terminals", () => {
  const terminals = [];
  const issues = [];
  const safe = createSafeObservationPort(
    recordingObservation({
      terminals,
      issues,
    }),
  );
  const attempt = safe
    .startTurn(turnScope)
    .startStep(stepScope)
    .startProviderAttempt({ provider: "openai-compatible", model: "test-model" });

  attempt.complete({ reason: "complete" });
  attempt.fail({ kind: "transport", message: "late failure", retryable: true });
  attempt.cancel("late cancellation");

  assert.deepEqual(terminals, [{ type: "completed", outcome: { reason: "complete" } }]);
  assert.deepEqual(issues, [
    { kind: "duplicate-terminal", first: "completed", ignored: "failed" },
    { kind: "duplicate-terminal", first: "completed", ignored: "cancelled" },
  ]);
});

test("safe observation isolates failures from every observation method", () => {
  const safe = createSafeObservationPort(throwingObservation());

  assert.doesNotThrow(() => {
    const turn = safe.startTurn(turnScope);
    turn.observeTool({
      type: "validation-input",
      scope: { ...stepScope, toolCallId: formatToolCallId(uuid(5)) },
      name: "read",
      input: { path: "README.md" },
    });
    turn.observeApproval({
      type: "requested",
      scope: {
        ...stepScope,
        toolCallId: formatToolCallId(uuid(5)),
        approvalId: formatApprovalId(uuid(6)),
      },
      reason: "test",
    });

    const step = turn.startStep(stepScope);
    step.modelContext({
      history: { items: [], issues: [] },
      tools: [],
      catalog: { contributions: [] },
      selections: [],
    });
    const attempt = step.startProviderAttempt({ provider: "openai-compatible", model: "test-model" });
    attempt.wireRequest({ method: "POST", route: "/v1/chat/completions", body: { stream: true } });
    attempt.responseMetadata({ status: 200 });
    attempt.rawResponseFrame({ data: "[DONE]" });
    attempt.providerEvent({ type: "completed", reason: "complete" });
    attempt.complete({ reason: "complete" });
    attempt.issue({ kind: "payload-truncated", boundBytes: 1 });
    step.complete({ reason: "complete" });
    turn.complete({ reason: "complete" });
  });
});

test("safe observation reports degradation without surfacing it", () => {
  const failures = [];
  const observer = recordingObservation({ terminals: [], issues: [] });
  observer.degraded = (failure) => failures.push(failure);
  observer.startTurn(turnScope).complete = () => {
    throw new Error("trace writer unavailable");
  };
  const safe = createSafeObservationPort(observer);

  assert.doesNotThrow(() => safe.startTurn(turnScope).complete({ reason: "complete" }));
  assert.deepEqual(failures, [{ operation: "turn.complete", message: "trace writer unavailable" }]);
});

function recordingObservation({ terminals, issues, contexts = [] }) {
  const attempt = {
    wireRequest() {},
    responseMetadata() {},
    rawResponseFrame() {},
    providerEvent() {},
    complete(outcome) {
      terminals.push({ type: "completed", outcome });
    },
    fail(error) {
      terminals.push({ type: "failed", error });
    },
    cancel(reason) {
      terminals.push({ type: "cancelled", reason });
    },
    issue(issue) {
      issues.push(issue);
    },
  };
  const step = {
    modelContext(context) {
      contexts.push(context);
    },
    startProviderAttempt() {
      return attempt;
    },
    complete() {},
    fail() {},
    cancel() {},
  };
  const turn = {
    startStep() {
      return step;
    },
    observeTool() {},
    observeApproval() {},
    complete() {},
    fail() {},
    cancel() {},
  };
  return {
    startTurn() {
      return turn;
    },
    degraded() {},
  };
}

function throwingObservation() {
  const throws = () => {
    throw new Error("observer failed");
  };
  const attempt = {
    wireRequest: throws,
    responseMetadata: throws,
    rawResponseFrame: throws,
    providerEvent: throws,
    complete: throws,
    fail: throws,
    cancel: throws,
    issue: throws,
  };
  const step = {
    modelContext: throws,
    startProviderAttempt() {
      return attempt;
    },
    complete: throws,
    fail: throws,
    cancel: throws,
  };
  const turn = {
    startStep() {
      return step;
    },
    observeTool: throws,
    observeApproval: throws,
    complete: throws,
    fail: throws,
    cancel: throws,
  };
  return {
    startTurn() {
      return turn;
    },
    degraded: throws,
  };
}
