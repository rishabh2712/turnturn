import type { ProviderToolCall, ToolDefinition, ToolExecutorPort } from "./ports.js";

/** Built-in read-only tools eligible for parallel execution in waves. */
const READ_ONLY_ALLOWLIST = new Set(["read", "glob", "grep"]);

/** Maximum number of calls in a single wave. */
const MAX_WAVE_SIZE = 4;

export interface ToolClassification {
  /** True if this call can be batched into a wave with other reads. */
  readonly canWave: boolean;
  /** True if this call is a mutating or approval-requiring barrier. */
  readonly isBarrier: boolean;
  /** Reason why the tool cannot wave, if applicable. */
  readonly reason?: string | undefined;
}

/**
 * Classifies a tool call to determine if it can be included in a parallel wave.
 * Uses the tool definition's mutating flag and an explicit allowlist of known read-only tools.
 * Unknown custom tools are treated as barriers until their concurrency contract is reviewed.
 */
export function classifyToolCall(call: ProviderToolCall, definitions: readonly ToolDefinition[]): ToolClassification {
  // Unknown tools are barriers.
  const definition = definitions.find((d) => d.name === call.name);
  if (definition === undefined) {
    return {
      canWave: false,
      isBarrier: true,
      reason: `Unknown tool: ${call.name}`,
    };
  }

  // Tools not in the allowlist are barriers, even if they claim mutating: false.
  if (!READ_ONLY_ALLOWLIST.has(call.name)) {
    return {
      canWave: false,
      isBarrier: true,
      reason: `Tool ${call.name} not in read-only allowlist`,
    };
  }

  // Mutating tools in the allowlist shouldn't exist, but treat them as barriers.
  if (definition.mutating) {
    return {
      canWave: false,
      isBarrier: true,
      reason: `Tool ${call.name} is marked mutating`,
    };
  }

  // Read-only allowlisted tool can wave.
  return {
    canWave: true,
    isBarrier: false,
  };
}

export interface WavePlan {
  /** Calls that form the current wave (at most 4). */
  wave: readonly ProviderToolCall[];
  /** Remaining calls to process. */
  remaining: readonly ProviderToolCall[];
  /** Index in the original list where this wave ends. */
  waveEndIndex: number;
}

/**
 * Plans the partitioning of tool calls into waves for parallel execution.
 * Returns the first wave and the remaining calls.
 *
 * Wave rules:
 * - A wave contains at most 4 read-only calls.
 * - A wave stops immediately before a barrier (mutating, approval, or unknown tool).
 * - A call that cannot be admitted (invalid, denying policy, etc.) flushes the current wave.
 *
 * This function only determines the wave boundaries; actual validation and policy
 * decisions happen during execution.
 */
export function planNextWave(calls: readonly ProviderToolCall[], executor: ToolExecutorPort): WavePlan {
  const definitions = executor.definitions();
  const wave: ProviderToolCall[] = [];

  let waveEndIndex = 0;
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (!call) break; // Safety check for undefined

    const classification = classifyToolCall(call, definitions);

    if (!classification.canWave) {
      // Barrier: stop the current wave.
      waveEndIndex = i;
      break;
    }

    wave.push(call);

    // Stop the wave after 4 calls.
    if (wave.length >= MAX_WAVE_SIZE) {
      waveEndIndex = i + 1;
      break;
    }

    waveEndIndex = i + 1;
  }

  return {
    wave: wave as readonly ProviderToolCall[],
    remaining: calls.slice(waveEndIndex),
    waveEndIndex,
  };
}
