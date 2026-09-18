// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnInspector } from "../src/components/developer/TurnInspector";

afterEach(cleanup);

describe("TurnInspector", () => {
  it("shows the tools that were actually sent even when the assistant response claims none exist", async () => {
    const trace = {
      traceId: "trace_1",
      turns: [{ turnId: "turn_1", status: "completed" as const }],
      steps: [
        {
          stepId: "step_1",
          turnId: "turn_1",
          status: "completed" as const,
          context: {
            messages: [{ role: "assistant", content: "I do not have tools." }],
            contributions: [],
            selections: [],
            tools: [{ name: "read", description: "Read a workspace file", mutating: false }],
            estimatedTokens: 12,
          },
        },
      ],
      attempts: [],
      tools: [],
      approvals: [],
      provenanceLinks: [],
      payloadReferences: [],
      issues: [],
    };
    const transport = {
      listTraces: vi.fn(async () => ({
        traces: [
          {
            traceId: "trace_1",
            turnId: "turn_1",
            capturedAt: "2026-09-19T00:00:00.000Z",
            provider: "litellm",
            model: "claude",
            status: "completed" as const,
            lastTraceSequence: 5,
            issueCount: 0,
          },
        ],
      })),
      getTrace: vi.fn(async () => ({ traceId: "trace_1", lastTraceSequence: 5, unchanged: false, trace })),
    };

    render(
      <TurnInspector
        lifecycleKey="terminal"
        onClose={() => {}}
        selection={{ conversationId: "conv_1", sessionId: "sess_1", turnId: "turn_1" }}
        transport={transport as never}
      />,
    );

    await waitFor(() => expect(screen.getByText(/Read a workspace file/)).toBeTruthy());
    expect(screen.getByText("Tools sent to model")).toBeTruthy();
  });
});
