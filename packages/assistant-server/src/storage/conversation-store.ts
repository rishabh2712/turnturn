import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ConversationId,
  formatConversationId,
  formatSessionId,
  parseId,
  type SessionId,
} from "@turnturn/protocol";
import { ConversationIndex, type ListedConversation } from "./conversation-index.js";
import { STORAGE_VERSION, type StateDirectory } from "./state-dir.js";

export interface StoredSession {
  readonly sessionId: SessionId;
  readonly ordinal: number;
  readonly provider: string;
  readonly model: string;
  readonly modelProfileId?: string;
  readonly createdAt: string;
}

export interface StoredConversation {
  readonly conversationId: ConversationId;
  readonly workspaceKey: string;
  readonly createdAt: string;
  readonly storageVersion: number;
  readonly title: string | null;
  readonly titleSource: "auto" | "manual";
  readonly archived: boolean;
  readonly sessions: readonly StoredSession[];
}

export interface ActivatedSession extends StoredSession {
  readonly isNewSession: boolean;
}

export interface ConversationStoreOptions {
  readonly provider: string;
  readonly model: string;
  readonly modelProfileId?: string;
}

export class ConversationStore {
  private readonly cache = new Map<ConversationId, StoredConversation>();

  private constructor(
    private readonly state: StateDirectory,
    private readonly index: ConversationIndex,
    private readonly config: ConversationStoreOptions,
  ) {}

  static async open(state: StateDirectory, config: ConversationStoreOptions): Promise<ConversationStore> {
    const index = await ConversationIndex.open(state.workspaceDir);
    return new ConversationStore(state, index, config);
  }

  async create(title?: string): Promise<StoredConversation> {
    const conversationId = formatConversationId(randomUUID());
    const createdAt = new Date().toISOString();
    const conversation: StoredConversation = {
      conversationId,
      workspaceKey: this.state.workspaceKey,
      createdAt,
      storageVersion: STORAGE_VERSION,
      title: title ?? null,
      titleSource: title === undefined ? "auto" : "manual",
      archived: false,
      sessions: [],
    };
    await mkdir(this.conversationDir(conversationId), { recursive: true });
    await this.save(conversation);
    await this.index.append({ type: "created", conversationId, workspaceKey: this.state.workspaceKey, createdAt });
    if (title !== undefined) await this.index.append({ type: "titled", conversationId, title, titleSource: "manual" });
    return conversation;
  }

  async get(conversationId: ConversationId): Promise<StoredConversation | undefined> {
    if (this.index.get(conversationId) === undefined) return undefined;
    const cached = this.cache.get(conversationId);
    if (cached !== undefined) return cached;
    const raw: unknown = JSON.parse(await readFile(this.conversationFile(conversationId), "utf8"));
    const conversation = parseConversation(raw, conversationId, this.state.workspaceKey);
    this.cache.set(conversationId, conversation);
    return conversation;
  }

  async list(options: { readonly archived?: boolean } = {}): Promise<readonly ListedConversation[]> {
    const archived = options.archived ?? false;
    return (await this.index.list()).filter((entry) => entry.archived === archived);
  }

  async activate(
    conversationId: ConversationId,
    selection: ConversationStoreOptions = this.config,
  ): Promise<ActivatedSession> {
    const conversation = await this.require(conversationId);
    if (conversation.archived) throw new Error("Cannot activate an archived conversation");
    const latest = conversation.sessions.at(-1);
    if (
      latest?.provider === selection.provider &&
      latest.model === selection.model &&
      latest.modelProfileId === selection.modelProfileId
    ) {
      return { ...latest, isNewSession: false };
    }
    const session: StoredSession = {
      sessionId: formatSessionId(randomUUID()),
      ordinal: conversation.sessions.length + 1,
      provider: selection.provider,
      model: selection.model,
      ...(selection.modelProfileId === undefined ? {} : { modelProfileId: selection.modelProfileId }),
      createdAt: new Date().toISOString(),
    };
    await mkdir(join(this.conversationDir(conversationId), "sessions"), { recursive: true });
    await this.save({ ...conversation, sessions: [...conversation.sessions, session] });
    return { ...session, isNewSession: true };
  }

  sessionPath(conversationId: ConversationId, sessionId: SessionId): string {
    const conversation = this.cache.get(conversationId);
    if (conversation === undefined) throw new Error("CONVERSATION_NOT_OPEN");
    const session = conversation.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (session === undefined) throw new Error("SESSION_NOT_IN_CONVERSATION");
    const folder = conversation.archived ? "archived" : "sessions";
    return join(
      this.conversationDir(conversationId),
      folder,
      `${String(session.ordinal).padStart(6, "0")}-${sessionId}.jsonl`,
    );
  }

  async rename(conversationId: ConversationId, title: string): Promise<StoredConversation> {
    const conversation = await this.require(conversationId);
    const trimmed = title.trim();
    if (trimmed.length === 0) throw new Error("Conversation title cannot be empty");
    const updated = { ...conversation, title: trimmed, titleSource: "manual" as const };
    await this.save(updated);
    await this.index.append({ type: "titled", conversationId, title: trimmed, titleSource: "manual" });
    return updated;
  }

  async maybeAutoTitle(conversationId: ConversationId, input: string): Promise<StoredConversation> {
    const conversation = await this.require(conversationId);
    if (conversation.title !== null || conversation.titleSource === "manual") return conversation;
    const title = deriveTitle(input);
    if (title === null) return conversation;
    const updated = { ...conversation, title, titleSource: "auto" as const };
    await this.save(updated);
    await this.index.append({ type: "titled", conversationId, title, titleSource: "auto" });
    return updated;
  }

  async archive(conversationId: ConversationId): Promise<StoredConversation> {
    const conversation = await this.require(conversationId);
    if (conversation.archived) return conversation;
    await moveSessionFiles(this.conversationDir(conversationId), "sessions", "archived");
    const updated = { ...conversation, archived: true };
    await this.save(updated);
    await this.index.append({ type: "archived", conversationId });
    return updated;
  }

  async unarchive(conversationId: ConversationId): Promise<StoredConversation> {
    const conversation = await this.require(conversationId);
    if (!conversation.archived) return conversation;
    await moveSessionFiles(this.conversationDir(conversationId), "archived", "sessions");
    const updated = { ...conversation, archived: false };
    await this.save(updated);
    await this.index.append({ type: "unarchived", conversationId });
    return updated;
  }

  async delete(conversationId: ConversationId): Promise<void> {
    const conversation = await this.require(conversationId);
    if (!conversation.archived) throw new Error("Archive the conversation before deleting it");
    await rm(this.conversationDir(conversationId), { recursive: true, force: true });
    await this.index.append({ type: "deleted", conversationId });
    this.cache.delete(conversationId);
  }

  private async require(conversationId: ConversationId): Promise<StoredConversation> {
    const conversation = await this.get(conversationId);
    if (conversation === undefined) throw new Error(`Conversation not found: ${conversationId}`);
    return conversation;
  }

  private async save(conversation: StoredConversation): Promise<void> {
    const path = this.conversationFile(conversation.conversationId);
    const temp = `${path}.tmp-${randomUUID()}`;
    await writeFile(temp, `${JSON.stringify(conversation)}\n`);
    await rename(temp, path);
    this.cache.set(conversation.conversationId, conversation);
  }

  private conversationDir(conversationId: ConversationId): string {
    return join(this.state.workspaceDir, "conversations", conversationId);
  }

  private conversationFile(conversationId: ConversationId): string {
    return join(this.conversationDir(conversationId), "conversation.json");
  }
}

function parseConversation(raw: unknown, expectedId: ConversationId, workspaceKey: string): StoredConversation {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid conversation metadata");
  const value = raw as Record<string, unknown>;
  if (parseId("conv", String(value.conversationId)) !== expectedId || value.workspaceKey !== workspaceKey) {
    throw new Error("Conversation metadata identity mismatch");
  }
  if (!Array.isArray(value.sessions)) throw new Error("Invalid conversation sessions");
  const sessions = value.sessions.map((session: unknown, index: number) => {
    if (session === null || typeof session !== "object" || Array.isArray(session))
      throw new Error("Invalid session metadata");
    const item = session as Record<string, unknown>;
    if (
      item.ordinal !== index + 1 ||
      typeof item.provider !== "string" ||
      typeof item.model !== "string" ||
      typeof item.createdAt !== "string"
    ) {
      throw new Error("Invalid session metadata");
    }
    return {
      sessionId: parseId("sess", String(item.sessionId)),
      ordinal: index + 1,
      provider: item.provider,
      model: item.model,
      ...(typeof item.modelProfileId === "string" ? { modelProfileId: item.modelProfileId } : {}),
      createdAt: item.createdAt,
    };
  });
  if (
    typeof value.createdAt !== "string" ||
    typeof value.archived !== "boolean" ||
    (value.title !== null && typeof value.title !== "string")
  ) {
    throw new Error("Invalid conversation metadata");
  }
  return {
    conversationId: expectedId,
    workspaceKey,
    createdAt: value.createdAt,
    storageVersion: STORAGE_VERSION,
    title: value.title,
    titleSource: value.titleSource === "manual" ? "manual" : "auto",
    archived: value.archived,
    sessions,
  };
}

async function moveSessionFiles(conversationDir: string, from: string, to: string): Promise<void> {
  const source = join(conversationDir, from);
  let names: string[];
  try {
    names = await readdir(source);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (names.length === 0) return;
  const target = join(conversationDir, to);
  await mkdir(target, { recursive: true });
  for (const name of names) await rename(join(source, name), join(target, name));
}

function deriveTitle(input: string): string | null {
  const line = input
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (line === undefined) return null;
  const cleaned = line
    .replace(/@\S+/g, "")
    .replace(/[`*_>#[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= 60) return cleaned || null;
  const boundary = cleaned.lastIndexOf(" ", 59);
  return `${cleaned.slice(0, boundary > 20 ? boundary : 59).trimEnd()}…`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
