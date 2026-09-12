import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cwd, env } from "node:process";

export function loadEnvFile(path = resolve(cwd(), ".env.local")): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }

  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed === undefined || env[parsed.key] !== undefined) continue;
    env[parsed.key] = parsed.value;
  }
}

function parseEnvLine(line: string): { readonly key: string; readonly value: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const separator = trimmed.indexOf("=");
  if (separator === -1) return undefined;

  const key = trimmed.slice(0, separator).trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) return undefined;

  const rawValue = trimmed.slice(separator + 1).trim();
  return { key, value: unquote(rawValue) };
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
