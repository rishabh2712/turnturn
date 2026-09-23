import type {
  ToolDefinition,
  ToolExecutionCallbacks,
  ToolExecutionRequest,
  ToolExecutorPort,
  ToolInputValidation,
  ToolOutcome,
} from "./ports.js";

/** Configuration for read-only tool deadlines. */
export interface ReadOnlyToolTimeoutConfig {
  /** Default timeout in milliseconds. Must be positive safe integer. */
  readonly defaultMs?: number | undefined;
  /** Maximum timeout in milliseconds. Must be positive safe integer and >= defaultMs. */
  readonly maxMs?: number | undefined;
  /** Per-tool timeout overrides for read, glob, grep only. Each value must be positive safe integer and <= maxMs. */
  readonly byTool?: Partial<Record<"read" | "glob" | "grep", number>> | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const READ_ONLY_TOOLS = new Set(["read", "glob", "grep"]);

/**
 * Validates the timeout configuration and returns normalized defaults.
 * Throws if any value is invalid:
 * - Must be positive safe integers (no fractional milliseconds)
 * - Must not exceed 2^31-1 ms (Node.js safe timeout limit)
 * - byTool overrides only allowed for read, glob, grep
 */
export function validateTimeoutConfig(config: ReadOnlyToolTimeoutConfig | undefined): {
  defaultMs: number;
  maxMs: number;
  byTool: Record<"read" | "glob" | "grep", number>;
} {
  const defaultMs = config?.defaultMs ?? DEFAULT_TIMEOUT_MS;
  const maxMs = config?.maxMs ?? MAX_TIMEOUT_MS;

  // Safe integer limit: 2^31 - 1 (Node.js setTimeout limit)
  const MAX_SAFE_TIMEOUT_MS = 2147483647;

  // Must be safe integers (no fractional milliseconds)
  if (!Number.isSafeInteger(defaultMs) || defaultMs <= 0) {
    throw new Error(`readOnlyToolTimeouts.defaultMs must be a positive safe integer, got ${defaultMs}`);
  }
  if (!Number.isSafeInteger(maxMs) || maxMs <= 0) {
    throw new Error(`readOnlyToolTimeouts.maxMs must be a positive safe integer, got ${maxMs}`);
  }

  // Must not exceed safe timeout range
  if (defaultMs > MAX_SAFE_TIMEOUT_MS) {
    throw new Error(
      `readOnlyToolTimeouts.defaultMs (${defaultMs}) exceeds maximum safe timeout (${MAX_SAFE_TIMEOUT_MS}ms)`,
    );
  }
  if (maxMs > MAX_SAFE_TIMEOUT_MS) {
    throw new Error(`readOnlyToolTimeouts.maxMs (${maxMs}) exceeds maximum safe timeout (${MAX_SAFE_TIMEOUT_MS}ms)`);
  }

  // defaultMs must not exceed maxMs
  if (defaultMs > maxMs) {
    throw new Error(`readOnlyToolTimeouts.defaultMs (${defaultMs}) must be <= maxMs (${maxMs})`);
  }

  const byTool: Record<"read" | "glob" | "grep", number> = {
    read: defaultMs,
    glob: defaultMs,
    grep: defaultMs,
  };

  if (config?.byTool) {
    for (const [toolName, timeout] of Object.entries(config.byTool)) {
      // Only read, glob, grep are allowed
      if (!["read", "glob", "grep"].includes(toolName)) {
        throw new Error(
          `readOnlyToolTimeouts.byTool has unknown tool '${toolName}'; only 'read', 'glob', 'grep' are allowed`,
        );
      }

      const tool = toolName as "read" | "glob" | "grep";

      // Must be safe integer
      if (!Number.isSafeInteger(timeout) || timeout <= 0) {
        throw new Error(`readOnlyToolTimeouts.byTool.${tool} must be a positive safe integer, got ${timeout}`);
      }

      // Must not exceed maximum
      if (timeout > maxMs) {
        throw new Error(`readOnlyToolTimeouts.byTool.${tool} (${timeout}) must be <= maxMs (${maxMs})`);
      }

      byTool[tool] = timeout;
    }
  }

  return { defaultMs, maxMs, byTool };
}

/**
 * Wraps a ToolExecutorPort to enforce deadlines for read-only tools.
 * Each admitted read, glob, or grep call gets an independent timeout.
 * The wrapper preserves the definitions() and validate() methods unchanged,
 * and adds deadline enforcement to execute().
 *
 * Key guarantees:
 * - Wrapper result settles within deadline (uses Promise.race)
 * - Callbacks are gated by timeout firing, not executor settling
 * - Pre-aborted turns are rejected immediately
 * - Turn cancellation is propagated atomically
 */
export function createDeadlineWrapper(
  executor: ToolExecutorPort,
  config: ReadOnlyToolTimeoutConfig | undefined,
): ToolExecutorPort {
  const timeouts = validateTimeoutConfig(config);

  return {
    definitions(): readonly ToolDefinition[] {
      return executor.definitions();
    },

    validate(request): ToolInputValidation {
      return executor.validate(request);
    },

    async execute(request: ToolExecutionRequest): Promise<ToolOutcome> {
      // Only enforce timeouts for read-only tools
      if (!READ_ONLY_TOOLS.has(request.name)) {
        return executor.execute(request);
      }

      const effectiveTimeout = timeouts.byTool[request.name as "read" | "glob" | "grep"];
      const linkedSignal = request.signal;

      // Check if turn is already cancelled before dispatch (fix #3)
      if (linkedSignal.aborted) {
        return {
          kind: "failed",
          error: {
            code: "TURN_CANCELLED",
            message: "Turn cancelled before tool execution",
            retryable: false,
            fatal: false,
          },
        };
      }

      const controller = new AbortController();
      let timeoutFired = false;

      // Atomically link parent abort listener
      const onParentAbort = () => {
        timeoutFired = true;
        controller.abort();
      };
      linkedSignal.addEventListener("abort", onParentAbort);

      let timeoutHandle: NodeJS.Timeout | undefined;

      try {
        // Gate callbacks by timeoutFired, not by executor settling (fix #2)
        const wrappedCallbacks: ToolExecutionCallbacks = {
          stdout(text: string) {
            if (!timeoutFired) {
              request.callbacks.stdout(text);
            }
          },
          stderr(text: string) {
            if (!timeoutFired) {
              request.callbacks.stderr(text);
            }
          },
          progress(message: string) {
            if (!timeoutFired) {
              request.callbacks.progress(message);
            }
          },
        };

        // Executor promise with signal and wrapped callbacks
        const executorPromise = executor.execute({
          ...request,
          signal: controller.signal,
          callbacks: wrappedCallbacks,
        });

        // Timeout promise that settles immediately on deadline (fix #1)
        const timeoutPromise = new Promise<ToolOutcome>((resolve) => {
          timeoutHandle = setTimeout(() => {
            timeoutFired = true;
            controller.abort();
            resolve({
              kind: "failed",
              error: {
                code: "TOOL_TIMEOUT",
                message: `Tool execution exceeded ${effectiveTimeout}ms timeout`,
                retryable: false,
                fatal: false,
              },
            });
          }, effectiveTimeout);
        });

        // Race to first settlement: either executor completes or deadline fires (fix #1)
        const outcome = await Promise.race([executorPromise, timeoutPromise]);

        // If timeout fired, return timeout error regardless of executor result
        if (timeoutFired) {
          return {
            kind: "failed",
            error: {
              code: "TOOL_TIMEOUT",
              message: `Tool execution exceeded ${effectiveTimeout}ms timeout`,
              retryable: false,
              fatal: false,
            },
          };
        }

        return outcome;
      } catch (error) {
        // If we aborted due to timeout (not parent signal), return TOOL_TIMEOUT
        if (timeoutFired || (controller.signal.aborted && !linkedSignal.aborted)) {
          return {
            kind: "failed",
            error: {
              code: "TOOL_TIMEOUT",
              message: `Tool execution exceeded ${effectiveTimeout}ms timeout`,
              retryable: false,
              fatal: false,
            },
          };
        }
        // Otherwise let the exception propagate (executor implementation error)
        throw error;
      } finally {
        // Cleanup
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
        linkedSignal.removeEventListener("abort", onParentAbort);
      }
    },
  };
}
