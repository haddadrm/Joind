/**
 * Scaffold service: writes an identity kit into a crew member's folder and
 * registers the member in CrewStore. Non-destructive: existing files are
 * always preserved and reported as skipped.
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { buildIdentityKit } from "./identity-kit.js";
import CrewStore, { type CrewFolder } from "./crew.js";

export interface ScaffoldRequest {
  name: string;
  parentDir: string;
  joinAs?: string;
  role?: string;
  emoji?: string;
  defaultHarness?: string;
  defaultConversation?: string;
  serverUrl: string;
}

export interface ScaffoldResult {
  folder: string;
  created: string[];
  skipped: string[];
  entry: CrewFolder;
}

const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

export function scaffoldCrewMember(req: ScaffoldRequest): ScaffoldResult {
  const name = req.name.trim();
  if (!name) throw new Error("name must be non-empty");
  if (!VALID_NAME.test(name)) {
    throw new Error("name contains invalid characters");
  }
  if (CrewStore.getAll().some((c) => c.name === name)) {
    const err = new Error(`Crew member already registered: ${name}`) as Error & { code?: string };
    err.code = "DUPLICATE";
    throw err;
  }

  const joinAs = (req.joinAs ?? name).trim();
  const folder = join(req.parentDir, name);
  const kit = buildIdentityKit({
    name,
    joinAs,
    role: req.role,
    emoji: req.emoji,
    serverUrl: req.serverUrl,
    conversation: req.defaultConversation,
  });

  const created: string[] = [];
  const skipped: string[] = [];

  mkdirSync(folder, { recursive: true });

  for (const dir of kit.dirs) {
    const full = join(folder, dir);
    if (!existsSync(full)) {
      mkdirSync(full, { recursive: true });
      created.push(`${dir}/`);
    } else {
      skipped.push(`${dir}/`);
    }
  }

  for (const [file, content] of Object.entries(kit.files)) {
    const full = join(folder, file);
    if (existsSync(full)) {
      skipped.push(file);
      continue;
    }
    writeFileSync(full, content, "utf8");
    created.push(file);
  }

  const entry: CrewFolder = {
    name,
    path: folder,
    identityFile: "AGENTS.md",
    joinAs,
    defaultHarness: req.defaultHarness,
    defaultConversation: req.defaultConversation,
    role: req.role,
    emoji: req.emoji,
  };
  CrewStore.add(entry);

  return { folder, created, skipped, entry };
}
