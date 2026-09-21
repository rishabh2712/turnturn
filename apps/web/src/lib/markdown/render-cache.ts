import type { ReactElement } from "react";
import ReactMarkdown, { type Options as ReactMarkdownOptions } from "react-markdown";
import { hashContent } from "./hash";
import { LruCache } from "./lru-cache";

/**
 * D17 — "a content-hash-keyed LRU of parsed output (it caches ~3ms of
 * lexing per message)". `react-markdown`'s default export (`Markdown` in its
 * source) is a plain, hookless function — `processor.runSync` followed by a
 * synchronous JSX build — so it is safe to call directly instead of only
 * through JSX. That lets us genuinely skip the parse (not just skip a
 * re-render) whenever the same content has already been rendered, even
 * across component remounts.
 */
const CACHE_CAPACITY = 50;
interface CachedRender {
  readonly source: string;
  readonly element: ReactElement;
}

const cache = new LruCache<string, CachedRender>(CACHE_CAPACITY);

let parseCount = 0;

/** Test-only instrumentation: how many times the underlying parser actually ran. */
export function getMarkdownParseCountForTests(): number {
  return parseCount;
}

export function resetMarkdownParseCountForTests(): void {
  parseCount = 0;
  cache.clear();
}

export function markdownCacheSizeForTests(): number {
  return cache.size;
}

export function renderMarkdownCached(content: string, options: Omit<ReactMarkdownOptions, "children">): ReactElement {
  const key = hashContent(content);
  const cached = cache.get(key);
  if (cached !== undefined && cached.source === content) return cached.element;

  parseCount += 1;
  const element = ReactMarkdown({ ...options, children: content });
  cache.set(key, { source: content, element });
  return element;
}
