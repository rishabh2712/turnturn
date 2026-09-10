import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isInside, toPosix } from "./path-guard.js";
import { toolError } from "./tool-results.js";

export async function discoverAgentsMd(root: string, target: string): Promise<readonly string[]> {
  const rootReal = await fs.realpath(path.resolve(root));
  const targetReal = await fs.realpath(path.resolve(rootReal, target));
  if (!isInside(rootReal, targetReal)) {
    throw toolError("PATH_OUTSIDE_WORKSPACE", "Path resolves outside the workspace root");
  }
  const start = (await fs.stat(targetReal)).isDirectory() ? targetReal : path.dirname(targetReal);
  const dirs: string[] = [];
  let cursor = start;
  while (isInside(rootReal, cursor)) {
    dirs.push(cursor);
    if (cursor === rootReal) break;
    cursor = path.dirname(cursor);
  }
  dirs.reverse();
  const docs: string[] = [];
  for (const directory of dirs) {
    for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
      const candidate = path.join(directory, name);
      try {
        await fs.access(candidate, constants.R_OK);
        docs.push(await fs.readFile(candidate, "utf8"));
        break;
      } catch {
        // No scoped instruction file in this directory.
      }
    }
  }
  return docs;
}

export async function resolveFileMentions(text: string, root: string): Promise<string> {
  const rootReal = await fs.realpath(path.resolve(root));
  return await replaceAsync(text, /@([\w./-]+)/g, async (match, rawPath: string) => {
    try {
      const real = await fs.realpath(path.resolve(rootReal, rawPath));
      if (!isInside(rootReal, real)) return match;
      return `@${toPosix(path.relative(rootReal, real))}`;
    } catch {
      return match;
    }
  });
}

async function replaceAsync(
  value: string,
  expression: RegExp,
  replacer: (match: string, ...groups: string[]) => Promise<string>,
): Promise<string> {
  const matches = [...value.matchAll(expression)];
  const replacements = await Promise.all(matches.map((match) => replacer(match[0], ...match.slice(1))));
  let output = value;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    const replacement = replacements[index];
    if (!match || replacement === undefined || match.index === undefined) continue;
    output = `${output.slice(0, match.index)}${replacement}${output.slice(match.index + match[0].length)}`;
  }
  return output;
}
