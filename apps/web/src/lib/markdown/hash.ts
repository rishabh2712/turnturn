/**
 * Cheap, non-cryptographic FNV-1a hash. D17 asks that the parse cache be
 * keyed "on a hash of the content, not the content itself" — keying directly
 * on the raw string would keep every distinct message string alive for as
 * long as it sits in the cache (an RSS regression Claude Code's own
 * `Markdown.tsx` calls out); a short hex digest avoids that while still
 * giving each distinct content string its own cache slot.
 */
export function hashContent(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Include length as a cheap collision guard — two different strings that
  // happen to hash the same 32-bit value almost never share a length too.
  return `${(hash >>> 0).toString(16)}:${text.length}`;
}
