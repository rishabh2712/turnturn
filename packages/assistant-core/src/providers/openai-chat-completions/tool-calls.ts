import type { JsonValue } from "@turnturn/protocol";
import type { ProviderEvent, ProviderToolCall } from "../../ports.js";

export interface ToolCallUpdate {
  readonly index: number;
  readonly callId: string | undefined;
  readonly name: string;
  readonly argumentsDelta: string;
}

export class ChatToolCallAssembler {
  private readonly calls = new Map<number, MutableToolCall>();

  get size(): number {
    return this.calls.size;
  }

  merge(update: ToolCallUpdate): ProviderEvent[] {
    const call = this.callFor(update);
    const events: ProviderEvent[] = [];
    if (update.callId !== undefined) call.callId = update.callId;
    if (update.name.length > 0) call.name = update.name;
    if (update.argumentsDelta.length > 0) {
      call.argumentsText += update.argumentsDelta;
      call.bufferedArgumentsDelta += update.argumentsDelta;
    }

    if (call.callId !== undefined && !call.started) {
      call.started = true;
      events.push({ type: "tool-call-start", callId: call.callId, name: call.name });
    }

    if (call.callId !== undefined && call.started && call.bufferedArgumentsDelta.length > 0) {
      events.push({ type: "tool-call-arguments-delta", callId: call.callId, text: call.bufferedArgumentsDelta });
      call.bufferedArgumentsDelta = "";
    }

    return events;
  }

  completedCalls():
    | { readonly ok: true; readonly calls: readonly ProviderToolCall[] }
    | { readonly ok: false; readonly message: string } {
    const completed: ProviderToolCall[] = [];
    for (const call of this.calls.values()) {
      if (call.callId === undefined) {
        return {
          ok: false,
          message: "Tool call completed without a provider id",
        };
      }
      const parsed = this.parseToolArguments(call);
      if (parsed === undefined) {
        return {
          ok: false,
          message: `Tool call ${call.callId} completed without parseable JSON arguments`,
        };
      }
      completed.push(parsed);
    }
    return { ok: true, calls: completed };
  }

  callIds(): readonly string[] {
    return [...this.calls.values()].map((call) => call.callId ?? "<missing-provider-id>");
  }

  private callFor(update: ToolCallUpdate): MutableToolCall {
    const existing = this.calls.get(update.index);
    if (existing !== undefined) return existing;
    const created = {
      callId: update.callId,
      name: update.name,
      argumentsText: "",
      bufferedArgumentsDelta: "",
      started: false,
    };
    this.calls.set(update.index, created);
    return created;
  }

  private parseToolArguments(call: MutableToolCall): ProviderToolCall | undefined {
    try {
      const input = JSON.parse(call.argumentsText) as JsonValue;
      if (call.callId === undefined) return undefined;
      return { callId: call.callId, name: call.name, input };
    } catch {
      return undefined;
    }
  }
}

interface MutableToolCall {
  callId: string | undefined;
  name: string;
  argumentsText: string;
  bufferedArgumentsDelta: string;
  started: boolean;
}
