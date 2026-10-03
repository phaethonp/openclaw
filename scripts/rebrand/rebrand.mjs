#!/usr/bin/env node
import { execSync } from "node:child_process";
// Urbicana rebrand: inventory every occurrence of the old name, match each one
// to a rule in rename-map.json, apply the replace rules, prove the result.
//
//   node scripts/rebrand/rebrand.mjs inventory [--quiet] [--ledger <file>]
//   node scripts/rebrand/rebrand.mjs match [--rule <id>] [--area <prefix>]
//   node scripts/rebrand/rebrand.mjs apply --rule <id> [--area <prefix>] [--dry-run]
//   node scripts/rebrand/rebrand.mjs check
//
// Nothing is changed by inventory, match or check. apply changes only the
// occurrences the named rule explains, and refuses if a paired file is missing.
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..", "..");
const MAP = JSON.parse(fs.readFileSync(path.join(HERE, "rename-map.json"), "utf8"));
const args = process.argv.slice(2);
const command = args[0];
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const flag = (name) => args.includes(name);

const FORMS = Object.keys(MAP.forms).sort((a, b) => b.length - a.length);
const FORM_RE = new RegExp(`(${FORMS.map((f) => f.replace(/[-_]/g, "\\$&")).join("|")})`, "g");
const CODE_EXT = /\.(ts|mts|cts|tsx|js|mjs|cjs)$/;
const TEXT_EXT = /\.(md|txt|html|json|webmanifest|yml|yaml|css|toml)$/;
const isTest = (f) =>
  /\.(test|e2e\.test|spec)\./.test(f) ||
  /(^|\/)(test-helpers|test-support|test-utils|__tests__)\//.test(f);

// ---------- job 1: inventory ----------

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (MAP.skip.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Per-character state machine over a code file: where is each offset? */
function codeRegions(text) {
  const regions = new Array(text.length).fill("identifier");
  let i = 0;
  const n = text.length;
  const mark = (from, to, kind) => regions.fill(kind, from, to);
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      mark(i, stop, "comment");
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      mark(i, stop, "comment");
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") {
        if (text[j] === "\\") j += 1;
        j += 1;
      }
      mark(i, Math.min(j + 1, n), "text");
      i = j + 1;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (depth === 0 && text[j] === "`") break;
        if (text[j] === "$" && text[j + 1] === "{") {
          depth += 1;
          j += 2;
          continue;
        }
        if (depth > 0 && text[j] === "}") {
          depth -= 1;
          j += 1;
          continue;
        }
        if (depth === 0) regions[j] = "text";
        j += 1;
      }
      regions[i] = "text";
      if (j < n) regions[j] = "text";
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return regions;
}

/** Refine a text-ish occurrence by what surrounds it. */
function refineKind(baseKind, line, col, form) {
  const before = line.slice(Math.max(0, col - 60), col);
  const after = line.slice(col + form.length, col + form.length + 60);
  const around = before + form + after;
  if (/https?:\/\/[^\s"'`)]*$/.test(before) || /^[^\s"'`]*\.(ai|com|org|dev)\b/.test(form + after))
    return "url";
  if (/(^|[^A-Za-z0-9_])@$/.test(before) && /^\/[a-z0-9-]/.test(after)) return "package";
  if (
    /^\/(plugin-sdk|gateway-protocol|[a-z0-9-]+)(\b|["'`/])/.test(after) &&
    form === "openclaw" &&
    /["'`\s(]$/.test(before)
  )
    return "package";
  if (/[A-Z0-9_]*$/.test(before) && /^_[A-Z0-9_]+/.test(after) && form === "OPENCLAW") return "env";
  if (/(^|[\s"'`(=:])~?\/?\.?$/.test(before) && (/^\.json\b/.test(after) || /\.$/.test(before)))
    return "path";
  if (
    /\.$/.test(before) ||
    /^(\.json|\.plugin\.json|\.mjs|\.js|\.ts|\.config|\.db|\.sqlite|\.log|\/)/.test(after)
  )
    return "path";
  if (
    form === "openclaw" &&
    /^\s+(gateway|doctor|onboard|config|fleet|agent|agents|channels|models|plugins|skills|cron|update|login|logout|status|daemon|mcp|memory|message|nodes|node|pairing|approvals|dashboard|health|logs|configure|connect|docs|setup|run|serve|init|backup|browser|devices|tui|chat|infer|capability|audit|acp|completion|help|--?[a-z])/.test(
      after,
    )
  )
    return "command";
  if (
    form === "openclaw" &&
    /(^|[\s"'`])$/.test(before) &&
    /^($|[\s"'`.,;:)])/.test(after) &&
    /(run|type|install|command|cli|binary|invoke|use|via|with|the)\s*[`"']?$/i.test(before.trim())
  )
    return "command";
  if (form === "openclaw" && /[`]$/.test(before) && /^[`]/.test(after)) return "command";
  // names inside strings that code depends on: each kind is its own paired step
  if (/(from|import\(|require\()\s*["'`][^"'`]*$/.test(before)) return "module-path";
  if (
    /["'`][^"'`]*\/[^"'`]*$/.test(before) &&
    form === "openclaw" &&
    /^[-_a-z0-9.]*\.(js|mjs|ts|json)\b/.test(after)
  )
    return "module-path";
  if (/<\/?$/.test(before) && form === "openclaw" && /^-[a-z0-9-]+/.test(after))
    return "custom-element";
  if (
    /(createElement|locator|querySelector|querySelectorAll|closest|customElements\.(get|define|whenDefined)|tagName === |is\()\s*\(?["'`]$/.test(
      before,
    ) &&
    /^-[a-z0-9-]+/.test(after)
  )
    return "custom-element";
  if (
    /--$/.test(before) ||
    /@keyframes\s+$/.test(before) ||
    (/\.$/.test(before) && /^-[a-z0-9-]+/.test(after))
  )
    return "css-token";
  if (/^\.[A-Za-z]/.test(after) && form === "openclaw") return "dotted-key";
  if (/^:[a-z]/.test(after) && form === "openclaw") return "event-name";
  if (/\[$/.test(before) && /^\]/.test(after)) return "log-prefix";
  if (
    /\/tmp\/$/.test(before) ||
    /^-[a-z0-9-]*(test|tests|tmp|temp)\b/.test(after) ||
    /mkdtemp/.test(before)
  )
    return "tmp-dir";
  if (/["'`]$/.test(before) && /^["'`]/.test(after) && form === "openclaw") return "id-literal";
  if (/^-[a-z0-9]/.test(after) && form === "openclaw") return "hyphenated-name";
  if (/[A-Za-z0-9_$]$/.test(before) || /^[A-Za-z0-9_$]/.test(after)) return "identifier";
  return baseKind;
}

function inventory() {
  const ledger = [];
  for (const root of MAP.roots) {
    const start = path.join(ROOT, root);
    if (!fs.existsSync(start)) continue;
    const files = fs.statSync(start).isDirectory() ? [...walk(start)] : [start];
    for (const full of files) {
      const rel = path.relative(ROOT, full);
      if (isTest(rel)) continue;
      const code = CODE_EXT.test(rel);
      if (!code && !TEXT_EXT.test(rel)) continue;
      const text = fs.readFileSync(full, "utf8");
      if (!FORM_RE.test(text)) continue;
      FORM_RE.lastIndex = 0;
      const regions = code ? codeRegions(text) : null;
      const lineStarts = [0];
      for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") lineStarts.push(i + 1);
      let m;
      while ((m = FORM_RE.exec(text))) {
        const offset = m.index;
        const form = m[0];
        // word boundary for the whole-word forms; CamelCase glued to a capital (OpenClawKit) is an identifier
        let lineIdx = lineStarts.findIndex(
          (s, i) => s <= offset && (lineStarts[i + 1] ?? Infinity) > offset,
        );
        if (lineIdx === -1) lineIdx = lineStarts.length - 1;
        const lineText = text.slice(
          lineStarts[lineIdx],
          (lineStarts[lineIdx + 1] ?? text.length + 1) - 1,
        );
        const col = offset - lineStarts[lineIdx];
        let kind = code ? regions[offset] : "prose";
        if (kind === "comment") {
          const b = lineText.slice(Math.max(0, col - 1), col);
          const a = lineText.slice(col + form.length, col + form.length + 1);
          if (/[A-Za-z0-9_$]/.test(b) || /[A-Za-z0-9_$]/.test(a)) kind = "identifier";
          else if (b === "/" || a === "/") kind = "path";
        } else kind = refineKind(kind, lineText, col, form);
        ledger.push({
          file: rel,
          line: lineIdx + 1,
          col: col + 1,
          form,
          kind,
          text: lineText.trim().slice(0, 200),
        });
      }
    }
  }
  return ledger;
}

// ---------- job 2: match ----------

function ruleMatches(rule, occ) {
  const m = rule.match;
  if (m.lineContains) return occ.text.includes(m.lineContains);
  if (m.literal) {
    const lit = m.literal;
    const start = occ.col - 1;
    // the literal must contain this occurrence's form at some offset of the line
    const idx = occ.text.indexOf(lit);
    if (idx === -1) return false;
    const rawLine = occ.rawLine ?? occ.text;
    return rawLine.includes(lit);
  }
  if (m.form && m.form !== occ.form) return false;
  if (m.kind && !m.kind.includes(occ.kind)) return false;
  if (m.scope && !m.scope.some((p) => occ.file.startsWith(p))) return false;
  return Boolean(m.form || m.kind || m.scope);
}

function matchAll(ledger) {
  for (const occ of ledger) {
    occ.rule = MAP.rules.find((rule) => ruleMatches(rule, occ))?.id ?? null;
    occ.action = occ.rule ? MAP.rules.find((r) => r.id === occ.rule).action : "UNMATCHED";
  }
  return ledger;
}

function summarize(ledger, { quiet } = {}) {
  const byRule = new Map();
  for (const occ of ledger) {
    const key = occ.rule ?? "UNMATCHED";
    byRule.set(key, (byRule.get(key) ?? 0) + 1);
  }
  if (!quiet) {
    console.log(`${ledger.length} occurrences in ${new Set(ledger.map((o) => o.file)).size} files`);
    for (const [rule, n] of [...byRule].sort((a, b) => b[1] - a[1])) {
      const action = rule === "UNMATCHED" ? "stop" : MAP.rules.find((r) => r.id === rule).action;
      console.log(`${String(n).padStart(6)}  ${action.padEnd(8)} ${rule}`);
    }
  }
  return byRule.get("UNMATCHED") ?? 0;
}

// ---------- job 3: apply ----------

function apply(ledger, ruleId, { dryRun, area }) {
  const rule = MAP.rules.find((r) => r.id === ruleId);
  if (!rule) throw new Error(`no rule ${ruleId}`);
  if (rule.action !== "replace") throw new Error(`rule ${ruleId} is a keep rule`);
  const targets = ledger.filter((o) => o.rule === ruleId && (!area || o.file.startsWith(area)));
  const byFile = new Map();
  for (const occ of targets) byFile.set(occ.file, [...(byFile.get(occ.file) ?? []), occ]);
  if (rule.paired) {
    const missing = rule.paired.filter(
      (f) =>
        !byFile.has(f) &&
        fs.existsSync(path.join(ROOT, f)) &&
        fs.readFileSync(path.join(ROOT, f), "utf8").includes(rule.match.literal ?? "\u0000"),
    );
    if (missing.length)
      throw new Error(`rule ${ruleId}: paired files not covered: ${missing.join(", ")}`);
  }
  let changed = 0;
  for (const [file, occs] of byFile) {
    const full = path.join(ROOT, file);
    const lines = fs.readFileSync(full, "utf8").split("\n");
    // apply right to left on each line so columns stay valid
    for (const occ of occs.sort((a, b) => b.line - a.line || b.col - a.col)) {
      const line = lines[occ.line - 1];
      let from, to;
      if (rule.match.literal) {
        from = rule.match.literal;
        to = rule.to;
        const at = line.indexOf(from);
        if (at === -1) continue;
        lines[occ.line - 1] = line.slice(0, at) + to + line.slice(at + from.length);
      } else {
        from = occ.form;
        to = rule.to ?? MAP.forms[occ.form];
        const at = occ.col - 1;
        if (line.slice(at, at + from.length) !== from) continue;
        lines[occ.line - 1] = line.slice(0, at) + to + line.slice(at + from.length);
      }
      changed += 1;
    }
    if (!dryRun) fs.writeFileSync(full, lines.join("\n"));
  }
  console.log(
    `${dryRun ? "would change" : "changed"} ${changed} occurrences in ${byFile.size} files under rule ${ruleId}`,
  );
  return changed;
}

// ---------- job 4: check ----------

function check() {
  const unmatched = summarize(matchAll(inventory()), { quiet: true });
  const pendingReplace = matchAll(inventory()).filter((o) => o.action === "replace").length;
  console.log(`unmatched: ${unmatched}; replace rules still pending on disk: ${pendingReplace}`);
  if (unmatched) return 1;
  for (const cmd of MAP.checks) {
    if (cmd.includes("rebrand.mjs inventory")) continue;
    console.log(`$ ${cmd}`);
    try {
      execSync(cmd, { cwd: ROOT, stdio: "inherit" });
    } catch {
      return 1;
    }
  }
  return pendingReplace ? 1 : 0;
}

// ---------- main ----------

const ledger = matchAll(inventory());
if (command === "inventory") {
  const out = opt("--ledger") ?? path.join(ROOT, ".artifacts", "rebrand-ledger.tsv");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    [
      "file\tline\tcol\tform\tkind\trule\taction\ttext",
      ...ledger.map((o) =>
        [o.file, o.line, o.col, o.form, o.kind, o.rule ?? "", o.action, o.text].join("\t"),
      ),
    ].join("\n") + "\n",
  );
  const unmatched = summarize(ledger, { quiet: flag("--quiet") });
  if (!flag("--quiet")) console.log(`ledger: ${path.relative(ROOT, out)}`);
  process.exitCode = unmatched ? 1 : 0;
} else if (command === "match") {
  const ruleId = opt("--rule");
  const area = opt("--area");
  const rows = ledger.filter(
    (o) =>
      (ruleId ? (o.rule ?? "UNMATCHED") === ruleId : o.action === "UNMATCHED") &&
      (!area || o.file.startsWith(area)),
  );
  for (const o of rows) console.log(`${o.file}:${o.line}:${o.col}  [${o.kind}] ${o.text}`);
  console.log(`${rows.length} occurrences${ruleId ? ` under ${ruleId}` : " without a rule"}`);
} else if (command === "apply") {
  apply(ledger, opt("--rule"), { dryRun: flag("--dry-run"), area: opt("--area") });
} else if (command === "check") {
  process.exitCode = check();
} else {
  console.log(
    fs
      .readFileSync(new URL(import.meta.url))
      .toString()
      .split("\n")
      .slice(1, 12)
      .join("\n"),
  );
  process.exitCode = 2;
}
