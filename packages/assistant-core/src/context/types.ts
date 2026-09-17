import type { JsonValue } from "@turnturn/protocol";
import type { ProviderHistory } from "@turnturn/protocol/provider-history";
import type { ToolDefinition } from "../ports.js";

declare const contextContributionIdBrand: unique symbol;

export type ContextContributionId = string & {
  readonly [contextContributionIdBrand]: "ContextContributionId";
};

/**
 * Contribution kinds are producer-owned strings. Built-in values are exported
 * separately for discoverability, while extensions remain free to namespace
 * their own kinds without changing assistant-core.
 */
export type ContextContributionKind = string;

export type ContextContributionScope = "session" | "turn" | "step";

export interface ContextContributionSource {
  readonly kind: string;
  readonly reference?: JsonValue;
}

export interface ContextContributionProvenance {
  readonly derivedFrom: readonly ContextContributionId[];
  readonly operation?: string;
}

export interface ContextContribution {
  readonly id: ContextContributionId;
  readonly kind: ContextContributionKind;
  readonly scope: ContextContributionScope;
  readonly source: ContextContributionSource;
  readonly content: readonly JsonValue[];
  readonly estimatedTokens?: number;
  readonly provenance?: ContextContributionProvenance;
}

/** Immutable view of all contributions available while a step is prepared. */
export interface ContextCatalogSnapshot {
  readonly contributions: readonly ContextContribution[];
}

export type ContextSelection =
  | {
      readonly contributionId: ContextContributionId;
      readonly disposition: "included";
      readonly order: number;
    }
  | {
      readonly contributionId: ContextContributionId;
      readonly disposition: "excluded";
      readonly reason: string;
    }
  | {
      readonly kind: ContextContributionKind;
      readonly disposition: "unavailable";
      readonly reason: string;
    };

/** Frozen provider-neutral context selected for one model step. */
export interface ModelContextSnapshot {
  readonly history: ProviderHistory;
  readonly tools: readonly ToolDefinition[];
  readonly catalog: ContextCatalogSnapshot;
  readonly selections: readonly ContextSelection[];
}
