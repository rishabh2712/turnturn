const POSSIBLE_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * D17/6.4 — while a message is still streaming it can legitimately end in
 * the middle of a fenced code block (the closing ``` hasn't arrived yet).
 * Left alone, that would make everything after the opening fence render as
 * one open-ended code block with no visual boundary, and confuses the
 * "should this block be highlighted" check in `CodeBlock`. This closes the
 * fence for *display* only — callers must not write the result back into
 * any durable or optimistic message state, only pass it to the renderer.
 */
export function closeUnterminatedFence(text: string): string {
  let open: { readonly character: "`" | "~"; readonly length: number } | undefined;
  for (const line of text.split("\n")) {
    if (open === undefined) {
      const candidate = POSSIBLE_FENCE.exec(line);
      const marker = candidate?.[1];
      if (marker === undefined) continue;
      const character = marker[0] as "`" | "~";
      const info = candidate?.[2] ?? "";
      if (character === "`" && info.includes("`")) continue;
      open = { character, length: marker.length };
      continue;
    }

    const candidate = CLOSING_FENCE.exec(line)?.[1];
    if (candidate?.[0] === open.character && candidate.length >= open.length) open = undefined;
  }

  if (open === undefined) return text;
  const closing = open.character.repeat(open.length);
  return text.endsWith("\n") ? `${text}${closing}\n` : `${text}\n${closing}`;
}
