import type { JsonValue } from "@turnturn/protocol";
import { toolError } from "./tool-results.js";

export function objectInput(input: JsonValue): Record<string, JsonValue> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw toolError("INVALID_INPUT", "Tool input must be an object");
  }
  return input as Record<string, JsonValue>;
}

export function stringField(input: Record<string, JsonValue>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw toolError("INVALID_INPUT", `${key} must be a string`);
  return value;
}

export function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function optionalInteger(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

export function booleanField(input: Record<string, JsonValue>, key: string, fallback: boolean): boolean {
  const value = input[key];
  return typeof value === "boolean" ? value : fallback;
}
