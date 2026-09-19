import type { ProviderCatalog, ProviderConnection, ProviderModelOption } from "@turnturn/chat-client";
import { useEffect, useMemo, useRef, useState } from "react";

export interface ModelPickerProps {
  /** `undefined` while the catalog is still loading. Rendering never blocks on it (D30 — configured profiles work without discovery). */
  readonly catalog: ProviderCatalog | undefined;
  readonly value: string;
  /** Shown when `value` is not present in `catalog` at all (e.g. before the catalog has loaded). */
  readonly currentLabel?: string;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly onChange: (modelProfileId: string) => void;
  readonly onRefresh: () => void;
  readonly refreshing?: boolean;
}

interface FlatOption {
  readonly connection: ProviderConnection;
  readonly model: ProviderModelOption;
}

/**
 * Grouped, searchable model picker (D30). Rendering only — it never fetches or
 * discovers anything itself; `catalog` and `onRefresh` are supplied by the caller so
 * there is exactly one place holding catalog state (5.4c.7).
 */
export function ModelPicker(props: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const flatOptions = useMemo(() => flatten(props.catalog), [props.catalog]);
  const current = flatOptions.find((option) => option.model.id === props.value);
  const currentLabel = current?.model.label ?? props.currentLabel ?? props.value;

  const filtered = useMemo(() => matching(flatOptions, query), [flatOptions, query]);
  const grouped = useMemo(() => groupByConnection(filtered), [filtered]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocumentClick(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) close();
    }
    document.addEventListener("mousedown", onDocumentClick);
    return () => document.removeEventListener("mousedown", onDocumentClick);
  }, [open]);

  function close() {
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  }

  function select(option: FlatOption) {
    if (!option.model.available || option.model.toolCompatibility === "unsupported") return;
    props.onChange(option.model.id);
    close();
  }

  return (
    <div className="tt-model-picker" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="tt-model-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={props.disabled}
        title={props.disabled ? props.disabledReason : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="tt-visually-hidden">Model</span>
        {currentLabel}
        {current !== undefined && !current.model.available ? (
          <span className="tt-model-picker-warning" aria-hidden="true">
            ⚠
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="tt-model-picker-popover" role="dialog" aria-label="Choose a model">
          <div className="tt-model-picker-search-row">
            <input
              ref={searchRef}
              type="text"
              aria-label="Search models"
              placeholder="Search provider, model, or id…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  close();
                }
              }}
            />
            <button
              type="button"
              className="tt-model-picker-refresh"
              disabled={props.refreshing}
              onClick={() => props.onRefresh()}
            >
              {props.refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          <div role="listbox" aria-label="Models" className="tt-model-picker-list">
            {grouped.length === 0 ? <p className="tt-model-picker-empty">No models match “{query}”.</p> : null}
            {grouped.map(([connection, options]) => (
              <div className="tt-model-picker-group" key={connection.id}>
                <div className="tt-model-picker-group-header">
                  <span>{connection.label}</span>
                  <span className="tt-model-picker-connection-state" data-status={connection.status}>
                    {connectionStatusLabel(connection)}
                  </span>
                </div>
                {options.map((option) => {
                  const disabledOption = !option.model.available || option.model.toolCompatibility === "unsupported";
                  return (
                    <button
                      key={option.model.id}
                      type="button"
                      role="option"
                      aria-selected={option.model.id === props.value}
                      aria-disabled={disabledOption}
                      disabled={disabledOption}
                      className="tt-model-picker-option"
                      title={disabledReason(option.model)}
                      onClick={() => select(option)}
                    >
                      <span className="tt-model-picker-option-label">{option.model.label}</span>
                      <span className="tt-model-picker-option-meta">
                        <span className="tt-model-picker-source">{option.model.source}</span>
                        {option.model.toolCompatibility !== "supported" ? (
                          <span className="tt-model-picker-compat" data-compat={option.model.toolCompatibility}>
                            {option.model.toolCompatibility === "unsupported" ? "unsupported" : "tools: unknown"}
                          </span>
                        ) : null}
                        {!option.model.available ? (
                          <span className="tt-model-picker-unavailable">unavailable</span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function flatten(catalog: ProviderCatalog | undefined): readonly FlatOption[] {
  if (catalog === undefined) return [];
  return catalog.connections.flatMap((connection) => connection.models.map((model) => ({ connection, model })));
}

function matching(options: readonly FlatOption[], query: string): readonly FlatOption[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return options;
  return options.filter(
    (option) =>
      option.connection.label.toLowerCase().includes(needle) ||
      option.model.label.toLowerCase().includes(needle) ||
      option.model.model.toLowerCase() === needle ||
      option.model.model.toLowerCase().includes(needle),
  );
}

function groupByConnection(options: readonly FlatOption[]): ReadonlyArray<[ProviderConnection, readonly FlatOption[]]> {
  const order: ProviderConnection[] = [];
  const byConnection = new Map<string, FlatOption[]>();
  for (const option of options) {
    if (!byConnection.has(option.connection.id)) {
      byConnection.set(option.connection.id, []);
      order.push(option.connection);
    }
    byConnection.get(option.connection.id)?.push(option);
  }
  return order.map((connection) => [connection, byConnection.get(connection.id) ?? []]);
}

function connectionStatusLabel(connection: ProviderConnection): string {
  if (connection.status === "refreshing") return "refreshing…";
  if (connection.status === "error") return connection.stale ? "unavailable (showing last known)" : "unavailable";
  return connection.locality;
}

function disabledReason(model: ProviderModelOption): string | undefined {
  if (model.toolCompatibility === "unsupported") return "This model does not support tool use.";
  if (!model.available) return "No longer listed by its provider; the previous conversation stays readable.";
  return undefined;
}
