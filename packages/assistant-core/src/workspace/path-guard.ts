import fs from "node:fs/promises";
import path from "node:path";
import { toolError } from "./tool-results.js";

export interface WorkspacePathGuardOptions {
  readonly roots: readonly string[];
  readonly defaultRoot?: string;
}

export interface ConfinedPath {
  readonly root: string;
  readonly absolute: string;
  readonly relative: string;
}

export class WorkspacePathGuard {
  private readonly rootsPromise: Promise<readonly string[]>;

  constructor(private readonly options: WorkspacePathGuardOptions) {
    this.rootsPromise = normalizeRoots(options.roots);
  }

  async existingFile(value: string): Promise<ConfinedPath> {
    const confined = await this.existing(value);
    const stats = await fs.stat(confined.absolute);
    if (!stats.isFile()) throw toolError("NOT_FILE", "Path is not a file");
    return confined;
  }

  async existingDirectory(value: string): Promise<ConfinedPath> {
    const confined = await this.existing(value);
    const stats = await fs.stat(confined.absolute);
    if (!stats.isDirectory()) throw toolError("NOT_DIRECTORY", "Path is not a directory");
    return confined;
  }

  async forWrite(value: string): Promise<ConfinedPath> {
    const candidate = path.resolve(await this.defaultRoot(), value);
    const ancestor = await nearestExistingAncestor(path.dirname(candidate));
    const confinedAncestor = await this.confineReal(await fs.realpath(ancestor));
    const absolute = path.join(confinedAncestor.absolute, path.relative(ancestor, candidate));
    return { root: confinedAncestor.root, absolute, relative: toPosix(path.relative(confinedAncestor.root, absolute)) };
  }

  private async existing(value: string): Promise<ConfinedPath> {
    const candidate = path.resolve(await this.defaultRoot(), value);
    return await this.confineReal(await fs.realpath(candidate));
  }

  private async confineReal(real: string): Promise<ConfinedPath> {
    for (const root of await this.rootsPromise) {
      if (isInside(root, real)) {
        return { root, absolute: real, relative: toPosix(path.relative(root, real)) || "." };
      }
    }
    throw toolError("PATH_OUTSIDE_WORKSPACE", "Path resolves outside the configured workspace roots");
  }

  private async defaultRoot(): Promise<string> {
    if (this.options.defaultRoot) return path.resolve(this.options.defaultRoot);
    const [root] = await this.rootsPromise;
    if (!root) throw toolError("NO_WORKSPACE_ROOT", "No workspace root configured");
    return root;
  }
}

async function normalizeRoots(roots: readonly string[]): Promise<readonly string[]> {
  const normalized = await Promise.all(roots.map((root) => fs.realpath(path.resolve(root))));
  return [...new Set(normalized)];
}

async function nearestExistingAncestor(start: string): Promise<string> {
  let cursor = start;
  while (true) {
    try {
      const stats = await fs.stat(cursor);
      if (!stats.isDirectory()) throw toolError("NOT_DIRECTORY", "Nearest existing write ancestor is not a directory");
      return cursor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}
