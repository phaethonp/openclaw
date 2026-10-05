/**
 * The owner's A2A card in the agent workspace, whole and unchanged.
 *
 * The model reads the workspace's bootstrap files at the start of every
 * session; the bundled `bootstrap-extra-files` hook loads extra files named by
 * pattern, but only files with a bootstrap basename (AGENTS.md, SOUL.md,
 * IDENTITY.md, USER.md, BOOTSTRAP.md, MEMORY.md). The card is the owner's
 * identity on the open protocol, so it lives at `urbicana/IDENTITY.md` by
 * default: a file of its own, beside the Gateway's templates, never merged
 * into them. The document is placed verbatim; nothing is rewritten.
 */
import fs from "node:fs";
import path from "node:path";
import type { OwnerCard } from "./account.js";

export const BOOTSTRAP_BASENAMES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "BOOTSTRAP.md",
  "MEMORY.md",
] as const;

export function assertCardFileName(cardFile: string): void {
  const normalized = cardFile.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`cardFile must be a relative path inside the workspace: ${cardFile}`);
  }
  const base = path.posix.basename(normalized);
  if (!(BOOTSTRAP_BASENAMES as readonly string[]).includes(base)) {
    throw new Error(
      `cardFile must end in one of ${BOOTSTRAP_BASENAMES.join(", ")}; the bootstrap hook loads no other name`,
    );
  }
}

export function renderCardFile(ownerCard: OwnerCard): string {
  // The card, verbatim, under one heading. No preface: the card is the document.
  return ["# Agent Card", "", "```json", JSON.stringify(ownerCard.card, null, 2), "```", ""].join(
    "\n",
  );
}

/** Writes the card file atomically; the directory is created if needed. */
export function writeCardFile(workspaceDir: string, cardFile: string, text: string): string {
  assertCardFileName(cardFile);
  const target = path.resolve(workspaceDir, cardFile);
  const root = path.resolve(workspaceDir);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error("cardFile resolves outside the workspace");
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, target);
  return target;
}

export function removeCardFile(workspaceDir: string, cardFile: string): void {
  assertCardFileName(cardFile);
  const target = path.resolve(workspaceDir, cardFile);
  fs.rmSync(target, { force: true });
}
