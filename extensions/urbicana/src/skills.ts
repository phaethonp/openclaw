/**
 * A skill the owner authored on this Gateway, carried to Boostt.
 *
 * Skill Workshop commits a skill under the agent's state directory and the
 * Gateway fires `skill_changed` with the committed artifact: its key, its
 * directory, and the hashes of its tree. This module reads that tree with the
 * Gateway's own caps and posts it to Boostt as the owner, so Boostt is the
 * store of record and this Gateway holds the copy. Removal is reported too.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The Gateway's skill-library caps; a bundle Boostt stores must fit them. */
export const SKILL_MAX_FILES = 256;
export const SKILL_MAX_FILE_BYTES = 1024 * 1024;
export const SKILL_MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const EXCLUDED_ROOT_DIRS = new Set([".clawhub", ".clawdhub", ".openclaw"]);
export const SKILLS_PATH = "/api/v1/registry_skills";

/** What the `skill_changed` hook carries about a committed skill, as this module reads it. */
export type CommittedSkill = {
  name: string;
  skillKey: string;
  description?: string;
  skillFile: string;
  skillDir: string;
  source: string;
  revision: {
    declaredVersion?: string;
    contentSha256: string;
    treeSha256: string;
    sourceVersion?: string;
  };
};

export type SkillChange = {
  action: "created" | "updated" | "removed";
  source: string;
  before?: CommittedSkill;
  after?: CommittedSkill;
};

export type SkillFile = {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  executable: boolean;
};

/** What is posted to Boostt for one committed revision. */
export type SkillPublication = {
  skill_key: string;
  name: string;
  description?: string;
  source: string;
  action: "created" | "updated";
  revision: {
    tree_sha256: string;
    content_sha256: string;
    declared_version?: string;
  };
  files: SkillFile[];
};

function isUtf8Text(buffer: Buffer): boolean {
  if (buffer.includes(0)) {
    return false;
  }
  const text = buffer.toString("utf8");
  return Buffer.from(text, "utf8").equals(buffer);
}

/**
 * The committed tree as a list of files, in the Gateway's own shape: a path
 * relative to the skill directory, the content, utf8 where it is text and
 * base64 where it is not, and whether it is executable. Symlinks and anything
 * that is not a plain file are refused, as the Gateway refuses them; the
 * Gateway's own metadata directories are skipped.
 */
export function bundleSkillDir(skillDir: string): SkillFile[] {
  const root = path.resolve(skillDir);
  const files: SkillFile[] = [];
  let total = 0;
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (!rel && entry.isDirectory() && EXCLUDED_ROOT_DIRS.has(entry.name)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        walk(full, relPath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`skill tree holds an unsupported entry: ${relPath}`);
      }
      if (stat.size > SKILL_MAX_FILE_BYTES) {
        throw new Error(`skill file ${relPath} is over ${SKILL_MAX_FILE_BYTES} bytes`);
      }
      total += stat.size;
      if (total > SKILL_MAX_BUNDLE_BYTES) {
        throw new Error(`skill tree is over ${SKILL_MAX_BUNDLE_BYTES} bytes`);
      }
      const buffer = fs.readFileSync(full);
      const text = isUtf8Text(buffer);
      files.push({
        path: relPath,
        content: text ? buffer.toString("utf8") : buffer.toString("base64"),
        encoding: text ? "utf8" : "base64",
        executable: (stat.mode & 0o111) !== 0,
      });
      if (files.length > SKILL_MAX_FILES) {
        throw new Error(`skill tree holds more than ${SKILL_MAX_FILES} files`);
      }
    }
  };
  walk(root, "");
  if (!files.some((f) => f.path === "SKILL.md")) {
    throw new Error(`skill tree has no SKILL.md: ${skillDir}`);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/** The Gateway writes hashes as `sha256:<hex>`; Boostt stores the hex. */
export function bareSha256(value: string): string {
  return value.replace(/^sha256:/u, "");
}

export function skillPublication(change: SkillChange): SkillPublication {
  if (change.action === "removed" || !change.after) {
    throw new Error("a removal is not a publication");
  }
  const after = change.after;
  const files = bundleSkillDir(after.skillDir);
  return {
    skill_key: after.skillKey,
    name: after.name,
    ...(after.description ? { description: after.description } : {}),
    source: change.source,
    action: change.action,
    revision: {
      tree_sha256: bareSha256(after.revision.treeSha256),
      content_sha256: bareSha256(after.revision.contentSha256),
      ...(after.revision.declaredVersion
        ? { declared_version: after.revision.declaredVersion }
        : {}),
    },
    files,
  };
}

/** The tree hash Boostt will hold, computed the way the hook reports it, for a local check. */
export function treeSha256Of(files: SkillFile[]): string {
  const rows = files.map((f) => {
    const buffer =
      f.encoding === "base64" ? Buffer.from(f.content, "base64") : Buffer.from(f.content, "utf8");
    return {
      path: f.path,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      sizeBytes: buffer.byteLength,
    };
  });
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
