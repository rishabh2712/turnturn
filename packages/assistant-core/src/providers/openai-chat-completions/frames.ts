export type ChatFrame = {
  readonly kind: "chat-frame";
  readonly value: unknown;
};

export type DoneFrame = {
  readonly kind: "done";
};

export type FrameParseResult =
  | ChatFrame
  | DoneFrame
  | {
      readonly kind: "failed";
      readonly message: string;
    };

export function parseChatFrameData(data: string): FrameParseResult {
  if (data === "[DONE]") return { kind: "done" };

  try {
    return { kind: "chat-frame", value: JSON.parse(data) };
  } catch (error) {
    return { kind: "failed", message: `Invalid chat-completions SSE JSON: ${String(error)}` };
  }
}

export function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const field = value[key];
  return isRecord(field) ? field : undefined;
}

export function arrayField(value: Record<string, unknown>, key: string): readonly unknown[] | undefined {
  const field = value[key];
  return Array.isArray(field) ? field : undefined;
}

export function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

export function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
