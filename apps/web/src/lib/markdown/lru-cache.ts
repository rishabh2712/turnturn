/**
 * A small, generic LRU cache. Used to bound the Markdown parse cache (6.5)
 * so a long conversation doesn't grow it unbounded.
 */
export class LruCache<K, V> {
  private readonly capacity: number;
  private readonly store = new Map<K, V>();

  constructor(capacity: number) {
    if (capacity < 1) throw new Error("LruCache capacity must be at least 1");
    this.capacity = capacity;
  }

  get size(): number {
    return this.store.size;
  }

  get(key: K): V | undefined {
    const value = this.store.get(key);
    if (value === undefined) return undefined;
    // Refresh recency: delete and re-insert so it becomes the newest entry.
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.store.has(key)) this.store.delete(key);
    else if (this.store.size >= this.capacity) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(key, value);
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  clear(): void {
    this.store.clear();
  }
}
