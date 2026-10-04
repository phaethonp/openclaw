#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Product UI overlay. Upstream sync updates ui/src. This runs before the UI
// build and puts the product delta on that tree for the compile only.
// The source files are written back afterward, so the next sync still merges
// upstream's copies. Add the next UI change as another step in overlay().
import fs from "node:fs";

const SIDEBAR = "ui/src/components/app-sidebar.ts";
const INVITE_MARKUP =
  '<div class="sidebar-shell__invite">\n            ${this.communityInvitePresentation === "shown" ? renderCommunityInviteCard(this.dismissCommunityInvite, this.context?.theme.resolvedMode ?? "dark") : nothing}\n          </div>';
const INVITE_REPLACEMENT = '<div class="sidebar-shell__invite"></div>';

export function overlay(files) {
  const sidebar = files.get(SIDEBAR);
  if (sidebar == null) {
    throw new Error(`product/ui: missing ${SIDEBAR}`);
  }
  if (sidebar.includes(INVITE_REPLACEMENT) && !sidebar.includes("renderCommunityInviteCard(")) {
    return files;
  }
  if (!sidebar.includes(INVITE_MARKUP)) {
    throw new Error(
      "product/ui: sidebar invitation markup changed upstream. Update product/ui/build.mjs before building the UI.",
    );
  }
  const next = new Map(files);
  next.set(SIDEBAR, sidebar.replace(INVITE_MARKUP, INVITE_REPLACEMENT));
  return next;
}

function readTree() {
  return new Map([[SIDEBAR, fs.readFileSync(SIDEBAR, "utf8")]]);
}

function writeChanged(before, after) {
  const written = [];
  for (const [path, text] of after) {
    if (text !== before.get(path)) {
      fs.writeFileSync(path, text);
      written.push(path);
    }
  }
  return written;
}

function restore(before, written) {
  for (const path of written) {
    fs.writeFileSync(path, before.get(path));
  }
}

if (process.argv[1] && process.argv[1].endsWith("build.mjs")) {
  if (process.argv.includes("--self-test")) {
    const before = readTree();
    const after = overlay(before);
    const sidebar = after.get(SIDEBAR);
    if (sidebar.includes("renderCommunityInviteCard(") || !sidebar.includes(INVITE_REPLACEMENT)) {
      throw new Error("product/ui: self-test did not drop the sidebar invitation");
    }
    if (fs.readFileSync(SIDEBAR, "utf8") !== before.get(SIDEBAR)) {
      throw new Error("product/ui: self-test wrote the worktree");
    }
    process.exit(0);
  }

  const before = readTree();
  const after = overlay(before);
  const written = writeChanged(before, after);
  let status = 1;
  try {
    const child = spawnSync(
      process.execPath,
      ["scripts/ui.js", "build", ...process.argv.slice(2)],
      {
        stdio: "inherit",
      },
    );
    status = child.status ?? 1;
  } finally {
    restore(before, written);
  }
  process.exit(status);
}
