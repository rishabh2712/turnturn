import type { JsonValue } from "@turnturn/protocol";
import { type ProviderHistoryItem, ProviderHistoryItemTypes } from "@turnturn/protocol/provider-history";
import type {
  ContextContribution,
  ModelContextProjection,
  ModelContextSnapshot,
  ProjectedContextMessage,
} from "./types.js";

export function projectModelContext(snapshot: ModelContextSnapshot): ModelContextProjection {
  const contributions = snapshot.catalog.contributions.map((contribution) => ({
    id: contribution.id,
    kind: contribution.kind,
    scope: contribution.scope,
    source: contribution.source,
    itemCount: contribution.content.length,
    ...(contribution.estimatedTokens === undefined ? {} : { estimatedTokens: contribution.estimatedTokens }),
    ...(contribution.provenance === undefined ? {} : { provenance: contribution.provenance }),
  }));
  const includedIds = new Set(
    snapshot.selections
      .filter((selection) => selection.disposition === "included")
      .map((selection) => selection.contributionId),
  );
  return {
    messages: snapshot.history.items.map(projectHistoryItem),
    contributions,
    selections: snapshot.selections,
    tools: snapshot.tools.map(({ name, description, mutating }) => ({ name, description, mutating })),
    estimatedTokens: contributions.reduce(
      (total, contribution) => total + (includedIds.has(contribution.id) ? (contribution.estimatedTokens ?? 0) : 0),
      0,
    ),
  };
}

export function withEstimatedTokens(contribution: ContextContribution): ContextContribution {
  if (contribution.estimatedTokens !== undefined) return contribution;
  return { ...contribution, estimatedTokens: estimateContextTokens(contribution.content) };
}

export function estimateContextTokens(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((total, item) => total + estimateContextTokens(item), 0);
  const serialized = JSON.stringify(value);
  return serialized === undefined || serialized.length === 0 ? 0 : Math.ceil(serialized.length / 4);
}

function projectHistoryItem(item: ProviderHistoryItem): ProjectedContextMessage {
  const identity = {
    historyType: item.type,
    recordId: item.recordId,
    sequence: item.sequence,
    turnId: item.turnId,
  };
  switch (item.type) {
    case ProviderHistoryItemTypes.UserInput:
      return { ...identity, role: "user", content: item.content };
    case ProviderHistoryItemTypes.AssistantMessage:
      return { ...identity, role: "assistant", content: item.content };
    case ProviderHistoryItemTypes.ToolRequest:
      return {
        ...identity,
        role: "assistant",
        content: { name: item.name, input: item.input },
        stepId: item.stepId,
        toolCallId: item.toolCallId,
        ...(item.providerToolCallId === undefined ? {} : { providerToolCallId: item.providerToolCallId }),
      };
    case ProviderHistoryItemTypes.ToolResult:
      return {
        ...identity,
        role: "tool",
        content:
          item.output !== undefined
            ? item.output
            : item.error === undefined
              ? { status: item.status }
              : toJson(item.error),
        toolCallId: item.toolCallId,
      };
  }
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
