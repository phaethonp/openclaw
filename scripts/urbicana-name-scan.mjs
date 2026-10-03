#!/usr/bin/env node
// Lists every remaining position where the retired product name appears in
// shipped text: string literals in code, and text assets the model or a person
// reads. Run with --list <area> to print the positions of one area.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const NAME = /\bOpenClaw\b/g;
// Positions that must keep the name: the MIT copyright notice.
const KEEP = [/OpenClaw Foundation/];
const SKIP_DIR = new Set([
  "node_modules",
  "dist",
  ".git",
  ".artifacts",
  "__snapshots__",
  "fixtures",
]);
const isTest = (f) =>
  /\.(test|e2e\.test)\.|test-helpers|test-support|test-utils|\.test-support\./.test(f);

const AREAS = [
  ["1 model: system prompt and agent loop", (f) => f.startsWith("src/agents/")],
  ["2 model: system agent (setup, custodian)", (f) => f.startsWith("src/system-agent/")],
  ["3 model: workspace templates", (f) => f.startsWith("docs/reference/templates/")],
  ["4 model: bundled skills", (f) => f.startsWith("skills/") || f.startsWith("custodian-skills/")],
  [
    "5 model: plugin manifests (tool text)",
    (f) => f.startsWith("extensions/") && f.endsWith("openclaw.plugin.json"),
  ],
  ["6 model: plugin skills and docs", (f) => f.startsWith("extensions/") && f.endsWith(".md")],
  ["7 plugins: code messages", (f) => f.startsWith("extensions/")],
  [
    "8 server: replies and channels",
    (f) => /^src\/(auto-reply|channels|gateway|realtime|talk|tts|media)/.test(f),
  ],
  ["9 server: config help and schema", (f) => f.startsWith("src/config/")],
  [
    "10 terminal: cli, commands, wizard, doctor",
    (f) => /^src\/(cli|commands|wizard|flows|daemon|tui)/.test(f),
  ],
  ["11 server: everything else", (f) => f.startsWith("src/")],
  ["12 shared packages", (f) => f.startsWith("packages/")],
  ["13 control ui", (f) => f.startsWith("ui/")],
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function positions(file, text) {
  const out = [];
  const lines = text.split("\n");
  const code = /\.(ts|mts|tsx|mjs|js)$/.test(file);
  lines.forEach((line, index) => {
    if (!NAME.test(line)) return;
    NAME.lastIndex = 0;
    if (KEEP.some((keep) => keep.test(line))) return;
    // Old transcripts still contain the previous product name. Readers keep it.
    if (line.includes("urbicana-legacy")) return;
    if (code) {
      // Only text inside quotes or template literals counts; identifiers and comments do not.
      const literals = line.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`?/g) ?? [];
      const trimmed = line.trimStart();
      const inTemplateBody =
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("*") &&
        !/^(import|export) /.test(trimmed) &&
        /^[^"'`]*\bOpenClaw\b[^"'`;{}()=]*[`.,]?$/.test(trimmed) &&
        /[a-z] [a-z]/.test(trimmed) &&
        !/:\s*OpenClaw\b/.test(trimmed);
      if (!literals.some((literal) => /\bOpenClaw\b/.test(literal)) && !inTemplateBody) return;
    }
    out.push({ line: index + 1, text: line.trim().slice(0, 150) });
  });
  return out;
}

const listArea = process.argv.includes("--list")
  ? process.argv[process.argv.indexOf("--list") + 1]
  : null;
const totals = new Map(AREAS.map(([name]) => [name, { positions: 0, files: 0, hits: [] }]));
for (const top of [
  "src",
  "extensions",
  "packages",
  "skills",
  "custodian-skills",
  "docs/reference/templates",
  "ui/src",
  "ui/index.html",
  "ui/public/manifest.webmanifest",
]) {
  const start = path.join(ROOT, top);
  if (!fs.existsSync(start)) continue;
  const files = fs.statSync(start).isDirectory() ? walk(start) : [start];
  for (const full of files) {
    const rel = path.relative(ROOT, full);
    if (
      isTest(rel) ||
      !/\.(ts|mts|tsx|mjs|js|json|md|html|webmanifest)$/.test(rel) ||
      rel.includes("/.i18n/")
    )
      continue;
    const area = AREAS.find(([, match]) => match(rel));
    if (!area) continue;
    const found = positions(rel, fs.readFileSync(full, "utf8"));
    if (!found.length) continue;
    const bucket = totals.get(area[0]);
    bucket.positions += found.length;
    bucket.files += 1;
    bucket.hits.push(...found.map((hit) => `${rel}:${hit.line}: ${hit.text}`));
  }
}
let sum = 0;
for (const [name, bucket] of totals) {
  sum += bucket.positions;
  console.log(
    `${String(bucket.positions).padStart(5)} positions  ${String(bucket.files).padStart(4)} files  ${name}`,
  );
  if (listArea && (listArea === "all" || name.startsWith(listArea + " ")))
    bucket.hits.forEach((hit) => console.log("    " + hit));
}
console.log(`${String(sum).padStart(5)} positions total`);
process.exitCode = sum === 0 ? 0 : 1;
