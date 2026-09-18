import type { ObservationFailure } from "@turnturn/assistant-core/observability";

export class TraceWriteQueue {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly onFailure: (failure: ObservationFailure) => void) {}

  schedule(operation: string, action: () => Promise<unknown>): void {
    let tracked!: Promise<void>;
    tracked = Promise.resolve()
      .then(action)
      .then(
        () => undefined,
        (error: unknown) => this.onFailure({ operation, message: errorMessage(error) }),
      )
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
