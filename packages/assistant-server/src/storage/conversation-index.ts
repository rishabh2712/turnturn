import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ConversationId, parseId } from "@turnturn/protocol";

export type ConversationIndexEvent =
  | {
      readonly type: "created";
      readonly conversationId: ConversationId;
      readonly workspaceKey: string;
      readonly createdAt: string;
    }
  | {
      readonly type: "titled";
      readonly conversationId: ConversationId;
      readonly title: string;
      readonly titleSource: "auto" | "manual";
    }
  | { readonly type: "archived" | "unarchived" | "deleted"; readonly conversationId: ConversationId };

export interface ConversationIndexEntry {
  readonly conversationId: ConversationId;
  readonly workspaceKey: string;
  readonly createdAt: string;
  readonly title: string | null;
  readonly titleSource: "auto" | "manual";
  readonly archived: boolean;
}

export interface ListedConversation extends ConversationIndexEntry {
  readonly lastActivityAt: string;
}

export class ConversationIndex {
  private readonly entries = new Map<ConversationId, ConversationIndexEntry>();
  private lineCount = 0;

  private constructor(private readonly conversationsDir: string) {}

  static async open(workspaceDir: string): Promise<ConversationIndex> {
    const index = new ConversationIndex(join(workspaceDir, "conversations"));
    await mkdir(index.conversationsDir, { recursive: true });
    let text: string;
    try {
      text = await readFile(index.path, "utf8");
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await index.rebuild();
      return index;
    }
    try {
      const lines = text.split("\n").filter((line) => line.length > 0);
      for (const line of lines) index.apply(parseEvent(JSON.parse(line)));
      index.lineCount = lines.length;
    } catch {
      await index.rebuild();
    }
    return index;
  }

  get(conversationId: ConversationId): ConversationIndexEntry | undefined {
    return this.entries.get(conversationId);
  }

  async list(): Promise<readonly ListedConversation[]> {
    const listed = await Promise.all(
      [...this.entries.values()].map(async (entry) => ({
        ...entry,
        lastActivityAt: await this.lastActivityAt(entry),
      })),
    );
    return listed.sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
  }

  async append(event: ConversationIndexEvent): Promise<void> {
    const validated = parseEvent(event);
    if (validated.type !== "created" && validated.type !== "deleted" && !this.entries.has(validated.conversationId)) {
      throw new Error(`Index event has no conversation: ${validated.conversationId}`);
    }
    await appendFile(this.path, `${JSON.stringify(validated)}\n`, "utf8");
    this.apply(validated);
    this.lineCount += 1;
    if (this.lineCount > 5000) await this.compact();
  }

  private get path(): string {
    return join(this.conversationsDir, "index.jsonl");
  }

  private apply(event: ConversationIndexEvent): void {
    if (event.type === "deleted") {
      this.entries.delete(event.conversationId);
      return;
    }
    if (event.type === "created") {
      this.entries.set(event.conversationId, {
        conversationId: event.conversationId,
        workspaceKey: event.workspaceKey,
        createdAt: event.createdAt,
        title: null,
        titleSource: "auto",
        archived: false,
      });
      return;
    }
    const current = this.entries.get(event.conversationId);
    if (current === undefined) throw new Error(`Index event has no conversation: ${event.conversationId}`);
    if (event.type === "titled") {
      this.entries.set(event.conversationId, { ...current, title: event.title, titleSource: event.titleSource });
    } else {
      this.entries.set(event.conversationId, { ...current, archived: event.type === "archived" });
    }
  }

  private async compact(): Promise<void> {
    const events: ConversationIndexEvent[] = [];
    for (const entry of this.entries.values()) {
      events.push({
        type: "created",
        conversationId: entry.conversationId,
        workspaceKey: entry.workspaceKey,
        createdAt: entry.createdAt,
      });
      if (entry.title !== null) {
        events.push({
          type: "titled",
          conversationId: entry.conversationId,
          title: entry.title,
          titleSource: entry.titleSource,
        });
      }
      if (entry.archived) events.push({ type: "archived", conversationId: entry.conversationId });
    }
    await this.writeEvents(events);
    this.lineCount = events.length;
  }

  private async rebuild(): Promise<void> {
    this.entries.clear();
    const events: ConversationIndexEvent[] = [];
    for (const dirent of await readdir(this.conversationsDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const metadataPath = join(this.conversationsDir, dirent.name, "conversation.json");
      let metadataText: string;
      try {
        metadataText = await readFile(metadataPath, "utf8");
      } catch (error) {
        if (!isNotFound(error)) throw error;
        continue;
      }
      const metadata = JSON.parse(metadataText) as Record<string, unknown>;
      const conversationId = parseId("conv", String(metadata.conversationId));
      if (conversationId !== dirent.name) throw new Error(`Conversation metadata path mismatch: ${dirent.name}`);
      const workspaceKey = requireString(metadata.workspaceKey, metadataPath);
      const createdAt = requireString(metadata.createdAt, metadataPath);
      events.push({ type: "created", conversationId, workspaceKey, createdAt });
      if (typeof metadata.title === "string") {
        events.push({
          type: "titled",
          conversationId,
          title: metadata.title,
          titleSource: metadata.titleSource === "manual" ? "manual" : "auto",
        });
      }
      if (metadata.archived === true) events.push({ type: "archived", conversationId });
    }
    for (const event of events) this.apply(event);
    await this.writeEvents(events);
    this.lineCount = events.length;
  }

  private async writeEvents(events: readonly ConversationIndexEvent[]): Promise<void> {
    const tempPath = `${this.path}.tmp-${randomUUID()}`;
    await writeFile(
      tempPath,
      events.map((event) => JSON.stringify(event)).join("\n") + (events.length === 0 ? "" : "\n"),
    );
    await rename(tempPath, this.path);
  }

  private async lastActivityAt(entry: ConversationIndexEntry): Promise<string> {
    const conversationDir = join(this.conversationsDir, entry.conversationId);
    let newest = Date.parse(entry.createdAt);
    for (const folder of ["sessions", "archived"]) {
      const sessionDir = join(conversationDir, folder);
      let names: string[];
      try {
        names = await readdir(sessionDir);
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const file = await stat(join(sessionDir, name));
        newest = Math.max(newest, file.mtimeMs);
      }
    }
    return new Date(newest).toISOString();
  }
}

function parseEvent(value: unknown): ConversationIndexEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid index event");
  const event = value as Record<string, unknown>;
  const conversationId = parseId("conv", String(event.conversationId));
  switch (event.type) {
    case "created":
      return {
        type: "created",
        conversationId,
        workspaceKey: requireString(event.workspaceKey, "index event"),
        createdAt: requireString(event.createdAt, "index event"),
      };
    case "titled":
      if (event.titleSource !== "auto" && event.titleSource !== "manual") throw new Error("Invalid title source");
      return {
        type: "titled",
        conversationId,
        title: requireString(event.title, "index event"),
        titleSource: event.titleSource,
      };
    case "archived":
    case "unarchived":
    case "deleted":
      return { type: event.type, conversationId };
    default:
      throw new Error("Invalid index event type");
  }
}

function requireString(value: unknown, source: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Expected string in ${source}`);
  return value;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
