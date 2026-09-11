export interface SseEvent {
  readonly event?: string;
  readonly data: string;
  readonly id?: string;
  readonly retry?: number;
}

export async function* parseSseStream(chunks: AsyncIterable<Uint8Array>): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    yield* drainCompleteEvents(buffer, (remainder) => {
      buffer = remainder;
    });
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    yield* drainCompleteEvents(`${buffer}\n\n`, (remainder) => {
      buffer = remainder;
    });
  }
}

export async function collectSseEvents(chunks: AsyncIterable<Uint8Array>): Promise<readonly SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of parseSseStream(chunks)) events.push(event);
  return events;
}

function* drainCompleteEvents(input: string, setRemainder: (value: string) => void): Iterable<SseEvent> {
  let cursor = 0;
  while (cursor < input.length) {
    const boundary = nextBoundary(input, cursor);
    if (boundary === undefined) break;

    const raw = input.slice(cursor, boundary.start);
    cursor = boundary.end;
    const event = parseSseFrame(raw);
    if (event !== undefined) yield event;
  }
  setRemainder(input.slice(cursor));
}

function nextBoundary(input: string, from: number): { readonly start: number; readonly end: number } | undefined {
  for (let index = from; index < input.length; index += 1) {
    if (input[index] !== "\n") continue;
    if (input[index + 1] === "\n") return { start: index, end: index + 2 };
    if (input[index - 1] === "\r" && input[index + 1] === "\r" && input[index + 2] === "\n") {
      return { start: index - 1, end: index + 3 };
    }
  }
  return undefined;
}

function parseSseFrame(raw: string): SseEvent | undefined {
  const data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;

  for (const line of raw.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : stripSingleLeadingSpace(line.slice(colon + 1));

    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        data.push(value);
        break;
      case "id":
        id = value;
        break;
      case "retry": {
        const parsed = Number.parseInt(value, 10);
        if (Number.isInteger(parsed) && parsed >= 0) retry = parsed;
        break;
      }
      default:
        break;
    }
  }

  if (data.length === 0 && event === undefined && id === undefined && retry === undefined) return undefined;
  return {
    ...(event === undefined ? {} : { event }),
    data: data.join("\n"),
    ...(id === undefined ? {} : { id }),
    ...(retry === undefined ? {} : { retry }),
  };
}

function stripSingleLeadingSpace(value: string): string {
  return value.startsWith(" ") ? value.slice(1) : value;
}
