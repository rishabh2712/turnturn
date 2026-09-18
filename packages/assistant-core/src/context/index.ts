export type { BuiltInContextContributionKind } from "./kinds.js";
export { ContextContributionKinds } from "./kinds.js";
export { estimateContextTokens, projectModelContext, withEstimatedTokens } from "./projection.js";
export type {
  ContextCatalogSnapshot,
  ContextContribution,
  ContextContributionId,
  ContextContributionKind,
  ContextContributionProvenance,
  ContextContributionScope,
  ContextContributionSource,
  ContextSelection,
  ModelContextProjection,
  ModelContextSnapshot,
  ProjectedContextContribution,
  ProjectedContextMessage,
  ProjectedToolDefinition,
} from "./types.js";

import type { ContextContributionId } from "./types.js";

export function formatContextContributionId(value: string): ContextContributionId {
  if (value.trim().length === 0) {
    throw new TypeError("Context contribution ID must not be empty");
  }
  return value as ContextContributionId;
}
