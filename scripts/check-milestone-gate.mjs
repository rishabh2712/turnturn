#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
const metaPath = join(changeDir, ".openspec.yaml");

// Two gate tiers, per openspec/project.md "Required Design Phase".
//
// design.md is required by BOTH tiers -- every change has a design, reviewed
// before implementation starts.
//
//   full     - contract-altering changes: protocol types, durable record formats,
//              persisted policy semantics, public package APIs. Requires the whole
//              ritual: per-reference research, user interview, neutral challenge,
//              synthesis, and a design.md that references all three inputs.
//   standard - everything else. Requires at least one non-empty research file plus
//              design.md and tasks.md.
//
// Tier is declared as `gate: full` in the change's .openspec.yaml. Absent that
// field the tier is `standard`, so a new change is never blocked by paperwork it
// was not asked for. Contract-altering changes must opt in explicitly.
const FULL_GATE_FILES = [
  "research/user-interview.md",
  "research/codex.md",
  "research/gemini-cli.md",
  "research/agentic-code.md",
  "research/neutral-challenge.md",
  "research/synthesis.md"
];
const FULL_GATE_DESIGN_PHRASES = ["user interview", "neutral challenge", "synthesis"];

const failures = [];

// Initialized before the changeDir check so reportAndExit can always label the tier.
let tier = "standard";

if (!existsSync(changeDir)) {
  failures.push(`Missing OpenSpec change: openspec/changes/${changeId}`);
  reportAndExit();
}

tier = readGateTier(metaPath);

if (tier === "full") {
  for (const relativePath of FULL_GATE_FILES) {
    const path = join(changeDir, relativePath);
    if (!existsSync(path)) {
      failures.push(`Missing required design-gate file: ${relativePath}`);
      continue;
    }
    if (statSync(path).size === 0) {
      failures.push(`Required design-gate file is empty: ${relativePath}`);
    }
  }
} else {
  const researchFiles = listResearchFiles(join(changeDir, "research"));
  if (researchFiles.length === 0) {
    failures.push(
      "Missing research: standard gate needs at least one non-empty file in research/ naming what is borrowed and from which reference file"
    );
  }
}

if (!existsSync(tasksPath)) {
  failures.push("Missing tasks.md");
} else {
  const tasks = readFileSync(tasksPath, "utf8");
  const designGate = section(tasks, "Design Gate");

  // A Design Gate section is mandatory only for the full tier. When a standard-tier
  // change declares one anyway, it is still enforced.
  if (!designGate) {
    if (tier === "full") failures.push("tasks.md must contain a ## Design Gate section");
  } else {
    const unchecked = checklist(designGate).filter(item => !item.checked);
    for (const item of unchecked) failures.push(`Incomplete Design Gate item: ${item.text}`);
  }

  const implementation = section(tasks, "Implementation Tasks");
  if (implementation && designGate && checklist(designGate).some(item => !item.checked)) {
    for (const item of checklist(implementation).filter(entry => entry.checked)) {
      failures.push(`Implementation task checked before Design Gate is complete: ${item.text}`);
    }
  }
}

if (!existsSync(designPath)) {
  failures.push("Missing design.md");
} else if (tier === "full") {
  const design = readFileSync(designPath, "utf8").toLowerCase();
  for (const phrase of FULL_GATE_DESIGN_PHRASES) {
    if (!design.includes(phrase)) {
      failures.push(`design.md must reference ${phrase} input`);
    }
  }
}

reportAndExit();

function readGateTier(path) {
  if (!existsSync(path)) return "standard";
  const match = /^gate:\s*(\S+)\s*$/m.exec(readFileSync(path, "utf8"));
  if (!match) return "standard";
  const declared = match[1].toLowerCase();
  if (declared === "full" || declared === "standard") return declared;
  failures.push(`Unknown gate tier in .openspec.yaml: ${match[1]} (expected "full" or "standard")`);
  return "standard";
}

function listResearchFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".md"))
    .map(entry => join(dir, entry.name))
    .filter(path => statSync(path).size > 0);
}

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
    stdout.write(`Milestone design gate passed: ${changeId} (${tierLabel()})\n`);
    exit(0);
  }
  stderr.write(`Milestone design gate failed: ${changeId} (${tierLabel()})\n`);
  for (const failure of failures) stderr.write(`- ${failure}\n`);
  exit(1);
}

function tierLabel() {
  return `${tier} gate`;
}
