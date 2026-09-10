import type { JsonValue } from "@turnturn/protocol";
import type { ToolOutcome } from "../ports.js";

export class ToolInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function completed(output: JsonValue): ToolOutcome {
  return { kind: "completed", output };
}

export function failed(code: string, message: string, fatal = false): ToolOutcome {
  return { kind: "failed", error: { code, message, retryable: false, fatal } };
}

export function toolError(code: string, message: string): ToolInputError {
  return new ToolInputError(code, message);
}
