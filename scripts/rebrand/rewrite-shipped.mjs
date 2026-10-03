#!/usr/bin/env node
// Rename the product in what ships, not in the source.
//
//   node scripts/rebrand/rewrite-shipped.mjs --root /app [--dry-run] [--check]
//
// Inside the built JavaScript it edits only string and template literals,
// found by parsing, so identifiers, import paths, settings and package names
// are untouched. In shipped text files (templates, skills, plugin manifests
// and docs, HTML, manifests) it edits prose. Only the exact display form
// "OpenClaw" is replaced; "openclaw", "OPENCLAW" and glued names such as
// "OpenClawKit" are not. Strings listed in exceptions.json are left alone.
// With --check it exits 1 if any display-form occurrence remains afterwards.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const acorn = require("acorn");
const HERE = path.dirname(new URL(import.meta.url).pathname);
const EXCEPTIONS = JSON.parse(
  fs.readFileSync(path.join(HERE, "exceptions.json"), "utf8"),
).literals.map((e) => e.text);
const FROM = "OpenClaw";
const TO = "Urbicana";
const FORM_RE = /\bOpenClaw\b/g;
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const root = path.resolve(opt("--root") ?? ".");
const dryRun = args.includes("--dry-run");
const check = args.includes("--check");

const CODE = /\.(js|mjs|cjs)$/;
const TEXT = /\.(md|txt|html|json|webmanifest|yml|yaml)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", ".pnpm"]);
// Only what the runtime image ships and a person or the model can read.
const ROOTS = [
  "dist",
  "skills",
  "custodian-skills",
  "docs/reference/templates",
  "extensions",
  "docker-entrypoint.mjs",
  "openclaw.mjs",
  "node-host-launcher.mjs",
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const exempt = (s) => EXCEPTIONS.some((e) => s.includes(e));
const rename = (s) => (exempt(s) ? s : s.replace(FORM_RE, TO));

/** Collect [start, end) ranges of string and template literals by parsing. */
function literalRanges(text) {
  const ranges = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node.type === "Literal" && typeof node.value === "string")
      ranges.push([node.start, node.end]);
    else if (node.type === "TemplateElement") ranges.push([node.start, node.end]);
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
      const v = node[key];
      if (v && typeof v === "object") visit(v);
    }
  };
  let ast;
  try {
    ast = acorn.parse(text, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  } catch {
    ast = acorn.parse(text, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true });
  }
  visit(ast);
  return ranges.sort((a, b) => a[0] - b[0]);
}

function rewriteCode(text) {
  if (!text.includes(FROM)) return { text, changed: 0, left: 0 };
  let out = "";
  let last = 0;
  let changed = 0;
  let left = 0;
  for (const [start, end] of literalRanges(text)) {
    out += text.slice(last, start);
    const lit = text.slice(start, end);
    const next = rename(lit);
    if (next !== lit) changed += (lit.match(FORM_RE) ?? []).length;
    else left += exempt(lit) ? 0 : (lit.match(FORM_RE) ?? []).length;
    out += next;
    last = end;
  }
  out += text.slice(last);
  return { text: out, changed, left };
}

function rewriteText(text) {
  let changed = 0;
  let left = 0;
  const out = text
    .split("\n")
    .map((line) => {
      if (!line.includes(FROM)) return line;
      if (exempt(line)) return line;
      const next = line.replace(FORM_RE, TO);
      changed += (line.match(FORM_RE) ?? []).length;
      left += (next.match(FORM_RE) ?? []).length;
      return next;
    })
    .join("\n");
  return { text: out, changed, left };
}

let files = 0;
let changedTotal = 0;
const leftovers = [];
for (const rel of ROOTS) {
  const start = path.join(root, rel);
  if (!fs.existsSync(start)) continue;
  const list = fs.statSync(start).isDirectory() ? [...walk(start)] : [start];
  for (const full of list) {
    const isCode = CODE.test(full);
    if (!isCode && !TEXT.test(full)) continue;
    const text = fs.readFileSync(full, "utf8");
    if (!text.includes(FROM)) continue;
    let result;
    try {
      result = isCode ? rewriteCode(text) : rewriteText(text);
    } catch (error) {
      leftovers.push(
        `${path.relative(root, full)}: could not parse (${error.message.split("\n")[0]})`,
      );
      continue;
    }
    if (result.changed) {
      files += 1;
      changedTotal += result.changed;
      if (!dryRun) fs.writeFileSync(full, result.text);
    }
    if (result.left) leftovers.push(`${path.relative(root, full)}: ${result.left} left`);
  }
}
console.log(
  `${dryRun ? "would rename" : "renamed"} ${changedTotal} occurrences of "${FROM}" in ${files} files under ${root}`,
);
if (leftovers.length) {
  console.log(`${leftovers.length} files still carry the display form outside the exceptions:`);
  leftovers.slice(0, 40).forEach((l) => console.log("  " + l));
}
if (check && leftovers.length) process.exitCode = 1;
