# Crew Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make crew members first-class in Joind: define a member once (identity + memory contract scaffolded automatically), launch them with one click, and verify they actually joined the room.

**Architecture:** Extend the existing `CrewStore` (src/crew.ts) and `LaunchService` (src/launcher.ts) rather than replacing them. Three additions: (1) an identity-kit builder that generates AGENTS.md / CLAUDE.md / SOUL.md / MEMORY.md for a new member and a scaffold service that writes them without ever overwriting existing files; (2) a presence probe in LaunchService that polls the room after launch until the agent appears, giving launches a verified "joined" terminal state; (3) a Crew panel in the web UI for define / edit / launch / delete.

**Tech Stack:** Node + TypeScript (ES modules), Express 5, vanilla JS front end (public/app.js, no framework), vitest (added by this plan) for unit tests.

**Spec:** See "Spec Summary" section below (this plan is self-contained; the spec was agreed in conversation on 2026-08-23).

## Global Constraints

- NEVER use em dashes or en dashes in any prose, code comment, doc, or generated template. Use commas, colons, parentheses, or hyphens in compound words. This includes the identity-kit template strings.
- Update `CHANGELOG.md` (repo root) as part of EVERY commit. One entry per task under a `## 2026-08-23 — Crew Lifecycle` heading is fine; the heading itself already exists after Task 1 (note: the existing CHANGELOG uses em dashes in old headings; do not copy that style; write new headings with a colon, e.g. `## 2026-08-23: Crew Lifecycle`).
- No `any` types. `unknown` + narrowing where needed.
- All work on branch `feat/crew-lifecycle` (created in Task 1).
- Scaffolding must be non-destructive: a file that already exists is never overwritten, it is reported as skipped.
- Follow existing code style: singleton stores (`CrewStoreImpl` pattern), plain functions exported for testability, JSONL/JSON persistence under `data/`.
- The front end is vanilla JS built with `document.createElement`; match that style, no innerHTML with user data (XSS).
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## Spec Summary

Problem: Joind can register crew folders and launch agents into terminals, but nothing scaffolds a member's identity and memory contract (so most crew members lost their memories; only folders whose harness honored the files kept them), nothing verifies a launched agent actually joined the room (silent failures), and crew management lives only inside the launch dialog.

Requirements:
1. Creating a crew member scaffolds their identity kit in their folder: `AGENTS.md` (identity, Joind join ritual, memory ritual), `CLAUDE.md` (pointer to AGENTS.md), `SOUL.md` (persona seed), `MEMORY.md` (long-term index), and a `memory/` directory. Existing files are preserved.
2. Crew entries gain `role`, `emoji`, and `defaultFlags` so a launch can be one click with sane per-member defaults.
3. A configurable `crewHome` directory (flag `--crew-home`, env `JOIND_CREW_HOME`) is the default parent for new member folders (Rami's Y530 convention: `C:\Users\hadda\clawd\Joind`).
4. After a launch, the server polls the target conversation until the agent named `joinAs` shows up (statuses: `waiting-join`, `joined`, `join-timeout`). The UI shows this as a green/amber/red state with retry-inject and copy-command fallbacks.
5. A Crew panel in the web UI: list members (emoji, name, role, harness, identity badge), create (scaffold form), edit, delete, and launch per member.
6. An API-only kit endpoint returns the generated identity kit as JSON without writing to disk, so remote machines (e.g. Ezri on ramiy530) can scaffold over SSH.
7. Remote limitation is accepted and documented: scaffolding writes to the server machine's disk only.

Out of scope for this plan: ACP/headless launch mode (separate research brief pending), workflow session templates, any change to the chat/message subsystem.

---

### Task 1: Test infrastructure (vitest) + branch

**Files:**
- Modify: `package.json` (add vitest devDependency + test script)
- Create: `tests/crew.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `validateCrewFolder(crew: CrewFolder): { valid: boolean; errors: string[] }` from `src/crew.ts` (existing).
- Produces: `npm test` runs vitest; later tasks add tests under `tests/`.

- [ ] **Step 1: Create branch**

```bash
cd D:/GitHub/joind
git checkout -b feat/crew-lifecycle
```

- [ ] **Step 2: Install vitest**

```bash
npm install --save-dev vitest
```

Then add to `package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 3: Write a first test against existing crew validation**

```ts
// tests/crew.test.ts
import { describe, it, expect } from "vitest";
import { validateCrewFolder } from "../src/crew.js";
import { tmpdir } from "os";

describe("validateCrewFolder", () => {
  it("rejects empty name", () => {
    const r = validateCrewFolder({ name: "", path: tmpdir() });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("name"))).toBe(true);
  });

  it("rejects missing path", () => {
    const r = validateCrewFolder({ name: "Scotty", path: "Z:/definitely/not/here-12345" });
    expect(r.valid).toBe(false);
  });

  it("accepts a real folder", () => {
    const r = validateCrewFolder({ name: "Scotty", path: tmpdir() });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
});
```

- [ ] **Step 4: Run tests, expect 3 passing**

Run: `npm test`
Expected: 3 passed. If vitest cannot resolve `../src/crew.js`, add `test: { include: ["tests/**/*.test.ts"] }` via a minimal `vitest.config.ts` with `resolve` defaults (vitest handles TS + ESM `.js` specifiers out of the box in most setups; only add config if the run fails).

- [ ] **Step 5: Commit (with CHANGELOG entry)**

Add to CHANGELOG.md top:

```markdown
## 2026-08-23: Crew Lifecycle

### Added
- vitest test infrastructure (`npm test`), first tests for crew validation.
```

```bash
git add package.json package-lock.json tests/crew.test.ts CHANGELOG.md vitest.config.ts 2>NUL
git commit -m "test: add vitest infrastructure with crew validation tests"
```

---

### Task 2: Crew model extension (role, emoji, defaultFlags) + update + PATCH endpoint

**Files:**
- Modify: `src/crew.ts` (interface + `CrewStoreImpl.update`)
- Modify: `src/index.ts` (PATCH `/api/crew/:name`, register after the existing DELETE at ~line 1289)
- Test: `tests/crew-update.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `CrewStore`, `initCrewStore(dataDir: string)`, `CrewFolder` from `src/crew.ts`.
- Produces:
  - `CrewFolder` gains optional fields: `role?: string; emoji?: string; defaultFlags?: Record<string, string | string[] | boolean>;`
  - `CrewStore.update(name: string, patch: Partial<Omit<CrewFolder, "name">>): CrewFolder | null` (returns updated entry or null if not found).
  - `PATCH /api/crew/:name` with JSON body of allowed fields; 200 with updated entry, 404 unknown name, 400 invalid patch (path that does not exist).

- [ ] **Step 1: Write failing tests**

```ts
// tests/crew-update.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import CrewStore, { initCrewStore } from "../src/crew.js";

describe("CrewStore.update", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "joind-crew-"));
    initCrewStore(dir); // repoints store at empty data dir
    CrewStore.add({ name: "Scotty", path: dir });
  });

  it("updates role, emoji, defaultFlags", () => {
    const updated = CrewStore.update("Scotty", {
      role: "Engineer",
      emoji: "🔧",
      defaultFlags: { model: "opus", yolo: true },
    });
    expect(updated?.role).toBe("Engineer");
    expect(updated?.emoji).toBe("🔧");
    expect(updated?.defaultFlags).toEqual({ model: "opus", yolo: true });
    expect(CrewStore.getAll()[0]?.role).toBe("Engineer");
  });

  it("returns null for unknown name", () => {
    expect(CrewStore.update("Nobody", { role: "x" })).toBeNull();
  });

  it("does not allow renaming via patch", () => {
    const updated = CrewStore.update("Scotty", { role: "Chief" });
    expect(updated?.name).toBe("Scotty");
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL** (`update` does not exist)

Run: `npm test`
Expected: FAIL with "CrewStore.update is not a function".

- [ ] **Step 3: Implement**

In `src/crew.ts`, extend the interface:

```ts
export interface CrewFolder {
  name: string;
  path: string;
  identityFile?: string;
  joinAs?: string;
  defaultHarness?: string;
  defaultConversation?: string;
  role?: string;
  emoji?: string;
  defaultFlags?: Record<string, string | string[] | boolean>;
}
```

Add to `CrewStoreImpl`:

```ts
  /** Merge a patch into an existing entry. `name` is the key and cannot change. */
  update(name: string, patch: Partial<Omit<CrewFolder, "name">>): CrewFolder | null {
    const entry = this.entries.find((e) => e.name === name);
    if (!entry) return null;
    Object.assign(entry, patch, { name: entry.name });
    saveCrew(this.entries);
    return entry;
  }
```

In `src/index.ts`, after the DELETE `/api/crew/:name` handler:

```ts
app.patch("/api/crew/:name", express.json(), (req, res) => {
  const body = req.body as Partial<CrewFolder>;
  const allowed: Partial<Omit<CrewFolder, "name">> = {};
  if (typeof body.path === "string") allowed.path = body.path;
  if (typeof body.joinAs === "string") allowed.joinAs = body.joinAs;
  if (typeof body.defaultHarness === "string") allowed.defaultHarness = body.defaultHarness;
  if (typeof body.defaultConversation === "string") allowed.defaultConversation = body.defaultConversation;
  if (typeof body.role === "string") allowed.role = body.role;
  if (typeof body.emoji === "string") allowed.emoji = body.emoji;
  if (body.defaultFlags && typeof body.defaultFlags === "object") allowed.defaultFlags = body.defaultFlags;

  if (allowed.path !== undefined) {
    const check = validateCrewFolder({ name: req.params.name, path: allowed.path });
    if (!check.valid) {
      res.status(400).json({ error: check.errors.join("; ") });
      return;
    }
  }

  const updated = CrewStore.update(req.params.name, allowed);
  if (!updated) {
    res.status(404).json({ error: `Unknown crew member: ${req.params.name}` });
    return;
  }
  res.json(updated);
});
```

- [ ] **Step 4: Run tests + build, expect PASS**

Run: `npm test && npm run build`
Expected: all tests pass, tsc clean.

- [ ] **Step 5: Commit (CHANGELOG: added role/emoji/defaultFlags + PATCH endpoint)**

```bash
git add src/crew.ts src/index.ts tests/crew-update.test.ts CHANGELOG.md
git commit -m "feat(crew): role, emoji, defaultFlags fields + PATCH /api/crew/:name"
```

---

### Task 3: Identity kit builder (pure)

**Files:**
- Create: `src/identity-kit.ts`
- Test: `tests/identity-kit.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: nothing from other tasks (pure module).
- Produces:

```ts
export interface IdentityKitOptions {
  name: string;          // crew display name, e.g. "Scotty"
  joinAs: string;        // chat agent name, usually the same
  role?: string;         // e.g. "Engineer"
  emoji?: string;        // e.g. "🔧"
  serverUrl: string;     // e.g. "http://100.113.239.70:4200"
  conversation?: string; // default conversation name/id
}
export interface IdentityKit {
  files: Record<string, string>; // relative filename -> content
  dirs: string[];                // relative dirs to create, e.g. ["memory"]
}
export function buildIdentityKit(opts: IdentityKitOptions): IdentityKit;
```

- [ ] **Step 1: Write failing tests**

```ts
// tests/identity-kit.test.ts
import { describe, it, expect } from "vitest";
import { buildIdentityKit } from "../src/identity-kit.js";

const opts = {
  name: "Scotty",
  joinAs: "Scotty",
  role: "Engineer",
  emoji: "🔧",
  serverUrl: "http://100.113.239.70:4200",
  conversation: "Tatmeem",
};

describe("buildIdentityKit", () => {
  it("produces the four identity files and a memory dir", () => {
    const kit = buildIdentityKit(opts);
    expect(Object.keys(kit.files).sort()).toEqual(
      ["AGENTS.md", "CLAUDE.md", "MEMORY.md", "SOUL.md"]
    );
    expect(kit.dirs).toContain("memory");
  });

  it("embeds name, server URL, conversation, and join ritual in AGENTS.md", () => {
    const agents = buildIdentityKit(opts).files["AGENTS.md"];
    expect(agents).toContain("Scotty");
    expect(agents).toContain("http://100.113.239.70:4200");
    expect(agents).toContain("Tatmeem");
    expect(agents).toContain("Memory Ritual");
    expect(agents).toContain("chat_join");
  });

  it("CLAUDE.md defers to AGENTS.md", () => {
    const claude = buildIdentityKit(opts).files["CLAUDE.md"];
    expect(claude).toContain("AGENTS.md");
  });

  it("omits conversation cleanly when not set", () => {
    const kit = buildIdentityKit({ ...opts, conversation: undefined });
    expect(kit.files["AGENTS.md"]).not.toContain("undefined");
  });

  it("contains no em or en dashes anywhere", () => {
    const kit = buildIdentityKit(opts);
    for (const content of Object.values(kit.files)) {
      expect(content).not.toMatch(/[\u2014\u2013]/);
    }
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL** (module missing)

Run: `npm test`

- [ ] **Step 3: Implement `src/identity-kit.ts`**

```ts
/**
 * Identity kit builder: generates the starter identity + memory-contract
 * files for a new crew member. Pure (no fs); the scaffold service writes.
 */

export interface IdentityKitOptions {
  name: string;
  joinAs: string;
  role?: string;
  emoji?: string;
  serverUrl: string;
  conversation?: string;
}

export interface IdentityKit {
  files: Record<string, string>;
  dirs: string[];
}

export function buildIdentityKit(opts: IdentityKitOptions): IdentityKit {
  const { name, joinAs, role, emoji, serverUrl, conversation } = opts;
  const roleLine = role ? `, ${role}` : "";
  const emojiPart = emoji ? ` ${emoji}` : "";
  const convJoin = conversation ? ` in conversation "${conversation}"` : "";

  const agentsMd = `# ${name}: Crew Identity

You are ${name}${roleLine}${emojiPart}. This folder is your home; these files are your memory.

## Every Session, Before Anything Else

1. Read SOUL.md (who you are)
2. Read MEMORY.md (your long-term memory index)
3. Read memory/YYYY-MM-DD.md for today and yesterday if they exist
4. Then join the crew chat (next section)

Do not ask permission for the above. Just do it.

## Joining the Crew Chat (Joind)

- Server: ${serverUrl} (web UI at /, MCP endpoint at /mcp)
- Preferred: Joind MCP tools. Call chat_join with name "${joinAs}" and your process id${convJoin}.
- REST fallback (Windows: use curl.exe): POST ${serverUrl}/api/agent/join with {"name":"${joinAs}","pid":<your pid>}
- The join response includes the last 15 messages; do not re-read full history.
- Mention crew with @name; @all reaches everyone. Speak when you add value; silence is fine.

## Memory Ritual (Non-Negotiable)

- Memory is limited: write things down. Files survive session restarts; mental notes do not.
- During work, append significant events, decisions, and lessons to memory/YYYY-MM-DD.md (create it if missing).
- Before ending a session, update today's memory file and move anything worth keeping long-term into MEMORY.md.
- MEMORY.md is a curated index, not raw logs. Keep one line per entry.
- When you learn a durable lesson about a tool or teammate, record it here in AGENTS.md or in MEMORY.md.

## Boundaries

- This folder is yours. The rest of the machine belongs to Rami and the other crew.
- Ask before destructive commands or anything that leaves the machine.
- Private things stay private.
`;

  const claudeMd = `# ${name}

Read AGENTS.md in this folder and follow it exactly. It is your identity, your join ritual, and your memory contract.
`;

  const soulMd = `# SOUL.md: ${name}

*A starting point. Evolve it as you figure out who you are, and tell Rami when you do.*

- Name: ${name}
- Role: ${role ?? "Crew member"}
${emoji ? `- Emoji: ${emoji}\n` : ""}
## How to Be

- Genuinely helpful, not performatively helpful. Skip the filler; just help.
- Have opinions. Disagree when you disagree.
- Resourceful before asking: read the file, check the context, then ask.
- Earn trust through competence, especially with anything external.
`;

  const memoryMd = `# MEMORY.md: Long-Term Memory

> Curated index of distilled memories. One line per entry, newest first. Raw logs live in memory/.

(nothing yet)
`;

  return {
    files: {
      "AGENTS.md": agentsMd,
      "CLAUDE.md": claudeMd,
      "SOUL.md": soulMd,
      "MEMORY.md": memoryMd,
    },
    dirs: ["memory"],
  };
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `npm test`

- [ ] **Step 5: Commit (CHANGELOG: identity kit builder)**

```bash
git add src/identity-kit.ts tests/identity-kit.test.ts CHANGELOG.md
git commit -m "feat(crew): identity kit builder for scaffolded members"
```

---

### Task 4: Scaffold service + endpoints (scaffold, kit preview)

**Files:**
- Create: `src/scaffold.ts`
- Modify: `src/index.ts` (POST `/api/crew/scaffold`, POST `/api/crew/kit`, placed BEFORE the `/api/crew/:name` PATCH/DELETE routes so the literal paths match first)
- Test: `tests/scaffold.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `buildIdentityKit`, `IdentityKitOptions` (Task 3); `CrewStore`, `CrewFolder` (Task 2); `CONFIG` host/port from `src/config.ts` for the server URL.
- Produces:

```ts
export interface ScaffoldRequest {
  name: string;
  parentDir: string;
  joinAs?: string;          // defaults to name
  role?: string;
  emoji?: string;
  defaultHarness?: string;
  defaultConversation?: string;
  serverUrl: string;
}
export interface ScaffoldResult {
  folder: string;           // absolute member folder path
  created: string[];        // files/dirs written
  skipped: string[];        // pre-existing files preserved
  entry: CrewFolder;        // registered crew entry
}
export function scaffoldCrewMember(req: ScaffoldRequest): ScaffoldResult; // throws Error with .code = "DUPLICATE" if crew name already registered
```

- REST: `POST /api/crew/scaffold` body `{name, parentDir?, joinAs?, role?, emoji?, defaultHarness?, defaultConversation?}` (parentDir defaults to `CONFIG.crewHome` once Task 5 lands; until then it is required, and Task 5 relaxes it). 200 → ScaffoldResult; 409 duplicate name; 400 bad input.
- REST: `POST /api/crew/kit` body `{name, joinAs?, role?, emoji?, conversation?}` → `IdentityKit` JSON, no disk writes (for remote machines to scaffold themselves).

- [ ] **Step 1: Write failing tests**

```ts
// tests/scaffold.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import CrewStore, { initCrewStore } from "../src/crew.js";
import { scaffoldCrewMember } from "../src/scaffold.js";

describe("scaffoldCrewMember", () => {
  let dataDir: string;
  let parent: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "joind-data-"));
    parent = mkdtempSync(join(tmpdir(), "joind-crewhome-"));
    initCrewStore(dataDir);
  });

  it("creates folder, identity files, memory dir, and registers the entry", () => {
    const result = scaffoldCrewMember({
      name: "Uhura",
      parentDir: parent,
      role: "Comms",
      serverUrl: "http://127.0.0.1:4200",
    });
    expect(existsSync(join(parent, "Uhura", "AGENTS.md"))).toBe(true);
    expect(existsSync(join(parent, "Uhura", "SOUL.md"))).toBe(true);
    expect(existsSync(join(parent, "Uhura", "memory"))).toBe(true);
    expect(result.created).toContain("AGENTS.md");
    expect(result.skipped).toEqual([]);
    expect(CrewStore.getAll().some((c) => c.name === "Uhura")).toBe(true);
    expect(result.entry.joinAs).toBe("Uhura");
  });

  it("never overwrites existing files", () => {
    const folder = join(parent, "Uhura");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SOUL.md"), "MY EXISTING SOUL");
    const result = scaffoldCrewMember({
      name: "Uhura",
      parentDir: parent,
      serverUrl: "http://127.0.0.1:4200",
    });
    expect(readFileSync(join(folder, "SOUL.md"), "utf8")).toBe("MY EXISTING SOUL");
    expect(result.skipped).toContain("SOUL.md");
    expect(result.created).toContain("AGENTS.md");
  });

  it("throws DUPLICATE for an already registered name", () => {
    CrewStore.add({ name: "Uhura", path: parent });
    expect(() =>
      scaffoldCrewMember({ name: "Uhura", parentDir: parent, serverUrl: "http://x" })
    ).toThrowError(/already/i);
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL** (module missing)

Run: `npm test`

- [ ] **Step 3: Implement `src/scaffold.ts`**

```ts
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

export function scaffoldCrewMember(req: ScaffoldRequest): ScaffoldResult {
  const name = req.name.trim();
  if (!name) throw new Error("name must be non-empty");
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
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `npm test`

- [ ] **Step 5: Wire endpoints in `src/index.ts`**

Place both routes ABOVE `app.patch("/api/crew/:name", ...)` and `app.delete("/api/crew/:name", ...)`:

```ts
import { scaffoldCrewMember } from "./scaffold.js";
import { buildIdentityKit } from "./identity-kit.js";

function publicServerUrl(): string {
  const shown = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  return `http://${shown}:${PORT}`;
}

app.post("/api/crew/scaffold", express.json(), (req, res) => {
  const body = req.body as {
    name?: string; parentDir?: string; joinAs?: string; role?: string;
    emoji?: string; defaultHarness?: string; defaultConversation?: string;
  };
  if (!body.name || !body.parentDir) {
    res.status(400).json({ error: "name and parentDir are required" });
    return;
  }
  try {
    const result = scaffoldCrewMember({
      name: body.name,
      parentDir: body.parentDir,
      joinAs: body.joinAs,
      role: body.role,
      emoji: body.emoji,
      defaultHarness: body.defaultHarness,
      defaultConversation: body.defaultConversation,
      serverUrl: publicServerUrl(),
    });
    res.json(result);
  } catch (err) {
    const e = err as Error & { code?: string };
    res.status(e.code === "DUPLICATE" ? 409 : 400).json({ error: e.message });
  }
});

app.post("/api/crew/kit", express.json(), (req, res) => {
  const body = req.body as {
    name?: string; joinAs?: string; role?: string; emoji?: string; conversation?: string;
  };
  if (!body.name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  res.json(buildIdentityKit({
    name: body.name,
    joinAs: body.joinAs ?? body.name,
    role: body.role,
    emoji: body.emoji,
    serverUrl: publicServerUrl(),
    conversation: body.conversation,
  }));
});
```

- [ ] **Step 6: Build + curl smoke test**

Run: `npm run build`, start the server, then:

```bash
curl.exe -s -X POST http://127.0.0.1:4200/api/crew/kit -H "Content-Type: application/json" -d "{\"name\":\"TestKit\"}"
```

Expected: JSON with files/AGENTS.md content. Stop the server.

- [ ] **Step 7: Commit (CHANGELOG: scaffold service + endpoints)**

```bash
git add src/scaffold.ts src/index.ts tests/scaffold.test.ts CHANGELOG.md
git commit -m "feat(crew): scaffold service + /api/crew/scaffold and /api/crew/kit"
```

---

### Task 5: crewHome config + /api/crew/meta

**Files:**
- Modify: `src/config.ts` (add `crewHome`)
- Modify: `src/index.ts` (GET `/api/crew/meta` above `/api/crew/:name` routes; make `parentDir` optional in scaffold, defaulting to `CONFIG.crewHome`)
- Test: `tests/config.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `loadConfig(argv)` pattern from `src/config.ts` (flags via `getFlag`, env fallback, default).
- Produces:
  - `JoindConfig` gains `crewHome: string` (flag `--crew-home`, env `JOIND_CREW_HOME`, default `join(homedir(), "joind-crew")`).
  - `GET /api/crew/meta` → `{ crewHome: string, serverUrl: string }`.
  - `POST /api/crew/scaffold` accepts missing `parentDir` and uses `CONFIG.crewHome`.

- [ ] **Step 1: Write failing tests**

```ts
// tests/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { homedir } from "os";
import { join } from "path";

describe("loadConfig crewHome", () => {
  it("defaults to <home>/joind-crew", () => {
    delete process.env.JOIND_CREW_HOME;
    const cfg = loadConfig([]);
    expect(cfg.crewHome).toBe(join(homedir(), "joind-crew"));
  });

  it("honors --crew-home flag", () => {
    const cfg = loadConfig(["--crew-home", "C:/Users/hadda/clawd/Joind"]);
    expect(cfg.crewHome).toBe("C:/Users/hadda/clawd/Joind");
  });

  it("honors JOIND_CREW_HOME env", () => {
    process.env.JOIND_CREW_HOME = "D:/crew";
    const cfg = loadConfig([]);
    expect(cfg.crewHome).toBe("D:/crew");
    delete process.env.JOIND_CREW_HOME;
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `npm test`

- [ ] **Step 3: Implement**

In `src/config.ts`: add `import { homedir } from "os";`, extend `JoindConfig` with `crewHome: string;`, and in `loadConfig` before the return:

```ts
  const crewHome =
    getFlag(argv, "crew-home") ?? process.env.JOIND_CREW_HOME ?? join(homedir(), "joind-crew");
```

Return it: `return { port, host, dataDir, instance, crewHome };`

In `src/index.ts`: add above the `/api/crew/:name` routes:

```ts
app.get("/api/crew/meta", (_req, res) => {
  res.json({ crewHome: CONFIG.crewHome, serverUrl: publicServerUrl() });
});
```

And in the scaffold endpoint, replace the parentDir requirement with:

```ts
  const parentDir = body.parentDir && body.parentDir.trim().length > 0
    ? body.parentDir
    : CONFIG.crewHome;
```

(validate only `body.name` as required; pass `parentDir` to `scaffoldCrewMember`).

- [ ] **Step 4: Run tests + build, expect PASS**

Run: `npm test && npm run build`

- [ ] **Step 5: Commit (CHANGELOG: crewHome config + meta endpoint)**

```bash
git add src/config.ts src/index.ts tests/config.test.ts CHANGELOG.md
git commit -m "feat(crew): crewHome config (--crew-home / JOIND_CREW_HOME) + /api/crew/meta"
```

---

### Task 6: Launch join verification (presence probe)

**Files:**
- Modify: `src/launcher.ts` (statuses, probe, poll loop)
- Modify: `src/index.ts` (wire probe to ConversationManager)
- Test: `tests/launch-verify.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `LaunchService`, `LaunchStatus`, `LaunchResult`, `LaunchRequest` (existing, src/launcher.ts); `manager.getRoom(id)`, `manager.getActiveRoom()`, `room.who()` (src/manager.ts, src/room.ts). `room.who()` returns an array of agents with at least `{ name: string; active: boolean }`.
- Produces:
  - `LaunchStatus` gains `"waiting-join" | "joined" | "join-timeout"`.
  - `LaunchResult` gains `joinedAt?: number` (epoch ms).
  - `export type PresenceProbe = (joinAs: string, conversation?: string) => boolean;`
  - `LaunchService.setPresenceProbe(probe: PresenceProbe): void`
  - `LaunchService.startJoinWatch(launchId: string, opts?: { intervalMs?: number; timeoutMs?: number }): void` (exposed for tests; defaults interval 3000, timeout 120000). Called automatically at the end of a successful `launch()` when `req.joinAs` is set and a probe is registered; NOT called for `terminal: "manual"`.

- [ ] **Step 1: Write failing tests**

```ts
// tests/launch-verify.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import LaunchService from "../src/launcher.js";
import type { HarnessDefinition } from "../src/harnesses.js";

const harness: HarnessDefinition = {
  id: "claude", label: "Claude Code", command: "claude", installed: true,
  joinSupport: "mcp", flags: [], defaultDelay: 0,
};

function launchReq(joinAs: string) {
  return {
    crewName: "Uhura", crewPath: process.cwd(), harness: "claude",
    flags: {}, joinAs, injectDelay: 0,
    terminal: "manual" as const,
  };
}

describe("join verification", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reaches joined when the probe turns true", async () => {
    let online = false;
    LaunchService.setPresenceProbe(() => online);
    const result = await LaunchService.launch(launchReq("Uhura"), harness);
    LaunchService.startJoinWatch(result.launchId, { intervalMs: 100, timeoutMs: 1000 });
    expect(LaunchService.getLaunchStatus(result.launchId)?.status).toBe("waiting-join");
    online = true;
    await vi.advanceTimersByTimeAsync(150);
    const after = LaunchService.getLaunchStatus(result.launchId);
    expect(after?.status).toBe("joined");
    expect(after?.joinedAt).toBeTypeOf("number");
  });

  it("reaches join-timeout when the probe never turns true", async () => {
    LaunchService.setPresenceProbe(() => false);
    const result = await LaunchService.launch(launchReq("Ghost"), harness);
    LaunchService.startJoinWatch(result.launchId, { intervalMs: 100, timeoutMs: 350 });
    await vi.advanceTimersByTimeAsync(500);
    expect(LaunchService.getLaunchStatus(result.launchId)?.status).toBe("join-timeout");
  });
});
```

Note for the implementer: `launch()` with `terminal: "manual"` does not auto-start the watch, which is exactly why the test can start it explicitly with fast timings.

- [ ] **Step 2: Run tests, expect FAIL**

Run: `npm test`

- [ ] **Step 3: Implement in `src/launcher.ts`**

```ts
export type PresenceProbe = (joinAs: string, conversation?: string) => boolean;
```

Extend `LaunchStatus` union with `"waiting-join" | "joined" | "join-timeout"`, add `joinedAt?: number` to `LaunchResult`, and add to `LaunchServiceImpl`:

```ts
  private presenceProbe?: PresenceProbe;

  setPresenceProbe(probe: PresenceProbe): void {
    this.presenceProbe = probe;
  }

  /**
   * Poll the presence probe until the agent shows up in the room or the
   * timeout elapses. Safe to call once per launch; replaces any pending timer.
   */
  startJoinWatch(
    launchId: string,
    opts?: { intervalMs?: number; timeoutMs?: number }
  ): void {
    const state = this.launches.get(launchId);
    if (!state || !this.presenceProbe) return;
    const probe = this.presenceProbe;
    const intervalMs = opts?.intervalMs ?? 3000;
    const timeoutMs = opts?.timeoutMs ?? 120000;
    const startedAt = Date.now();

    if (state.timer) clearTimeout(state.timer);
    state.result.status = "waiting-join";

    const tick = (): void => {
      if (probe(state.req.joinAs, state.req.conversation)) {
        state.result.status = "joined";
        state.result.joinedAt = Date.now();
        state.timer = undefined;
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        state.result.status = "join-timeout";
        state.timer = undefined;
        return;
      }
      state.timer = setTimeout(tick, intervalMs);
    };
    state.timer = setTimeout(tick, intervalMs);
  }
```

At the end of `launch()` (just before `return { ...result };` in the wezterm and wt branches, NOT the manual branch), add:

```ts
    if (req.joinAs && this.presenceProbe) {
      this.startJoinWatch(launchId);
    }
```

Careful: in the wezterm branch the successful status is currently set to `"done"`; `startJoinWatch` will immediately override it to `"waiting-join"`, which is intended (done-spawning, now waiting for join).

- [ ] **Step 4: Wire the probe in `src/index.ts`** (after `initCrewStore(DATA_DIR)` and manager creation):

```ts
LaunchService.setPresenceProbe((joinAs, conversation) => {
  const room = conversation ? manager.getRoom(conversation) : manager.getActiveRoom();
  const agents = room?.who() ?? [];
  return agents.some((a) => a.name === joinAs && a.active);
});
```

If `manager` is created after the launcher import, place this line right after the manager is constructed. If `who()` entries do not have an `active` field, check `src/room.ts` for the actual shape and use the closest equivalent (e.g. presence flag or lastSeen recency); update the plan note in the commit message if so.

- [ ] **Step 5: Run tests + build, expect PASS**

Run: `npm test && npm run build`

- [ ] **Step 6: Commit (CHANGELOG: join verification statuses)**

```bash
git add src/launcher.ts src/index.ts tests/launch-verify.test.ts CHANGELOG.md
git commit -m "feat(launch): verify the agent actually joins (waiting-join/joined/join-timeout)"
```

---

### Task 7: Crew panel UI

**Files:**
- Modify: `public/index.html` (toolbar button)
- Modify: `public/app.js` (panel + scaffold form + edit + delete + launch hook)
- Modify: `public/styles.css` (panel styles; follow existing `launch-dialog-*` class conventions)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `GET /api/crew` (existing, enriched entries with `identityExists`), `GET /api/crew/meta` (Task 5), `POST /api/crew/scaffold` (Tasks 4-5), `PATCH /api/crew/:name` (Task 2), `DELETE /api/crew/:name` (existing), `GET /api/launcher/terminals` (existing), and the existing launch dialog opener in app.js (locate with `grep -n "launch-dialog-overlay" public/app.js`; the function that builds the overlay is the opener; add an optional `preselectCrewName` parameter to it).
- Produces: `openCrewPanel()` function; a toolbar button with id `crew-btn`; the launch dialog opener accepts `preselectCrewName`.

- [ ] **Step 1: Add the toolbar button**

In `public/index.html`, find the header toolbar (search for the existing launch button; the toolbar was regrouped in commit 606bb53). Add next to the launch button:

```html
<button id="crew-btn" class="toolbar-btn" title="Crew">Crew</button>
```

- [ ] **Step 2: Build the panel in `public/app.js`**

Follow the launch-dialog pattern (overlay + box + header + content + footer, all `document.createElement`, no innerHTML for dynamic values). Implement:

```js
function openCrewPanel() {
  // 1. Fetch Promise.all([/api/crew, /api/crew/meta, /api/launcher/terminals])
  // 2. Render a list: for each crew entry a row with
  //    - emoji span (textContent = crew.emoji || '👤')
  //    - name (bold) + role (muted)
  //    - path (muted, title attr = full path)
  //    - identity badge (reuse status-badge ok/warn classes, based on identityExists)
  //    - buttons: Launch, Edit, Delete
  // 3. Launch button: closeCrewPanel(); then call the launch-dialog opener
  //    with preselectCrewName = crew.name
  // 4. Delete button: confirm with a two-click pattern (button text flips to
  //    "Really delete?" for 3 seconds), then DELETE /api/crew/<name>, re-render.
  //    Deleting the entry never deletes the folder; say so in the button title.
  // 5. "New crew member" button at the top toggles the scaffold form.
}
```

Scaffold form fields (ids `crew-new-*`): name (text), joinAs (text, auto-fills from name until manually edited), role (text), emoji (text, maxlength 4), parent folder (text, pre-filled with meta.crewHome), harness (select from /api/launcher/terminals harness list; reuse however the launch dialog obtains harness options; if it uses a different endpoint, mirror that), conversation (text, optional). Submit → `POST /api/crew/scaffold`; on success render a result block listing `created` (green) and `skipped` (amber) entries, then refresh the list. On 409 show the error inline.

Edit: pencil button swaps the row into inline inputs for role, emoji, joinAs, defaultConversation; save → `PATCH /api/crew/:name`; re-render.

- [ ] **Step 3: Preselect support + defaultFlags in the launch dialog**

In the launch-dialog opener, after crew options are populated, add:

```js
if (preselectCrewName) {
  crewSelect.value = preselectCrewName;
  crewSelect.dispatchEvent(new Event('change'));
}
```

Then extend the existing `autoFillFromCrew(crew)` function: after it applies `defaultHarness` and `defaultConversation`, if `crew.defaultFlags` is set, apply each entry to the corresponding flag input in the flags section (match by flag id; booleans check the checkbox, strings set the input value, arrays fill multi-text fields). Flags the crew entry does not mention keep their harness defaults.

- [ ] **Step 4: Styles**

Add `crew-panel-*` classes to `public/styles.css` mirroring `launch-dialog-*` (overlay, box, list rows with hover, badges reuse existing `.status-badge`). Respect the responsive bands added in the 2026-05-16 responsive audit (panel `width: min(560px, 92vw)`).

- [ ] **Step 5: Manual verification (browser)**

Run `npm run dev`. In the browser at the server URL:
1. Crew button opens the panel; existing crew listed with badges.
2. New crew member → scaffold "TestPilot" into a temp parent dir → created list shows AGENTS.md, CLAUDE.md, SOUL.md, MEMORY.md, memory/; the folder on disk matches; scaffolding again with the same name shows the 409 error inline.
3. Edit sets role/emoji; reload persists (check data/crew-folders.json).
4. Launch button opens the launch dialog with TestPilot preselected.
5. Delete removes the entry (folder remains on disk).
6. Zero console errors throughout.
Then delete the TestPilot entry and temp folder.

- [ ] **Step 6: Commit (CHANGELOG: crew panel UI)**

```bash
git add public/index.html public/app.js public/styles.css CHANGELOG.md
git commit -m "feat(ui): crew panel (list, scaffold, edit, delete, launch)"
```

---

### Task 8: Launch dialog join-status pill

**Files:**
- Modify: `public/app.js` (extend the existing `/api/launch/:launchId` polling)
- Modify: `public/styles.css`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `GET /api/launch/:launchId` now returning `status` including `waiting-join | joined | join-timeout` and `joinedAt` (Task 6); existing `POST /api/launch/:launchId/inject`.
- Produces: visible join state in the launch dialog.

- [ ] **Step 1: Extend the post-launch poller**

Locate the existing poll loop (`launchPollInterval` around line 2835 of public/app.js). Extend its status rendering:

- `waiting-join`: amber pulsing pill, text `waiting for <joinAs> to join...`
- `joined`: green pill, text `✓ <joinAs> joined`; stop polling after 2 more seconds; auto-close countdown may proceed.
- `join-timeout`: red pill, text `<joinAs> did not join`; show two buttons: `Retry inject` (POST `/api/launch/:id/inject`, then resume polling) and `Copy command` (copies `result.command` to clipboard, reuse the existing copy fallback if one exists).

Keep polling interval at whatever the dialog uses today; do not shorten it.

- [ ] **Step 2: Styles**

Add `.join-pill`, `.join-pill.waiting` (amber + CSS pulse animation), `.join-pill.ok` (green), `.join-pill.fail` (red) to styles.css using existing color tokens (see the design-token consolidation commit 0fd57c0; use var(--warn)/var(--ok)/var(--danger) or the closest existing tokens; do not invent hex values if tokens exist).

- [ ] **Step 3: Manual verification (browser)**

1. Launch a real crew member (any harness installed on this machine) into a test conversation; watch the pill go waiting-join → joined when the agent joins.
2. Launch with a bogus joinAs (edit the field to a name no agent will use), confirm join-timeout appears after the timeout and Retry/Copy buttons render, Copy puts the full command on the clipboard.
3. Zero console errors.

- [ ] **Step 4: Commit (CHANGELOG: join-status pill)**

```bash
git add public/app.js public/styles.css CHANGELOG.md
git commit -m "feat(ui): join verification pill in the launch dialog"
```

---

### Task 9: Docs + skill sync

**Files:**
- Modify: `CLAUDE.md` (repo) crew section
- Modify: `README.md` crew lifecycle section
- Modify: `CHANGELOG.md` (final tidy of the release heading)
- Modify (outside repo, no commit in this repo): `D:\ClaudeSpace\.claude\skills\joind\SKILL.md` and ramiy530 `%USERPROFILE%\.claude\skills\joind\SKILL.md` (via scp) with a short "Crew lifecycle" section

**Interfaces:**
- Consumes: everything shipped in Tasks 1-8.
- Produces: docs matching reality.

- [ ] **Step 1: Repo docs**

CLAUDE.md: under a `## Crew` heading document: crew-folders.json fields (including role/emoji/defaultFlags), scaffold behavior (non-destructive, identity kit files), crewHome config, join verification statuses, and the remote limitation (scaffold writes to the server machine's disk; remote members fetch `POST /api/crew/kit` and write files themselves).

README.md: one short user-facing section: define a crew member once, launch with one click, watch the join pill.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md README.md CHANGELOG.md
git commit -m "docs: crew lifecycle (scaffold, crewHome, join verification)"
```

- [ ] **Step 3: Skill sync (workspace, not this repo)**

Append to `D:\ClaudeSpace\.claude\skills\joind\SKILL.md` a `## Crew Lifecycle` section: `GET /api/crew`, `POST /api/crew/scaffold` (name, optional parentDir/role/emoji/harness/conversation), `POST /api/crew/kit` for remote self-scaffolding, `PATCH /api/crew/:name`, launch statuses now include waiting-join/joined/join-timeout. Then scp the updated tailnet variant to ramiy530 as in the Ezri setup (rewrite base URLs to 100.113.239.70).

---

## Final Verification (after all tasks)

- [ ] `npm test` green, `npm run build` clean.
- [ ] Full manual pass: scaffold a member, launch them, agent joins, pill goes green, member's memory files exist and are untouched by a second scaffold.
- [ ] `git log` shows one commit per task on `feat/crew-lifecycle`.
- [ ] Grep the diff for em/en dashes: `git diff master...HEAD | grep -P "[\u2014\u2013]"` must return only lines from pre-existing content (ideally nothing new).
