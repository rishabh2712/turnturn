import type { ConversationId, SessionId, TurnId } from "@turnturn/protocol";

export interface TurnRuntimeOptions {
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
}

export class TurnRuntime {
  private readonly controller = new AbortController();
  private readonly terminalReached: Promise<void>;
  private resolveTerminal!: () => void;
  private terminal = false;
  private reason: string | undefined;

  constructor(readonly scope: TurnRuntimeOptions) {
    this.terminalReached = new Promise((resolve) => {
      this.resolveTerminal = resolve;
    });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cancelReason(): string | undefined {
    return this.reason;
  }

  get isCancelled(): boolean {
    return this.controller.signal.aborted;
  }

  get isTerminal(): boolean {
    return this.terminal;
  }

  async waitForTerminal(): Promise<void> {
    await this.terminalReached;
  }

  requestCancel(reason: string | undefined): void {
    if (reason === undefined) this.reason = undefined;
    else this.reason = reason;
    this.controller.abort();
  }

  markTerminal(): boolean {
    if (this.terminal) return false;
    this.terminal = true;
    this.resolveTerminal();
    return true;
  }
}
