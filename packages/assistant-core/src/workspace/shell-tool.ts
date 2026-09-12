import { spawn } from "node:child_process";
import type { ToolExecutionRequest, ToolOutcome } from "../ports.js";
import type { WorkspacePathGuard } from "./path-guard.js";
import { objectInput, optionalInteger, optionalString, stringField } from "./tool-input.js";
import { completed, failed } from "./tool-results.js";

export interface ShellToolOptions {
  readonly defaultRoot?: string;
  readonly maxOutputBytes: number;
  readonly shellTimeoutMs: number;
}

export async function shellTool(
  request: ToolExecutionRequest,
  paths: WorkspacePathGuard,
  options: ShellToolOptions,
): Promise<ToolOutcome> {
  const args = objectInput(request.input);
  const command = stringField(args, "command");
  const cwd = await paths.existingDirectory(optionalString(args.cwd) ?? options.defaultRoot ?? ".");
  const timeoutMs = optionalInteger(args.timeoutMs, options.shellTimeoutMs);
  return await runShell(command, cwd.absolute, timeoutMs, options.maxOutputBytes, request);
}

async function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  request: ToolExecutionRequest,
): Promise<ToolOutcome> {
  return await new Promise<ToolOutcome>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;

    const finish = (outcome: ToolOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      resolve(outcome);
    };
    const killGroup = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
    };
    const abort = () => {
      killGroup();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    request.signal.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      request.callbacks.stdout(text);
      const truncated = appendTruncated(stdout, text, maxOutputBytes);
      stdout = truncated.value;
      stdoutTruncated ||= truncated.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      request.callbacks.stderr(text);
      const truncated = appendTruncated(stderr, text, maxOutputBytes);
      stderr = truncated.value;
      stderrTruncated ||= truncated.truncated;
    });
    child.on("error", (error) => {
      finish(failed("SHELL_SPAWN_FAILED", error.message));
    });
    child.on("close", (code, signal) => {
      if (request.signal.aborted) {
        finish(failed("SHELL_ABORTED", "Shell command aborted"));
        return;
      }
      if (timedOut) {
        finish(failed("SHELL_TIMEOUT", `Shell command timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== null) {
        finish(completed({ stdout, stderr, exitCode: code, stdoutTruncated, stderrTruncated }));
        return;
      }
      finish(failed("SHELL_SIGNAL_TERMINATED", `Shell command exited with signal ${signal ?? "unknown"}`));
    });
  });
}

function appendTruncated(
  existing: string,
  next: string,
  maxBytes: number,
): { readonly value: string; readonly truncated: boolean } {
  const combined = existing + next;
  if (Buffer.byteLength(combined) <= maxBytes) return { value: combined, truncated: false };
  return { value: combined.slice(0, maxBytes), truncated: true };
}
