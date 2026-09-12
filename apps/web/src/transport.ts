import type { CommandEnvelope, CommandOutcome, DebugState, DurableRecord, LiveEvent } from "./protocol";

export interface SnapshotEvent {
  readonly snapshotSequence: number;
}

export type TransportEvent =
  | { readonly kind: "snapshot"; readonly snapshot: SnapshotEvent }
  | { readonly kind: "live"; readonly event: LiveEvent }
  | { readonly kind: "error"; readonly error: Event };

function serverToken(): string {
  const injected = (window as Window & { __TURNTURN__?: { token?: string } }).__TURNTURN__?.token;
  return injected ?? import.meta.env.VITE_TURNTURN_TOKEN ?? "";
}

export async function sendCommand(command: CommandEnvelope): Promise<CommandOutcome> {
  const response = await fetch("/commands", {
    method: "POST",
    headers: { "content-type": "application/json", "x-turnturn-token": serverToken() },
    body: JSON.stringify(command),
  });
  const body = (await response.json()) as CommandOutcome | { readonly error?: { readonly message?: string } };
  if (!response.ok) {
    const message = "error" in body ? body.error?.message : undefined;
    throw new Error(message ?? `Command failed with HTTP ${response.status}`);
  }
  return body as CommandOutcome;
}

export async function fetchRecords(afterSequence: number): Promise<readonly DurableRecord[]> {
  const response = await fetch(`/records?afterSequence=${afterSequence}`);
  if (!response.ok) throw new Error(`Records failed with HTTP ${response.status}`);
  return ((await response.json()) as { readonly records: readonly DurableRecord[] }).records;
}

export async function fetchDebugState(): Promise<DebugState> {
  const response = await fetch("/debug/state");
  if (!response.ok) throw new Error(`Debug state failed with HTTP ${response.status}`);
  return (await response.json()) as DebugState;
}

export function subscribeEvents(onEvent: (event: TransportEvent) => void): () => void {
  const source = new EventSource(`/events?token=${encodeURIComponent(serverToken())}`);
  source.addEventListener("snapshot", (event) => {
    onEvent({ kind: "snapshot", snapshot: JSON.parse(event.data) as SnapshotEvent });
  });
  source.onmessage = (event) => {
    onEvent({ kind: "live", event: JSON.parse(event.data) as LiveEvent });
  };
  source.addEventListener("warning", (event) => {
    onEvent({ kind: "live", event: JSON.parse(event.data) as LiveEvent });
  });
  for (const type of [
    "turn.started",
    "turn.completed",
    "turn.failed",
    "turn.aborted",
    "content.delta",
    "reasoning.delta",
    "tool.started",
    "tool.progress",
    "tool.completed",
    "tool.failed",
    "approval.requested",
    "approval.resolved",
    "stdout.delta",
    "stderr.delta",
  ]) {
    source.addEventListener(type, (event) => {
      onEvent({ kind: "live", event: JSON.parse(event.data) as LiveEvent });
    });
  }
  source.onerror = (error) => onEvent({ kind: "error", error });
  return () => source.close();
}
