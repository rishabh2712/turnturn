#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cwd, exit, stderr, stdout } from "node:process";

const changeId = process.argv[2];

if (!changeId) {
  stderr.write("Usage: pnpm check:milestone <change-id>\n");
  exit(2);
}

const root = cwd();
const changeDir = join(root, "openspec", "changes", changeId);
const tasksPath = join(changeDir, "tasks.md");
const designPath = join(changeDir, "design.md");
const requiredFiles = [
  "research/user-interview.md",
  "research/codex.md",
  "research/gemini-cli.md",
  "research/agentic-code.md",
  "research/neutral-challenge.md",
  "research/synthesis.md"
];

const failures = [];

if (!existsSync(changeDir)) {
  failures.push(`Missing OpenSpec change: openspec/changes/${changeId}`);
  reportAndExit();
}

for (const relativePath of requiredFiles) {
  const path = join(changeDir, relativePath);
  if (!existsSync(path)) {
    failures.push(`Missing required design-gate file: ${relativePath}`);
    continue;
  }
  if (statSync(path).size === 0) {
    failures.push(`Required design-gate file is empty: ${relativePath}`);
  }
}

if (!existsSync(tasksPath)) {
  failures.push("Missing tasks.md");
} else {
  const tasks = readFileSync(tasksPath, "utf8");
  const designGate = section(tasks, "Design Gate");
  if (!designGate) {
    failures.push("tasks.md must contain a ## Design Gate section");
  } else {
    const unchecked = checklist(designGate).filter(item => !item.checked);
    for (const item of unchecked) failures.push(`Incomplete Design Gate item: ${item.text}`);
  }

  const implementation = section(tasks, "Implementation Tasks");
  if (implementation && (!designGate || checklist(designGate).some(item => !item.checked))) {
    for (const item of checklist(implementation).filter(entry => entry.checked)) {
      failures.push(`Implementation task checked before Design Gate is complete: ${item.text}`);
    }
  }
}

if (!existsSync(designPath)) {
  failures.push("Missing design.md");
} else {
  const design = readFileSync(designPath, "utf8");
  for (const phrase of ["user interview", "neutral challenge", "synthesis"]) {
    if (!design.toLowerCase().includes(phrase)) {
      failures.push(`design.md must reference ${phrase} input`);
    }
  }
}

reportAndExit();

function section(markdown, title) {
  const pattern = new RegExp(`^## ${escapeRegExp(title)}\\s*$`, "m");
  const match = pattern.exec(markdown);
  if (!match || match.index === undefined) return null;
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const next = /^##\s+/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function checklist(markdown) {
  return markdown
    .split(/\r?\n/)
    .map(line => /^-\s+\[(x|X| )\]\s+(.+)$/.exec(line))
    .filter(Boolean)
    .map(match => ({ checked: match[1].toLowerCase() === "x", text: match[2].trim() }));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function reportAndExit() {
  if (failures.length === 0) {
    stdout.write(`Milestone design gate passed: ${changeId}\n`);
    exit(0);
  }
  stderr.write(`Milestone design gate failed: ${changeId}\n`);
  for (const failure of failures) stderr.write(`- ${failure}\n`);
  exit(1);
}
