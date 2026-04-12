/**
 * CrewStore — manages crew folder entries for the Agent Launcher feature.
 *
 * Crew folders represent working directories for TUI agent processes.
 * Each folder can have an identity file (CLAUDE.md, AGENTS.md, etc.)
 * that names the agent and defines its persona.
 *
 * Persisted as data/crew-folders.json.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const CREW_FILE = join(DATA_DIR, "crew-folders.json");

export interface CrewFolder {
  name: string;            // "Commander"
  path: string;            // "C:/Users/hadda/clawd-commander"
  identityFile?: string;   // auto-detected filename (e.g. "CLAUDE.md")
  joinAs?: string;         // extracted name from identity file (editable)
  defaultHarness?: string; // "claude" | "codex" | "gemini" | "openclaw"
  defaultConversation?: string;
}

/** Candidate identity filenames in priority order. */
const IDENTITY_CANDIDATES = [
  "CLAUDE.md",
  "AGENTS.md",
  "IDENTITY.md",
  "identity.md",
];

/**
 * Attempt to extract an agent name from an identity file's content.
 *
 * Checks in order:
 * 1. First line matching `# Name: <value>` or `**Name:** <value>`
 * 2. First top-level `# <Heading>` (single line, not a section like "# Overview")
 * Falls back to undefined (caller uses path.basename).
 */
function extractNameFromContent(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    // `# Name: Commander`
    const nameColon = line.match(/^#\s+Name:\s+(.+)$/i);
    if (nameColon) return nameColon[1].trim();

    // `**Name:** Commander`
    const nameBold = line.match(/^\*\*Name:\*\*\s+(.+)$/i);
    if (nameBold) return nameBold[1].trim();
  }

  // First top-level heading — take its value as the name
  for (const line of lines) {
    const heading = line.match(/^#\s+(.+)$/);
    if (heading) {
      const value = heading[1].trim();
      // Skip lines that look like section titles (all-caps multi-word or long phrases)
      if (value.length > 0 && value.length <= 60) {
        return value;
      }
    }
  }

  return undefined;
}

/**
 * Detect the first identity file present in a folder and extract the agent name.
 * Returns null if none of the candidate files exist.
 */
export function detectIdentityFile(
  folderPath: string
): { file: string; joinAs: string } | null {
  for (const candidate of IDENTITY_CANDIDATES) {
    const fullPath = join(folderPath, candidate);
    if (existsSync(fullPath)) {
      let joinAs: string;
      try {
        const content = readFileSync(fullPath, "utf8");
        joinAs = extractNameFromContent(content) ?? basename(folderPath);
      } catch {
        joinAs = basename(folderPath);
      }
      return { file: candidate, joinAs };
    }
  }
  return null;
}

/**
 * Validate a CrewFolder entry before saving.
 */
export function validateCrewFolder(crew: CrewFolder): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!crew.name || crew.name.trim().length === 0) {
    errors.push("name must be non-empty");
  }

  if (!crew.path || crew.path.trim().length === 0) {
    errors.push("path must be non-empty");
  } else if (!existsSync(crew.path)) {
    errors.push(`path does not exist: ${crew.path}`);
  }

  return { valid: errors.length === 0, errors };
}

/** Load crew folders from disk. Returns [] if the file is missing or corrupt. */
export function loadCrew(): CrewFolder[] {
  try {
    if (existsSync(CREW_FILE)) {
      const raw = readFileSync(CREW_FILE, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed as CrewFolder[];
    }
  } catch {
    /* ignore — return empty */
  }
  return [];
}

/** Persist crew folders to disk. */
export function saveCrew(crew: CrewFolder[]): void {
  try {
    writeFileSync(CREW_FILE, JSON.stringify(crew, null, 2));
  } catch (err) {
    console.error("[crew] Failed to save crew-folders.json:", err);
  }
}

/** Singleton store — wraps load/save with a live in-memory list. */
class CrewStoreImpl {
  private entries: CrewFolder[] = loadCrew();

  getAll(): CrewFolder[] {
    return this.entries;
  }

  add(entry: CrewFolder): void {
    this.entries.push(entry);
    saveCrew(this.entries);
  }

  remove(name: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.name !== name);
    if (this.entries.length !== before) {
      saveCrew(this.entries);
      return true;
    }
    return false;
  }

  save(): void {
    saveCrew(this.entries);
  }
}

const CrewStore = new CrewStoreImpl();
export default CrewStore;
