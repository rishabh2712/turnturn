import type { PolicyRequest, ToolPolicyPort } from "@turnturn/assistant-core/ports";
import type { JsonValue, SerializedError } from "@turnturn/protocol";

export interface LocalPolicyOptions {
  readonly approvalRequiredTools?: readonly string[];
}

export class LocalToolPolicy implements ToolPolicyPort {
  private readonly approvalRequiredTools: ReadonlySet<string>;

  constructor(options: LocalPolicyOptions = {}) {
    this.approvalRequiredTools = new Set(options.approvalRequiredTools ?? ["shell", "write", "edit"]);
  }

  async decide(request: PolicyRequest) {
    if (this.approvalRequiredTools.has(request.name)) {
      return { kind: "ask" as const, reason: describeToolRequest(request.name, request.input) };
    }
    return { kind: "allow" as const };
  }
}

export function policyError(code: string, message: string): SerializedError {
  return { code, message, retryable: false, fatal: false };
}

function describeToolRequest(name: string, input: JsonValue): string {
  if (input && typeof input === "object" && !Array.isArray(input) && typeof input.command === "string") {
    return input.command;
  }
  return `${name} ${JSON.stringify(input)}`;
}
