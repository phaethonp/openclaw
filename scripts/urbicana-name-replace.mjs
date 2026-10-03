#!/usr/bin/env node
// Replaces the CamelCase product name inside text a person or a model reads.
// Identifiers, the command, paths, and OPENCLAW_* settings are left alone.
// A line marked urbicana-legacy still matches transcripts written before the rename.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SKIP_DIR = new Set([
  "node_modules",
  "dist",
  ".git",
  ".artifacts",
  "__snapshots__",
  "fixtures",
]);
const CODE = /\.(ts|mts|tsx|mjs|js)$/;
const PROSE = /\.(md|html|json|webmanifest)$/;

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(entry.name) || entry.name === ".i18n") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function isWord(ch) {
  return /[A-Za-z0-9_]/.test(ch);
}

function replaceWord(word, rest) {
  if (word === "OpenClaw" && !rest.startsWith(" Foundation")) return "Urbicana";
  return word;
}

function transformProse(text) {
  return text
    .split("\n")
    .map((line) => {
      if (line.includes("urbicana-legacy") || line.includes("OpenClaw Foundation")) return line;
      let out = "";
      let word = "";
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (isWord(ch)) {
          word += ch;
          continue;
        }
        out += replaceWord(word, line.slice(i));
        word = "";
        out += ch;
      }
      return out + replaceWord(word, "");
    })
    .join("\n");
}

function transformCode(src) {
  const skipLine = src
    .split("\n")
    .map((line) => line.includes("urbicana-legacy") || line.includes("OpenClaw Foundation"));
  let mode = "code";
  const stack = [];
  let exprBrace = 0;
  let inExpr = false;
  let line = 0;
  let out = "";
  let word = "";

  function flush(rest) {
    if (!word) return;
    const replacing = mode !== "code" && !skipLine[line];
    out += replacing ? replaceWord(word, rest) : word;
    word = "";
  }

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "\n") {
      flush("");
      out += ch;
      line += 1;
      if (mode === "linecomment") mode = "code";
      continue;
    }

    if (mode === "code") {
      flush("");
      if (ch === "/" && next === "/") {
        mode = "linecomment";
        out += "//";
        i += 1;
        continue;
      }
      if (ch === "/" && next === "*") {
        mode = "blockcomment";
        out += "/*";
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        stack.push(mode);
        mode = ch === "`" ? "tpl" : ch === "'" ? "sq" : "dq";
        out += ch;
        continue;
      }
      if (inExpr && ch === "{") {
        exprBrace += 1;
        out += ch;
        continue;
      }
      if (inExpr && ch === "}") {
        exprBrace -= 1;
        out += ch;
        if (exprBrace === 0) {
          inExpr = false;
          mode = stack.pop() ?? "code";
        }
        continue;
      }
      out += ch;
      continue;
    }

    if (mode === "blockcomment") {
      if (isWord(ch)) {
        word += ch;
        continue;
      }
      flush(src.slice(i));
      if (ch === "*" && next === "/") {
        mode = "code";
        out += "*/";
        i += 1;
        continue;
      }
      out += ch;
      continue;
    }

    if (mode === "linecomment" || mode === "sq" || mode === "dq" || mode === "tpl") {
      if (mode !== "linecomment" && ch === "\\") {
        flush("");
        const escaped =
          next === "\\" || next === "'" || next === '"' || next === "`" || next === "$";
        out += ch;
        if (escaped) {
          out += next;
          i += 1;
        }
        continue;
      }
      if (mode === "tpl" && ch === "$" && next === "{") {
        flush("");
        stack.push("tpl");
        mode = "code";
        inExpr = true;
        exprBrace = 1;
        out += "${";
        i += 1;
        continue;
      }
      const end =
        (mode === "sq" && ch === "'") ||
        (mode === "dq" && ch === '"') ||
        (mode === "tpl" && ch === "`");
      if (end) {
        flush("");
        mode = stack.pop() ?? "code";
        out += ch;
        continue;
      }
      if (isWord(ch)) {
        word += ch;
        continue;
      }
      flush(src.slice(i));
      out += ch;
      continue;
    }

    out += ch;
  }
  flush("");
  return out;
}

if (process.argv.includes("--self-test")) {
  const sample = [
    'const OpenClaw = "OpenClaw denied it";',
    "return denyTool(`OpenClaw denied native tool ${toolName}.`);",
    "/* OpenClaw Lit base */",
    'import { createOpenClawTestState } from "openclaw/plugin-sdk";',
    "const keep = `OpenClaw Foundation`;",
    'const legacy = "OpenClaw runtime"; // urbicana-legacy',
    "const prose = `hello",
    "OpenClaw continues",
    "after`;",
    'return name ? `OpenClaw is starting ${name}.` : "OpenClaw is starting a tool.";',
    "const WINDOWS_DESKTOP_ROOT = String.raw`C:\\ProgramData\\OpenClaw\\cloud-workers`;",
    ': "[OpenClaw persisted detail redacted: boundary marker removed]";',
  ].join("\n");
  const got = transformCode(sample);
  const expect = [
    'const OpenClaw = "Urbicana denied it";',
    "return denyTool(`Urbicana denied native tool ${toolName}.`);",
    "/* Urbicana Lit base */",
    'import { createOpenClawTestState } from "openclaw/plugin-sdk";',
    "const keep = `OpenClaw Foundation`;",
    'const legacy = "OpenClaw runtime"; // urbicana-legacy',
    "const prose = `hello",
    "Urbicana continues",
    "after`;",
    'return name ? `Urbicana is starting ${name}.` : "Urbicana is starting a tool.";',
    "const WINDOWS_DESKTOP_ROOT = String.raw`C:\\ProgramData\\Urbicana\\cloud-workers`;",
    ': "[Urbicana persisted detail redacted: boundary marker removed]";',
  ].join("\n");
  if (got !== expect) {
    console.error("SELF-TEST FAILED");
    console.error(got);
    process.exit(1);
  }
  console.log("self-test ok");
  process.exit(0);
}

const dry = process.argv.includes("--dry-run");
const only = process.argv.includes("--file")
  ? process.argv[process.argv.indexOf("--file") + 1]
  : null;
const tops = [
  "src",
  "extensions",
  "packages",
  "skills",
  "custodian-skills",
  "docs/reference/templates",
  "ui/src",
  "ui/index.html",
  "ui/public/manifest.webmanifest",
];
let files = 0;
let replaced = 0;
for (const top of tops) {
  const start = path.join(ROOT, top);
  if (!fs.existsSync(start)) continue;
  const list = fs.statSync(start).isDirectory() ? walk(start) : [start];
  for (const full of list) {
    if (!CODE.test(full) && !PROSE.test(full)) continue;
    if (only && !full.endsWith(only)) continue;
    const before = fs.readFileSync(full, "utf8");
    const after = CODE.test(full) ? transformCode(before) : transformProse(before);
    if (after === before) continue;
    files += 1;
    const hits = before
      .split("\n")
      .filter((line, index) => line !== after.split("\n")[index]).length;
    replaced += hits;
    if (!dry) fs.writeFileSync(full, after);
  }
}
console.log(`${dry ? "would change" : "changed"} ${files} files, ${replaced} lines`);
