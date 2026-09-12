import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const STORAGE_VERSION = 1;

export interface OpenStateDirectoryOptions {
  readonly workspace: string;
  readonly stateRoot?: string;
  readonly port?: number;
}

export interface StateDirectory {
  readonly root: string;
  readonly workspaceDir: string;
  readonly workspaceKey: string;
  readonly workspacePath: string;
  readonly createdAt: string;
  close(): Promise<void>;
}

interface LockData {
  readonly pid: number;
  readonly startedAt: string;
  readonly port: number | null;
  readonly nonce: string;
}

export async function openStateDirectory(options: OpenStateDirectoryOptions): Promise<StateDirectory> {
  const workspacePath = await realpath(resolve(options.workspace));
  const root = resolve(options.stateRoot ?? defaultStateRoot());
  if (inside(workspacePath, root)) throw new Error("State directory must be outside the workspace");

  const metaPath = join(root, "meta.json");
  const existingVersion = await readStorageVersion(metaPath);
  if (existingVersion !== undefined && existingVersion > STORAGE_VERSION) {
    throw new Error(`State directory has storage version ${existingVersion}; this server supports ${STORAGE_VERSION}`);
  }
  if (existingVersion !== undefined && existingVersion < STORAGE_VERSION) {
    throw new Error(`No migration from storage version ${existingVersion} to ${STORAGE_VERSION}`);
  }

  await mkdir(root, { recursive: true });
  const releaseLock = await acquireLock(join(root, ".lock"), options.port);
  try {
    if (existingVersion === undefined) {
      await writeFile(metaPath, `${JSON.stringify({ storageVersion: STORAGE_VERSION })}\n`, { flag: "wx" });
    }
    const workspaceKey = createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
    const workspaceDir = join(root, "workspaces", workspaceKey);
    await mkdir(workspaceDir, { recursive: true });
    const workspaceFile = join(workspaceDir, "workspace.json");
    const existingWorkspace = await readOptionalJson(workspaceFile);
    if (existingWorkspace !== undefined && existingWorkspace.path !== workspacePath) {
      throw new Error(`Workspace key collision for ${workspaceKey}`);
    }
    const createdAt =
      typeof existingWorkspace?.createdAt === "string" ? existingWorkspace.createdAt : new Date().toISOString();
    if (existingWorkspace === undefined) {
      await writeFile(workspaceFile, `${JSON.stringify({ path: workspacePath, createdAt })}\n`, { flag: "wx" });
    }
    return { root, workspaceDir, workspaceKey, workspacePath, createdAt, close: releaseLock };
  } catch (error) {
    await releaseLock();
    throw error;
  }
}

function defaultStateRoot(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  return join(xdgStateHome === undefined ? join(homedir(), ".local", "state") : xdgStateHome, "turnturn");
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function readStorageVersion(path: string): Promise<number | undefined> {
  const meta = await readOptionalJson(path);
  if (meta === undefined) return undefined;
  if (!Number.isSafeInteger(meta.storageVersion) || (meta.storageVersion as number) < 1) {
    throw new Error("Invalid state directory storage version");
  }
  return meta.storageVersion as number;
}

async function readOptionalJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error(`Invalid JSON object in ${path}`);
    return value as Record<string, unknown>;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function acquireLock(path: string, port: number | undefined): Promise<() => Promise<void>> {
  const lock: LockData = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    port: port ?? null,
    nonce: randomUUID(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(lock)}\n`);
      } finally {
        await handle.close();
      }
      return async () => {
        const current = await readOptionalJson(path);
        if (current?.nonce === lock.nonce) await unlink(path);
      };
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const holder = await readOptionalJson(path);
      const pid = holder?.pid;
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1 || processAlive(pid)) {
        throw new Error(`State directory lock is already held by pid ${String(pid ?? "unknown")}`);
      }
      await unlink(path);
    }
  }
  throw new Error("Failed to acquire state directory lock");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

function isNotFound(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
