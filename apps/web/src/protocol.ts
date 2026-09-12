export const SCHEMA_VERSION = 1;

export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

export interface CommandEnvelope {
  readonly schemaVersion: 1;
  readonly commandId: string;
  readonly type: string;
  readonly createdAt: string;
  readonly idempotencyKey?: string;
  readonly conversationId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly stepId?: string;
  readonly toolCallId?: string;
  readonly approvalId?: string;
  readonly payload: Record<string, JsonValue | undefined>;
}

export interface DurableRecord {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly recordId: string;
  readonly type: string;
  readonly createdAt: string;
  readonly conversationId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly stepId?: string;
  readonly toolCallId?: string;
  readonly approvalId?: string;
  readonly payload: Record<string, JsonValue | undefined>;
}

export interface LiveEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly type: string;
  readonly createdAt: string;
  readonly recordId?: string;
  readonly conversationId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly stepId?: string;
  readonly toolCallId?: string;
  readonly approvalId?: string;
  readonly payload: Record<string, JsonValue | undefined>;
}

export interface CommandOutcome {
  readonly kind: "accepted" | "duplicate" | "rejected";
  readonly records?: readonly DurableRecord[];
  readonly code?: string;
  readonly message?: string;
}

export interface DebugState {
  readonly config: Record<string, JsonValue | undefined>;
  readonly lastSequence: number;
  readonly issues: readonly JsonValue[];
  readonly state: JsonValue;
}

export const id = (prefix: string): string => `${prefix}_${crypto.randomUUID().toLowerCase()}`;

export function command(
  type: string,
  scope: Partial<Pick<CommandEnvelope, "conversationId" | "sessionId" | "turnId" | "toolCallId" | "approvalId">>,
  payload: CommandEnvelope["payload"],
): CommandEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    commandId: id("cmd"),
    type,
    createdAt: new Date().toISOString(),
    idempotencyKey: id("cmd"),
    ...scope,
    payload,
  };
}
