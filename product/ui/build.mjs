#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Applies product/ui/changes.json onto the synced tree for the UI compile,
// then writes the source back. Add a face change to changes.json. Do not edit
// upstream files to keep a product string.
import fs from "node:fs";

const MANIFEST = "product/ui/changes.json";

export function loadChanges(text = fs.readFileSync(MANIFEST, "utf8")) {
  const manifest = JSON.parse(text);
  if (!Array.isArray(manifest.changes)) {
    throw new Error("product/ui: changes.json has no changes list");
  }
  return manifest.changes;
}

export function applyChanges(files, changes) {
  const next = new Map(files);
  for (const change of changes) {
    const text = next.get(change.file);
    if (text == null) {
      throw new Error(`product/ui: ${change.id} is missing ${change.file}`);
    }
    const matches = text.split(change.find).length - 1;
    if (matches === 0) {
      if (!text.includes(change.replace)) {
        throw new Error(
          `product/ui: ${change.id} no longer matches ${change.file}. Update product/ui/changes.json.`,
        );
      }
      continue;
    }
    if (matches !== 1) {
      throw new Error(`product/ui: ${change.id} matched ${matches} times in ${change.file}`);
    }
    next.set(change.file, text.replace(change.find, change.replace));
  }
  return next;
}

function readTree(changes) {
  const files = new Map();
  for (const change of changes) {
    if (!files.has(change.file)) {
      files.set(change.file, fs.readFileSync(change.file, "utf8"));
    }
  }
  return files;
}

function writeChanged(before, after) {
  const written = [];
  for (const [file, text] of after) {
    if (text !== before.get(file)) {
      fs.writeFileSync(file, text);
      written.push(file);
    }
  }
  return written;
}

function restore(before, written) {
  for (const file of written) {
    fs.writeFileSync(file, before.get(file));
  }
}

function assertApplied(files, changes) {
  for (const change of changes) {
    const text = files.get(change.file);
    if (text.includes(change.find) || !text.includes(change.replace)) {
      throw new Error(`product/ui: ${change.id} did not apply`);
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith("build.mjs")) {
  const changes = loadChanges();
  if (process.argv.includes("--list")) {
    for (const change of changes) {
      process.stdout.write(`${change.id}\t${change.file}\t${change.why}\n`);
    }
    process.exit(0);
  }

  const before = readTree(changes);
  const after = applyChanges(before, changes);
  if (process.argv.includes("--self-test")) {
    assertApplied(after, changes);
    for (const [file, text] of before) {
      if (fs.readFileSync(file, "utf8") !== text) {
        throw new Error(`product/ui: self-test wrote ${file}`);
      }
    }
    process.exit(0);
  }

  const written = writeChanged(before, after);
  let status = 1;
  try {
    const child = spawnSync(
      process.execPath,
      ["scripts/ui.js", "build", ...process.argv.slice(2)],
      { stdio: "inherit" },
    );
    status = child.status ?? 1;
  } finally {
    restore(before, written);
  }
  process.exit(status);
}
