import type { SerializedError } from "@turnturn/protocol";
import type { ModelContextSnapshot } from "../context/index.js";
import type { ProviderEvent, ProviderFailure } from "../ports.js";
import {
  type ApprovalObservation,
  noopProviderAttemptObservation,
  noopStepObservation,
  noopTurnObservation,
  type ObservationFailure,
  type ObservationIssue,
  type ObservationPort,
  type ProviderAttemptCompletion,
  type ProviderAttemptObservation,
  type ProviderAttemptStart,
  type ProviderAttemptTerminal,
  type ProviderResponseMetadataObservation,
  type ProviderStepCompletion,
  type ProviderWireRequestObservation,
  type RawProviderFrameObservation,
  type StepObservation,
  type StepObservationScope,
  type ToolObservation,
  type TurnCompletionObservation,
  type TurnObservation,
  type TurnObservationScope,
} from "./types.js";

export function createSafeObservationPort(delegate: ObservationPort): ObservationPort {
  return new SafeObservationPort(delegate);
}

class SafeObservationPort implements ObservationPort {
  constructor(private readonly delegate: ObservationPort) {}

  startTurn(scope: TurnObservationScope): TurnObservation {
    const observed = this.invoke("turn.start", () => this.delegate.startTurn(scope), noopTurnObservation);
    return observed === noopTurnObservation ? observed : new SafeTurnObservation(this, observed);
  }

  degraded(failure: ObservationFailure): void {
    try {
      this.delegate.degraded(failure);
    } catch {
      // The degradation reporter belongs to the diagnostic path too. It must not escape.
    }
  }

  invoke<T>(operation: string, action: () => T, fallback: T): T {
    try {
      return action();
    } catch (error) {
      this.degraded({ operation, message: errorMessage(error) });
      return fallback;
    }
  }

  run(operation: string, action: () => void): void {
    this.invoke(operation, action, undefined);
  }
}

class SafeTurnObservation implements TurnObservation {
  constructor(
    private readonly root: SafeObservationPort,
    private readonly delegate: TurnObservation,
  ) {}

  startStep(scope: StepObservationScope): StepObservation {
    const observed = this.root.invoke("step.start", () => this.delegate.startStep(scope), noopStepObservation);
    return observed === noopStepObservation ? observed : new SafeStepObservation(this.root, observed);
  }

  observeTool(event: ToolObservation): void {
    this.root.run("tool.observe", () => this.delegate.observeTool(event));
  }

  observeApproval(event: ApprovalObservation): void {
    this.root.run("approval.observe", () => this.delegate.observeApproval(event));
  }

  complete(outcome: TurnCompletionObservation): void {
    this.root.run("turn.complete", () => this.delegate.complete(outcome));
  }

  fail(error: SerializedError): void {
    this.root.run("turn.fail", () => this.delegate.fail(error));
  }

  cancel(reason?: string): void {
    this.root.run("turn.cancel", () => this.delegate.cancel(reason));
  }
}

class SafeStepObservation implements StepObservation {
  constructor(
    private readonly root: SafeObservationPort,
    private readonly delegate: StepObservation,
  ) {}

  modelContext(context: ModelContextSnapshot): void {
    this.root.run("step.model-context", () => this.delegate.modelContext(context));
  }

  startProviderAttempt(attempt: ProviderAttemptStart): ProviderAttemptObservation {
    const observed = this.root.invoke(
      "attempt.start",
      () => this.delegate.startProviderAttempt(attempt),
      noopProviderAttemptObservation,
    );
    return observed === noopProviderAttemptObservation
      ? observed
      : new SafeProviderAttemptObservation(this.root, observed);
  }

  complete(outcome: ProviderStepCompletion): void {
    this.root.run("step.complete", () => this.delegate.complete(outcome));
  }

  fail(error: ProviderFailure): void {
    this.root.run("step.fail", () => this.delegate.fail(error));
  }

  cancel(reason?: string): void {
    this.root.run("step.cancel", () => this.delegate.cancel(reason));
  }
}

class SafeProviderAttemptObservation implements ProviderAttemptObservation {
  private terminal: ProviderAttemptTerminal | undefined;

  constructor(
    private readonly root: SafeObservationPort,
    private readonly delegate: ProviderAttemptObservation,
  ) {}

  wireRequest(request: ProviderWireRequestObservation): void {
    this.root.run("attempt.wire-request", () => this.delegate.wireRequest(request));
  }

  responseMetadata(metadata: ProviderResponseMetadataObservation): void {
    this.root.run("attempt.response-metadata", () => this.delegate.responseMetadata(metadata));
  }

  rawResponseFrame(frame: RawProviderFrameObservation): void {
    this.root.run("attempt.raw-response-frame", () => this.delegate.rawResponseFrame(frame));
  }

  providerEvent(event: ProviderEvent): void {
    this.root.run("attempt.provider-event", () => this.delegate.providerEvent(event));
  }

  complete(outcome: ProviderAttemptCompletion): void {
    this.recordTerminal("completed", () => this.delegate.complete(outcome));
  }

  fail(error: ProviderFailure): void {
    this.recordTerminal("failed", () => this.delegate.fail(error));
  }

  cancel(reason?: string): void {
    this.recordTerminal("cancelled", () => this.delegate.cancel(reason));
  }

  issue(issue: ObservationIssue): void {
    this.root.run("attempt.issue", () => this.delegate.issue(issue));
  }

  private recordTerminal(terminal: ProviderAttemptTerminal, record: () => void): void {
    if (this.terminal !== undefined) {
      this.issue({ kind: "duplicate-terminal", first: this.terminal, ignored: terminal });
      return;
    }

    this.terminal = terminal;
    this.root.run(`attempt.${terminal}`, record);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
