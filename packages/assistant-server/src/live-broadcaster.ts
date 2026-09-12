import type { LiveSink } from "@turnturn/assistant-core/ports";
import type { LiveEvent } from "@turnturn/protocol";
import { LiveEventTypes, SCHEMA_VERSION, serializeJson } from "@turnturn/protocol";
import type { RuntimeClock, RuntimeIds } from "./ids.js";

export interface LiveBroadcasterOptions {
  readonly clock: RuntimeClock;
  readonly ids: RuntimeIds;
  readonly currentSequence: () => number;
  readonly maxQueueSize?: number;
}

export interface SseWritable {
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): this;
  end(): void;
  destroyed?: boolean;
}

interface Subscriber {
  readonly id: number;
  readonly sink: SseWritable;
  readonly queue: string[];
  flushing: boolean;
  droppedDeltaWarning: boolean;
}

export class LiveBroadcaster implements LiveSink {
  private readonly subscribers = new Map<number, Subscriber>();
  private readonly maxQueueSize: number;
  private nextSubscriberId = 1;

  constructor(private readonly options: LiveBroadcasterOptions) {
    this.maxQueueSize = options.maxQueueSize ?? 256;
  }

  publish(event: LiveEvent): void {
    const frame = sseFrame(event.type, event);
    for (const subscriber of this.subscribers.values()) {
      this.enqueue(subscriber, frame, event);
    }
  }

  subscribe(sink: SseWritable): () => void {
    const subscriber: Subscriber = {
      id: this.nextSubscriberId,
      sink,
      queue: [],
      flushing: false,
      droppedDeltaWarning: false,
    };
    this.nextSubscriberId += 1;
    this.subscribers.set(subscriber.id, subscriber);
    this.enqueue(subscriber, sseFrame("snapshot", { snapshotSequence: this.options.currentSequence() }));
    return () => {
      this.subscribers.delete(subscriber.id);
    };
  }

  private enqueue(subscriber: Subscriber, frame: string, event?: LiveEvent): void {
    if (subscriber.sink.destroyed) {
      this.subscribers.delete(subscriber.id);
      return;
    }

    if (subscriber.queue.length >= this.maxQueueSize) {
      if (event !== undefined && isDroppableDelta(event)) return;
      if (!subscriber.droppedDeltaWarning) {
        subscriber.droppedDeltaWarning = true;
        subscriber.queue.shift();
        subscriber.queue.push(this.queueGapWarning());
      } else {
        subscriber.queue.shift();
      }
    }

    subscriber.queue.push(frame);
    this.flush(subscriber);
  }

  private flush(subscriber: Subscriber): void {
    if (subscriber.flushing) return;
    subscriber.flushing = true;
    while (subscriber.queue.length > 0) {
      const frame = subscriber.queue[0];
      if (frame === undefined) break;
      if (!subscriber.sink.write(frame)) {
        subscriber.sink.once("drain", () => {
          subscriber.flushing = false;
          this.flush(subscriber);
        });
        return;
      }
      subscriber.queue.shift();
    }
    subscriber.flushing = false;
  }

  private queueGapWarning(): string {
    return sseFrame("warning", {
      schemaVersion: SCHEMA_VERSION,
      eventId: this.options.ids.eventId(),
      type: LiveEventTypes.Warning,
      createdAt: this.options.clock.now(),
      payload: {
        code: "LIVE_QUEUE_OVERFLOW",
        message: "Live event queue overflowed; resume from durable records.",
      },
    });
  }
}

function isDroppableDelta(event: LiveEvent): boolean {
  return (
    event.type === LiveEventTypes.ContentDelta ||
    event.type === LiveEventTypes.ReasoningDelta ||
    event.type === LiveEventTypes.StdoutDelta ||
    event.type === LiveEventTypes.StderrDelta
  );
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${serializeJson(data)}\n\n`;
}
