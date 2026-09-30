/**
 * Agent credentials (src/agent-auth.ts; design note
 * docs/superpowers/specs/2026-09-29-agent-credentials-design.md).
 *
 * Real servers on loopback ports with temp data dirs. The injector is a fake
 * that records prompts, and the process enumeration a join runs is stubbed.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { basename, join } from "path";
import { tmpdir } from "os";
import { createServer } from "net";

const injected: Array<{ pid: number; prompt: string }> = [];
vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return { ...actual, inject: vi.fn(async (pid: number, prompt: string) => { injected.push({ pid, prompt }); }) };
});
vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
  return {
    ...actual,
    processTreeOnce: () => () => Promise.resolve(new Map()),
    discoverTerminals: async () => [],
  };
});

import { startJoind, type JoindHandle } from "../src/index.js";
import { loadConfig, webNamePath, webTokenPath, type JoindConfig } from "../src/config.js";
import {
  AgentAuth, AgentKeyRotateError, classifyRoute, parseAgentAuthMode, presentedAgentKey, routeLabel, keyFingerprint, agentKeyPath,
  type AgentAuthMode,
} from "../src/agent-auth.js";
import type { ChatMessage } from "../src/room.js";

const WEB = "b".repeat(64);
const KEY = "agent-key-for-tests-0123456789abcdef";
const LINK = "link-token-for-agent-auth-tests";
const PID = 999_971;
const PID2 = 999_973;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function config(dir: string, port: number, mode: AgentAuthMode, extra: Partial<JoindConfig> = {}): JoindConfig {
  return {
    port, host: "127.0.0.1", dataDir: join(dir, "data"), instance: "solo", crewHome: join(dir, "crew"),
    humanNames: ["Rami"], presenceGraceMs: 1_800_000, logFile: "none",
    webToken: WEB, webTokenUserSet: true, links: [], agentAuth: mode, agentKey: KEY,
    ...extra,
  };
}

type Resp = { status: number; json: Record<string, unknown>; text: string; headers: Headers };

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Resp> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = {}; }
  return { status: res.status, json, text, headers: res.headers };
}
const post = (b: string, p: string, body: unknown, h: Record<string, string> = {}) => call(b, "POST", p, body, h);
const get = (b: string, p: string, h: Record<string, string> = {}) => call(b, "GET", p, undefined, h);

const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
const webHdr = { "X-Joind-Token": WEB };

/** A minimal streamable-HTTP MCP client. */
async function mcpPost(base: string, body: unknown, headers: Record<string, string>, session?: string, query = ""): Promise<{ status: number; session?: string; json?: { result?: { content?: Array<{ text: string }> }; error?: { message: string } } }> {
  const res = await fetch(`${base}/mcp${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}), ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    json = line ? JSON.parse(line.slice(6)) : undefined;
  } else {
    json = text ? JSON.parse(text) : undefined;
  }
  return { status: res.status, session: res.headers.get("mcp-session-id") ?? undefined, json };
}

let rpcId = 1;
async function mcpInit(base: string, headers: Record<string, string>, query = ""): Promise<{ status: number; session?: string }> {
  const r = await mcpPost(base, { jsonrpc: "2.0", id: rpcId++, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "agent-auth-test", version: "1" } } }, headers, undefined, query);
  if (r.status === 200 && r.session) await mcpPost(base, { jsonrpc: "2.0", method: "notifications/initialized" }, headers, r.session, query);
  return { status: r.status, session: r.session };
}
async function mcpTool(base: string, session: string, name: string, args: Record<string, unknown>, headers: Record<string, string>, query = ""): Promise<{ status: number; text: string }> {
  const r = await mcpPost(base, { jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }, headers, session, query);
  return { status: r.status, text: r.json?.result?.content?.map((c) => c.text).join("\n") ?? r.json?.error?.message ?? "" };
}

async function waitFor<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Every route the server registers directly on the app, read from the
 *  source so a route added later is walked without editing this test. */
function appRoutes(): Array<{ method: string; path: string }> {
  const src = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf8");
  const out: Array<{ method: string; path: string }> = [];
  const re = /app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push({ method: m[1].toUpperCase(), path: m[2] });
  return out;
}
function concrete(path: string): string {
  return path.replace(/:id\b/g, "1").replace(/:[A-Za-z]+/g, "x");
}

// ---------------------------------------------------------------------------

describe("agent-auth units", () => {
  it("every secret written beside the default data dir (the repo root) is git-ignored by name", () => {
    const ignored = readFileSync(join(__dirname, "..", ".gitignore"), "utf8").split(/\r?\n/).map((l) => l.trim());
    const dataDir = join(__dirname, "..", "data");
    for (const p of [agentKeyPath(dataDir), webTokenPath(dataDir), webNamePath(dataDir)]) {
      expect(ignored).toContain(basename(p));
    }
  });

  it("parses the mode: default warn, the three names, anything else throws", () => {
    expect(parseAgentAuthMode(undefined)).toBe("warn");
    expect(parseAgentAuthMode("")).toBe("warn");
    expect(parseAgentAuthMode("OFF")).toBe("off");
    expect(parseAgentAuthMode("require")).toBe("require");
    expect(() => parseAgentAuthMode("strict")).toThrow(/off, warn or require/);
  });

  it("loadConfig reads --agent-auth and --agent-key, refuses a short key, and ignores the client env JOIND_AGENT_KEY", () => {
    const prev = { a: process.env.JOIND_AGENT_AUTH, k: process.env.JOIND_SERVER_AGENT_KEY, c: process.env.JOIND_AGENT_KEY };
    try {
      delete process.env.JOIND_AGENT_AUTH;
      delete process.env.JOIND_SERVER_AGENT_KEY;
      process.env.JOIND_AGENT_KEY = "client-side-key-must-not-be-used";
      const dir = mkdtempSync(join(tmpdir(), "joind-aa-cfg-"));
      try {
        const base = ["--data-dir", join(dir, "data"), "--web-token", WEB];
        const d = loadConfig(base);
        expect(d.agentAuth).toBe("warn");
        expect(d.agentKey).toBeUndefined();
        const r = loadConfig([...base, "--agent-auth", "require", "--agent-key", KEY]);
        expect(r.agentAuth).toBe("require");
        expect(r.agentKey).toBe(KEY);
        expect(() => loadConfig([...base, "--agent-key", "short"])).toThrow(/at least 16/);
        expect(() => loadConfig([...base, "--agent-auth", "maybe"])).toThrow(/off, warn or require/);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    } finally {
      for (const [k, v] of [["JOIND_AGENT_AUTH", prev.a], ["JOIND_SERVER_AGENT_KEY", prev.k], ["JOIND_AGENT_KEY", prev.c]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  it("reads the key from Authorization Bearer, X-Joind-Agent-Key, or ?agentKey, in that order", () => {
    const req = (h: Record<string, string>, q: Record<string, unknown> = {}) => ({ get: (n: string) => h[n.toLowerCase()], query: q });
    expect(presentedAgentKey(req({ authorization: "Bearer abc" }))).toBe("abc");
    expect(presentedAgentKey(req({ authorization: "bearer   abc  " }))).toBe("abc");
    expect(presentedAgentKey(req({ "x-joind-agent-key": "def" }))).toBe("def");
    expect(presentedAgentKey(req({}, { agentKey: "ghi" }))).toBe("ghi");
    expect(presentedAgentKey(req({ authorization: "Bearer a", "x-joind-agent-key": "b" }, { agentKey: "c" }))).toBe("a");
    expect(presentedAgentKey(req({ authorization: "Basic xyz" }))).toBeUndefined();
    expect(presentedAgentKey(req({}, { agentKey: ["x", "y"] }))).toBeUndefined();
  });

  it("classifies routes case-insensitively, with trailing and doubled slashes, default deny", () => {
    expect(classifyRoute("GET", "/")).toBe("outside");
    expect(classifyRoute("GET", "/data/files/x.png")).toBe("outside");
    expect(classifyRoute("GET", "/app.js")).toBe("outside");
    expect(classifyRoute("POST", "/mcp")).toBe("gated");
    expect(classifyRoute("GET", "/MCP/")).toBe("gated");
    expect(classifyRoute("GET", "/api/peer/rooms")).toBe("exempt");
    expect(classifyRoute("POST", "/api/web/register")).toBe("exempt");
    expect(classifyRoute("GET", "/api/agent/read")).toBe("callback");
    expect(classifyRoute("GET", "/API/Agent/Read/")).toBe("callback");
    expect(classifyRoute("GET", "//api//agent/read")).toBe("callback");
    expect(classifyRoute("POST", "/api/agent/send")).toBe("callback");
    expect(classifyRoute("POST", "/api/message/7/resolve")).toBe("callback");
    // The join is not a callback: it needs the key.
    expect(classifyRoute("POST", "/api/agent/join")).toBe("gated");
    // A callback path with another method is not a callback.
    expect(classifyRoute("GET", "/api/agent/send")).toBe("gated");
    expect(classifyRoute("HEAD", "/api/agent/read")).toBe("gated");
    expect(classifyRoute("POST", "/api/agent/scratchpad")).toBe("gated");
    expect(classifyRoute("GET", "/api/some/future/route")).toBe("gated");
    expect(classifyRoute("GET", "/api")).toBe("gated");
    expect(routeLabel("POST", "/api/message/123/react")).toBe("POST /api/message/:id/react");
  });

  it("admits a registration only among the given ones, never after it is revoked by a rotation", () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-aa-unit-"));
    try {
      const lines: string[] = [];
      const a = new AgentAuth({ mode: "require", key: KEY, keyUserSet: false, keyPath: join(dir, "k"), webTokenServed: false, log: (l) => lines.push(l) });
      expect(a.registrationAdmits("reg-1", ["reg-1", "reg-2"])).toBe(true);
      expect(a.registrationAdmits("reg-3", ["reg-1", "reg-2"])).toBe(false);
      expect(a.registrationAdmits(undefined, ["reg-1"])).toBe(false);
      expect(a.registrationAdmits("", [""])).toBe(false);
      const before = a.fingerprint();
      a.rotate(["reg-1"]);
      expect(a.fingerprint()).not.toBe(before);
      expect(a.keyMatches(KEY)).toBe(false);
      expect(a.keyMatches(readFileSync(join(dir, "k"), "utf8").trim())).toBe(true);
      expect(a.registrationAdmits("reg-1", ["reg-1", "reg-2"])).toBe(false);
      expect(a.registrationAdmits("reg-2", ["reg-1", "reg-2"])).toBe(true);
      expect(lines.join("\n")).not.toContain(KEY);
      expect(lines.join("\n")).not.toContain(a.currentKey());
      const fixed = new AgentAuth({ mode: "warn", key: KEY, keyUserSet: true, webTokenServed: false, log: () => {} });
      expect(() => fixed.rotate([])).toThrow(AgentKeyRotateError);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("counts and logs at most once per route per interval, never in off", () => {
    let now = 1_000_000;
    const lines: string[] = [];
    const a = new AgentAuth({ mode: "warn", key: KEY, keyUserSet: true, webTokenServed: false, now: () => now, log: (l) => lines.push(l), logEveryMs: 60_000 });
    a.note("POST /api/agent/send", "missing", "100.64.0.9", "Mallory");
    a.note("POST /api/agent/send", "missing", "100.64.0.9", "Mallory");
    a.note("POST /api/agent/send", "bad", "100.64.0.9");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("served (warn), require would refuse it");
    now += 61_000;
    a.note("POST /api/agent/send", "missing", "100.64.0.9");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("(2 more since the last line)");
    const st = a.status();
    expect(st.unauthenticated).toBe(4);
    expect(st.routes[0]).toMatchObject({ route: "POST /api/agent/send", missing: 3, bad: 1 });
    expect(JSON.stringify(st)).not.toContain(KEY);
    const off = new AgentAuth({ mode: "off", key: KEY, keyUserSet: true, webTokenServed: false, log: (l) => lines.push(l) });
    off.note("GET /x", "missing", undefined);
    expect(off.status().unauthenticated).toBe(0);
  });

  it("mints a file key beside the data dir, not in it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-aa-file-"));
    try {
      const port = await freePort();
      const { agentKey: _omit, ...rest } = config(dir, port, "warn");
      const h = await startJoind(rest as JoindConfig);
      try {
        const path = agentKeyPath(join(dir, "data"));
        expect(path).toBe(join(dir, "joind-agent-key"));
        const key = readFileSync(path, "utf8").trim();
        expect(key).toMatch(/^[0-9a-f]{64}$/);
        const st = await get(h.baseUrl, "/api/agent-auth", webHdr);
        expect(st.json).toMatchObject({ mode: "warn", keySource: "file", fingerprint: keyFingerprint(key) });
        expect(st.text).not.toContain(key);
      } finally { await h.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("with a served web token the key is neither revealed nor rotated from the page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-aa-srv2-"));
    try {
      const { agentKey: _k, ...rest } = config(dir, await freePort(), "warn", { webTokenUserSet: false });
      const h = await startJoind(rest as JoindConfig);
      try {
        const key = readFileSync(join(dir, "joind-agent-key"), "utf8").trim();
        const st = await get(h.baseUrl, "/api/agent-auth", webHdr);
        expect(st.json.webTokenServed).toBe(true);
        const rev = await post(h.baseUrl, "/api/agent-auth/reveal", {}, webHdr);
        expect(rev.status).toBe(409);
        expect(rev.text).not.toContain(key);
        expect((await post(h.baseUrl, "/api/agent-auth/rotate", {}, webHdr)).status).toBe(409);
        expect(readFileSync(join(dir, "joind-agent-key"), "utf8").trim()).toBe(key);
      } finally { await h.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a key file that cannot be written never stops warn; require refuses to start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-aa-rofile-"));
    try {
      // A directory where the key file should be: reading and writing both fail.
      mkdirSync(join(dir, "joind-agent-key"));
      const { agentKey: _k, ...warnCfg } = config(dir, await freePort(), "warn");
      const h = await startJoind(warnCfg as JoindConfig);
      try {
        const room = h.manager.createConversation("ops").id;
        expect((await post(h.baseUrl, "/api/agent/join", { name: "Nilani", pid: PID, conversation: room })).status).toBe(200);
        expect((await post(h.baseUrl, "/api/agent-auth/rotate", {}, webHdr)).status).toBe(409);
      } finally { await h.close(); }
      const { agentKey: _k2, ...reqCfg } = config(dir, await freePort(), "require");
      await expect(startJoind(reqCfg as JoindConfig)).rejects.toThrow(/cannot read or write/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("require refuses to start with a served (generated) web token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-aa-served-"));
    try {
      await expect(startJoind(config(dir, await freePort(), "require", { webTokenUserSet: false }))).rejects.toThrow(/user-set web token/);
      // Nothing was locked or started: the same data dir starts in warn.
      const h = await startJoind(config(dir, await freePort(), "warn", { webTokenUserSet: false }));
      await h.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------

describe("require: one server", { timeout: 30_000 }, () => {
  let dir: string;
  let S: JoindHandle;
  let room: string;
  const logs: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "joind-aa-req-"));
    logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    S = await startJoind(config(dir, await freePort(), "require"));
    room = S.manager.createConversation("ops").id;
    S.manager.setActive(room);
  });
  afterAll(async () => {
    await S?.close().catch(() => undefined);
    logSpy?.mockRestore();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("walks every app route: nothing under /api or /mcp is served without a credential, and a wrong key is 401 everywhere", async () => {
    const routes = appRoutes().filter((r) => r.path.startsWith("/api") || r.path === "/mcp");
    expect(routes.length).toBeGreaterThan(80);
    const served: string[] = [];
    for (const r of routes) {
      const cls = classifyRoute(r.method, concrete(r.path));
      // A callback names its caller, so it reaches the registration check
      // (without a name it is a 400 that reveals nothing).
      const named = cls === "callback";
      const path = concrete(r.path) + (named && r.method === "GET" ? "?sender=Curzon&name=Curzon" : "");
      const body = r.method === "GET" || r.method === "DELETE" ? undefined : named ? { sender: "Curzon", name: "Curzon", text: "t", clientId: "c" } : {};
      const none = await call(S.baseUrl, r.method, path, body);
      if (cls === "exempt") {
        // /api/web/register checks the web token in its own body.
        if (none.status < 400) served.push(`${r.method} ${r.path} (exempt) -> ${none.status}`);
        continue;
      }
      if (none.status !== 401) served.push(`${r.method} ${r.path} -> ${none.status}`);
      const wrong = await call(S.baseUrl, r.method, path, body, bearer("wrong-key-wrong-key-wrong"));
      if (wrong.status !== 401) served.push(`${r.method} ${r.path} with a wrong key -> ${wrong.status}`);
    }
    expect(served).toEqual([]);
  });

  it("a callback without a key or registration is 401, and says nothing about bindings", async () => {
    const j = await post(S.baseUrl, "/api/agent/join", { name: "Probe", pid: PID2, conversation: room }, bearer(KEY));
    expect(j.status).toBe(200);
    const r = await get(S.baseUrl, `/api/agent/read?sender=Probe&pid=${PID2}`);
    expect(r.status).toBe(401);
    expect(r.text).not.toMatch(/binding|Ambiguous|candidates/i);
    await post(S.baseUrl, "/api/agent/leave", { name: "Probe", pid: PID2 }, bearer(KEY));
  });

  it("the join needs the key; with it, REST read and send work, and a registration alone works on callbacks", async () => {
    const refused = await post(S.baseUrl, "/api/agent/join", { name: "Curzon", pid: PID, conversation: room });
    expect(refused.status).toBe(401);
    expect(S.manager.getRoom(room)!.getAgent("Curzon")).toBeUndefined();

    const j = await post(S.baseUrl, "/api/agent/join", { name: "Curzon", pid: PID, conversation: room }, bearer(KEY));
    expect(j.status).toBe(200);
    const reg = j.json.registration as string;
    // The X-Joind-Agent-Key header and the query parameter work too.
    expect((await get(S.baseUrl, `/api/agent/read?sender=Curzon&pid=${PID}`, { "X-Joind-Agent-Key": KEY })).status).toBe(200);
    expect((await get(S.baseUrl, `/api/agent/read?sender=Curzon&pid=${PID}&agentKey=${KEY}`)).status).toBe(200);
    // The registration alone, as a wake prompt carries it.
    expect((await get(S.baseUrl, `/api/agent/read?sender=Curzon&since=0&registration=${reg}`)).status).toBe(200);
    const sent = await post(S.baseUrl, "/api/agent/send", { sender: "Curzon", text: "hello with a registration", registration: reg });
    expect(sent.status).toBe(200);
    expect((await post(S.baseUrl, "/api/agent/status", { name: "Curzon", status: "busy", registration: reg })).status).toBe(200);
    // A registration never stands in for another name.
    const other = await post(S.baseUrl, "/api/agent/send", { sender: "Rami", text: "impersonation", registration: reg });
    expect(other.status).toBe(401);
    // A wrong key is not rescued by a good registration.
    const mixed = await get(S.baseUrl, `/api/agent/read?sender=Curzon&registration=${reg}`, bearer("wrong-key-wrong-key-wrong"));
    expect(mixed.status).toBe(401);
    // A made-up registration is 401, not a binding lookup.
    expect((await get(S.baseUrl, `/api/agent/read?sender=Curzon&registration=reg-00000000-0000-0000-0000-000000000000`)).status).toBe(401);
    // Gated routes do not accept a registration: the key or the web token only.
    expect((await post(S.baseUrl, "/api/tasks", { title: "t", creator: "Curzon", registration: reg })).status).toBe(401);
    expect((await post(S.baseUrl, "/api/tasks", { title: "t", creator: "Curzon" }, bearer(KEY))).status).toBe(200);
  });

  it("the REST fallbacks work with the key or with the web token header, never without", async () => {
    const msg = (await post(S.baseUrl, "/api/agent/send", { sender: "Curzon", text: "tag me", pid: PID }, bearer(KEY))).json.id as number;
    const curzonReg = S.manager.bindingsOf("Curzon")[0].registration;
    for (const h of [bearer(KEY), webHdr]) {
      expect((await post(S.baseUrl, `/api/message/${msg}/react`, { sender: "Curzon", emoji: "👍" }, h)).status).toBe(200);
      expect((await post(S.baseUrl, `/api/message/${msg}/tag`, { tag: "status" }, h)).status).toBe(200);
      expect((await post(S.baseUrl, `/api/message/${msg}/pin`, { pinned: true }, h)).status).toBe(200);
      expect((await post(S.baseUrl, "/api/session-marker", { type: "start" }, h)).status).toBe(200);
      expect((await post(S.baseUrl, "/api/state", { conversation: room, key: "k", value: "v" }, h)).status).toBe(200);
      expect((await get(S.baseUrl, `/api/state?conversation=${room}`, h)).status).toBe(200);
      const t = await post(S.baseUrl, "/api/tasks", { title: "fallback", creator: "Curzon", conversation: room }, h);
      expect(t.status).toBe(200);
      const done = { id: t.json.id, status: "done", response: "ok", respondedBy: "Curzon", conversation: room };
      if (h === webHdr) {
        // The web viewer resolves as the registered viewer.
        expect((await post(S.baseUrl, "/api/tasks/update", done, h)).status).toBe(200);
      } else {
        // The key admits the caller but names nobody: a named responder is
        // still proved by the registration its join returned.
        expect((await post(S.baseUrl, "/api/tasks/update", done, h)).status).toBe(403);
        expect((await post(S.baseUrl, "/api/tasks/update", { ...done, registration: curzonReg }, h)).status).toBe(200);
      }
      const up = await fetch(`${S.baseUrl}/api/upload`, { method: "POST", headers: { "Content-Type": "text/plain", ...h }, body: "file body" });
      expect(up.status).toBe(200);
      expect((await post(S.baseUrl, "/api/agent/scratchpad", { sender: "Curzon", notes: "n", conversation: room }, h)).status).toBe(200);
    }
    const bare = await fetch(`${S.baseUrl}/api/upload`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    expect(bare.status).toBe(401);
  });

  it("MCP: no key is 401 at initialize and on a live session; the header or ?agentKey work; chat_join, chat_send and chat_state run", async () => {
    expect((await mcpInit(S.baseUrl, {})).status).toBe(401);
    expect((await mcpInit(S.baseUrl, bearer("wrong-key-wrong-key-wrong"))).status).toBe(401);
    const s = await mcpInit(S.baseUrl, bearer(KEY));
    expect(s.status).toBe(200);
    const session = s.session!;
    const join1 = await mcpTool(S.baseUrl, session, "chat_join", { name: "Emony", pid: PID + 10, conversation: room }, bearer(KEY));
    expect(join1.status).toBe(200);
    expect(join1.text).toMatch(/Emony/);
    // The session id alone is not a credential.
    const noKey = await mcpTool(S.baseUrl, session, "chat_send", { sender: "Emony", text: "no key" }, {});
    expect(noKey.status).toBe(401);
    const sent = await mcpTool(S.baseUrl, session, "chat_send", { sender: "Emony", text: "sent over MCP" }, bearer(KEY));
    expect(sent.status).toBe(200);
    expect(S.manager.getRoom(room)!.read().some((m) => m.text === "sent over MCP")).toBe(true);
    expect(S.manager.getRoom(room)!.read().some((m) => m.text === "no key")).toBe(false);
    // chat_state and chat_notes call this server's own REST routes, with its key.
    const st = await mcpTool(S.baseUrl, session, "chat_state", { sender: "Emony", key: "gate", value: "open" }, bearer(KEY));
    expect(st.text).toContain("gate");
    expect((await get(S.baseUrl, `/api/state?conversation=${room}`, bearer(KEY))).json).toMatchObject({ gate: "open" });
    const notes = await mcpTool(S.baseUrl, session, "chat_notes", { sender: "Emony", notes: "remember" }, bearer(KEY));
    expect(notes.text).toBe("Notes saved");
    const up = await mcpTool(S.baseUrl, session, "chat_upload", { sender: "Emony", filename: "a.txt", content: "abc" }, bearer(KEY));
    expect(up.text).toMatch(/^File uploaded: \/data\/files\//);
    // The URL form for clients that cannot set a header.
    const q = `?agentKey=${KEY}`;
    const s2 = await mcpInit(S.baseUrl, {}, q);
    expect(s2.status).toBe(200);
    expect((await mcpTool(S.baseUrl, s2.session!, "chat_who", { sender: "Emony" }, {}, q)).status).toBe(200);
    // GET and DELETE /mcp are gated as well.
    expect((await get(S.baseUrl, "/mcp", { "mcp-session-id": session })).status).toBe(401);
    expect((await call(S.baseUrl, "DELETE", "/mcp", undefined, { "mcp-session-id": session })).status).toBe(401);
  });

  it("a wake prompt carries the registration, never the key, and its read and reply lines work as written", async () => {
    injected.length = 0;
    const s = await post(S.baseUrl, "/api/send", { sender: "Rami", text: "@Curzon wake up", conversation: room, token: WEB }, webHdr);
    expect(s.status).toBe(200);
    const w = await waitFor("the wake", () => injected.find((i) => i.pid === PID));
    const reg = S.manager.bindingsOf("Curzon")[0].registration;
    expect(w.prompt).toContain(`registration=${reg}`);
    expect(w.prompt).not.toContain(KEY);
    expect(w.prompt).not.toContain(WEB);
    const readUrl = /curl -s "([^"]+)"/.exec(w.prompt)![1];
    const read = await fetch(readUrl);
    expect(read.status).toBe(200);
    const msgs = (await read.json() as { messages: ChatMessage[] }).messages;
    expect(msgs.some((m) => m.text === "@Curzon wake up")).toBe(true);
    const bodyJson = /-d '([^']+)'/.exec(w.prompt)![1].replace("YOUR_REPLY", "replied from the prompt");
    const reply = await fetch(`${S.baseUrl}/api/agent/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: bodyJson });
    expect(reply.status).toBe(200);
  });

  it("an MCP joiner's short wake prompt names chat_read and chat_send, carries no key, and runs on its own keyed session", async () => {
    const s = await mcpInit(S.baseUrl, bearer(KEY));
    expect(s.status).toBe(200);
    const session = s.session!;
    const pid = PID + 11;
    const join1 = await mcpTool(S.baseUrl, session, "chat_join", { name: "Jadzia", pid, conversation: room }, bearer(KEY));
    expect(join1.status).toBe(200);
    injected.length = 0;
    const sent = await post(S.baseUrl, "/api/send", { sender: "Rami", text: "@Jadzia over MCP", conversation: room, token: WEB }, webHdr);
    expect(sent.status).toBe(200);
    const w = await waitFor("the MCP wake", () => injected.find((i) => i.pid === pid));
    const reg = S.manager.bindingsOf("Jadzia")[0].registration;
    expect(w.prompt).toMatch(/chat_read\(sender="Jadzia", since=\d+, registration="[^"]+"\)/);
    expect(w.prompt).toContain(`chat_send(sender="Jadzia", registration="${reg}")`);
    expect(w.prompt).not.toContain("curl");
    expect(w.prompt).not.toContain(KEY);
    expect(w.prompt).not.toContain(WEB);
    // The session's transport carries the key on every call, so the prompt
    // needs nothing more; the same call without the key is refused.
    const since = Number(/since=(\d+)/.exec(w.prompt)![1]);
    const read = await mcpTool(S.baseUrl, session, "chat_read", { sender: "Jadzia", since, registration: reg }, bearer(KEY));
    expect(read.status).toBe(200);
    expect(read.text).toContain("@Jadzia over MCP");
    expect((await mcpTool(S.baseUrl, session, "chat_read", { sender: "Jadzia", since, registration: reg }, {})).status).toBe(401);
    const reply = await mcpTool(S.baseUrl, session, "chat_send", { sender: "Jadzia", text: "replied over MCP", registration: reg }, bearer(KEY));
    expect(reply.status).toBe(200);
  });

  it("resolve: the web branch needs the web token in the header or query, not only in the body", async () => {
    const ask = await post(S.baseUrl, "/api/agent/send", { sender: "Curzon", text: "ask Rami", askFor: "Rami", pid: PID }, bearer(KEY));
    expect(ask.status).toBe(200);
    const id = ask.json.id as number;
    const bodyOnly = await post(S.baseUrl, `/api/message/${id}/resolve`, { token: WEB, conversation: room });
    expect(bodyOnly.status).toBe(401);
    const wrongBody = await post(S.baseUrl, `/api/message/${id}/resolve`, { token: "nope", conversation: room });
    expect(wrongBody.status).toBe(403);
    // The agent branch with the key resolves it.
    const agent = await post(S.baseUrl, `/api/message/${id}/resolve`, { sender: "Curzon", pid: PID }, bearer(KEY));
    expect(agent.status).toBe(200);
  });

  it("the status route never carries the key; reveal and rotate need the web token, not the agent key", async () => {
    const st = await get(S.baseUrl, "/api/agent-auth", webHdr);
    expect(st.status).toBe(200);
    expect(st.text).not.toContain(KEY);
    expect(st.json.mode).toBe("require");
    expect(st.headers.get("cache-control")).toBe("no-store");
    expect((await get(S.baseUrl, "/api/agent-auth", bearer(KEY))).status).toBe(403);
    expect((await post(S.baseUrl, "/api/agent-auth/reveal", {}, bearer(KEY))).status).toBe(403);
    expect((await post(S.baseUrl, "/api/agent-auth/rotate", {}, bearer(KEY))).status).toBe(403);
    const rev = await post(S.baseUrl, "/api/agent-auth/reveal", {}, webHdr);
    expect(rev.json.key).toBe(KEY);
    // A flag-set key is not rotated from the page.
    expect((await post(S.baseUrl, "/api/agent-auth/rotate", {}, webHdr)).status).toBe(409);
  });

  it("the key never appears in the log, the room, an export or the init payload", async () => {
    expect(logs.join("\n")).not.toContain(KEY);
    expect(logs.some((l) => l.includes("[agent-auth]") && l.includes("refused (require)"))).toBe(true);
    const exp = await get(S.baseUrl, `/api/export?token=${WEB}`);
    expect(exp.text).not.toContain(KEY);
    const all = S.manager.getRoom(room)!.readAll();
    expect(JSON.stringify(all)).not.toContain(KEY);
    const page = await fetch(`${S.baseUrl}/`);
    expect(await page.text()).not.toContain(KEY);
  });
});

// ---------------------------------------------------------------------------

describe("rotation with a file key", { timeout: 30_000 }, () => {
  let dir: string;
  let S: JoindHandle;
  let room: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "joind-aa-rot-"));
    const { agentKey: _k, ...rest } = config(dir, await freePort(), "require");
    S = await startJoind(rest as JoindConfig);
    room = S.manager.createConversation("ops").id;
    S.manager.setActive(room);
  });
  afterAll(async () => {
    await S?.close().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("revokes the old key and every current registration at once; the new key works", async () => {
    const oldKey = readFileSync(join(dir, "joind-agent-key"), "utf8").trim();
    const j = await post(S.baseUrl, "/api/agent/join", { name: "Tobin", pid: PID, conversation: room }, bearer(oldKey));
    expect(j.status).toBe(200);
    const reg = j.json.registration as string;
    const s = await mcpInit(S.baseUrl, bearer(oldKey));
    expect(s.status).toBe(200);
    const task = await post(S.baseUrl, "/api/tasks", { title: "after rotation", creator: "Tobin", conversation: room }, bearer(oldKey));
    expect(task.status).toBe(200);

    const rot = await post(S.baseUrl, "/api/agent-auth/rotate", {}, webHdr);
    expect(rot.status).toBe(200);
    const newKey = readFileSync(join(dir, "joind-agent-key"), "utf8").trim();
    expect(newKey).not.toBe(oldKey);
    expect(rot.json.fingerprint).toBe(keyFingerprint(newKey));
    expect(rot.text).not.toContain(newKey);

    expect((await get(S.baseUrl, `/api/agent/read?sender=Tobin&pid=${PID}`, bearer(oldKey))).status).toBe(401);
    expect((await get(S.baseUrl, `/api/agent/read?sender=Tobin&registration=${reg}`)).status).toBe(401);
    expect((await mcpTool(S.baseUrl, s.session!, "chat_who", {}, bearer(oldKey))).status).toBe(401);
    expect((await get(S.baseUrl, `/api/agent/read?sender=Tobin&pid=${PID}`, bearer(newKey))).status).toBe(200);
    // A revoked registration no longer names a responder either, even beside
    // the new key (the binding it came from is still in place).
    const done = { id: task.json.id, status: "done", response: "r", respondedBy: "Tobin", conversation: room };
    expect((await post(S.baseUrl, "/api/tasks/update", { ...done, registration: reg }, bearer(newKey))).status).toBe(403);
    // A rejoin with the new key gets a registration that works.
    const j2 = await post(S.baseUrl, "/api/agent/join", { name: "Tobin", pid: PID, conversation: room }, bearer(newKey));
    const reg2 = j2.json.registration as string;
    expect(reg2).not.toBe(reg);
    expect((await get(S.baseUrl, `/api/agent/read?sender=Tobin&registration=${reg2}`)).status).toBe(200);
    expect((await post(S.baseUrl, "/api/tasks/update", { ...done, registration: reg2 }, bearer(newKey))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe("warn and off never refuse", { timeout: 30_000 }, () => {
  for (const mode of ["warn", "off"] as const) {
    it(`${mode}: every agent route and fallback is served without a credential or with a wrong one`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `joind-aa-${mode}-`));
      const S = await startJoind(config(dir, await freePort(), mode));
      try {
        const room = S.manager.createConversation("ops").id;
        S.manager.setActive(room);
        for (const h of [{}, bearer("wrong-key-wrong-key-wrong")] as Array<Record<string, string>>) {
          const j = await post(S.baseUrl, "/api/agent/join", { name: "Lela", pid: PID, conversation: room }, h);
          expect(j.status).toBe(200);
          const reg = j.json.registration as string;
          expect((await get(S.baseUrl, `/api/agent/read?sender=Lela&pid=${PID}`, h)).status).toBe(200);
          expect((await get(S.baseUrl, `/api/agent/read?sender=Lela&registration=reg-not-a-real-one`, h)).status).not.toBe(401);
          const m = await post(S.baseUrl, "/api/agent/send", { sender: "Lela", text: "hi", pid: PID }, h);
          expect(m.status).toBe(200);
          const id = m.json.id as number;
          expect((await post(S.baseUrl, "/api/agent/status", { name: "Lela", status: "x", registration: reg }, h)).status).toBe(200);
          expect((await post(S.baseUrl, `/api/message/${id}/react`, { sender: "Lela", emoji: "👍" }, h)).status).toBe(200);
          expect((await post(S.baseUrl, `/api/message/${id}/tag`, { tag: "status" }, h)).status).toBe(200);
          expect((await post(S.baseUrl, `/api/message/${id}/pin`, {}, h)).status).toBe(200);
          expect((await post(S.baseUrl, "/api/session-marker", { type: "end" }, h)).status).toBe(200);
          expect((await post(S.baseUrl, "/api/state", { key: "k", value: "v" }, h)).status).toBe(200);
          const t = await post(S.baseUrl, "/api/tasks", { title: "t", creator: "Lela" }, h);
          expect(t.status).toBe(200);
          expect((await post(S.baseUrl, "/api/tasks/update", { id: t.json.id, status: "done", response: "r" }, h)).status).toBe(200);
          // The responder rule is not an auth mode: a named responder needs
          // its registration here too (403 is not 401, so warn counts nothing).
          const t2 = await post(S.baseUrl, "/api/tasks", { title: "t2", creator: "Lela" }, h);
          const named = { id: t2.json.id, status: "done", response: "r", respondedBy: "Lela" };
          expect((await post(S.baseUrl, "/api/tasks/update", named, h)).status).toBe(403);
          expect((await post(S.baseUrl, "/api/tasks/update", { ...named, registration: reg }, h)).status).toBe(200);
          expect((await fetch(`${S.baseUrl}/api/upload`, { method: "POST", headers: { "Content-Type": "text/plain", ...h }, body: "x" })).status).toBe(200);
          const s = await mcpInit(S.baseUrl, h);
          expect(s.status).toBe(200);
          expect((await mcpTool(S.baseUrl, s.session!, "chat_who", {}, h)).status).toBe(200);
          expect((await post(S.baseUrl, "/api/agent/leave", { name: "Lela", pid: PID }, h)).status).toBe(200);
        }
        // Across the whole route table no route answers 401 in this mode.
        const refusals: string[] = [];
        for (const r of appRoutes().filter((x) => x.path.startsWith("/api") && !/terminals|harnesses|launcher|launch|crew/.test(x.path))) {
          const res = await call(S.baseUrl, r.method, concrete(r.path), r.method === "GET" || r.method === "DELETE" ? undefined : {});
          if (res.status === 401) refusals.push(`${r.method} ${r.path}`);
        }
        expect(refusals).toEqual([]);
        const st = await get(S.baseUrl, "/api/agent-auth", webHdr);
        if (mode === "warn") {
          expect(st.json.unauthenticated as number).toBeGreaterThan(10);
          const routes = st.json.routes as Array<{ route: string; missing: number; bad: number }>;
          expect(routes.some((r) => r.route === "POST /api/agent/join" && r.missing > 0 && r.bad > 0)).toBe(true);
          expect(routes.some((r) => r.route === "POST /mcp")).toBe(true);
        } else {
          expect(st.json.unauthenticated).toBe(0);
        }
      } finally {
        await S.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

// ---------------------------------------------------------------------------

describe("linked servers, both in require", { timeout: 40_000 }, () => {
  const KEY_A = "alpha-agent-key-0123456789abcdef";
  const KEY_B = "bravo-agent-key-0123456789abcdef";
  let dirA: string, dirB: string;
  let A: JoindHandle, B: JoindHandle;
  let room: string;
  let remote: string;

  beforeAll(async () => {
    dirA = mkdtempSync(join(tmpdir(), "joind-aa-la-"));
    dirB = mkdtempSync(join(tmpdir(), "joind-aa-lb-"));
    const [pa, pb] = [await freePort(), await freePort()];
    const tuning = { backoffMinMs: 100, backoffMaxMs: 400, pollTimeoutMs: 1_500, requestTimeoutMs: 3_000, discoverEveryMs: 60_000 };
    A = await startJoind(config(dirA, pa, "require", { instance: "alpha", agentKey: KEY_A, links: [{ name: "bravo", url: `http://127.0.0.1:${pb}`, token: LINK }] }), { link: tuning });
    B = await startJoind(config(dirB, pb, "require", { instance: "bravo", agentKey: KEY_B, links: [{ name: "alpha", url: `http://127.0.0.1:${pa}`, token: LINK }] }), { link: tuning });
    room = A.manager.createConversation("ops").id;
    remote = `alpha:${room}`;
  }, 30_000);
  afterAll(async () => {
    await B?.close().catch(() => undefined);
    await A?.close().catch(() => undefined);
    for (const d of [dirA, dirB]) if (d) rmSync(d, { recursive: true, force: true });
  });

  it("a member hosted on B joins A's room with B's key only; A's key means nothing on B", async () => {
    expect((await post(B.baseUrl, "/api/agent/join", { name: "Curzon", pid: PID, conversation: remote }, bearer(KEY_A))).status).toBe(401);
    const j = await post(B.baseUrl, "/api/agent/join", { name: "Curzon", pid: PID, conversation: remote }, bearer(KEY_B));
    expect(j.status).toBe(200);
    expect(A.manager.getRoom(room)!.getAgent("Curzon")?.host).toBe("bravo");
  });

  it("a mention on A wakes the member on B; the prompt names B and B's registration, and works with no key", async () => {
    injected.length = 0;
    const s = await post(A.baseUrl, "/api/send", { sender: "Rami", text: "@Curzon hosted ping", conversation: room, token: WEB }, webHdr);
    expect(s.status).toBe(200);
    const w = await waitFor("B's injector", () => injected.find((i) => i.pid === PID));
    expect(w.prompt).toContain(`${B.baseUrl}/api/agent/read?sender=Curzon`);
    expect(w.prompt).not.toContain(KEY_A);
    expect(w.prompt).not.toContain(KEY_B);
    expect(w.prompt).not.toContain(LINK);
    const readUrl = /curl -s "([^"]+)"/.exec(w.prompt)![1];
    const read = await fetch(readUrl);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { messages: ChatMessage[] }).messages.some((m) => m.text === "@Curzon hosted ping")).toBe(true);
    const bodyJson = /-d '([^']+)'/.exec(w.prompt)![1].replace("YOUR_REPLY", "hosted reply");
    const reply = await fetch(`${B.baseUrl}/api/agent/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: bodyJson });
    expect(reply.status).toBe(200);
    await waitFor("the reply on A", () => A.manager.getRoom(room)!.read().some((m) => m.text === "hosted reply" && m.sender === "Curzon"));
  });

  it("a member hosted on B through MCP gets the short prompt on B, carrying B's registration and no key, and it runs on its B session", async () => {
    const s = await mcpInit(B.baseUrl, bearer(KEY_B));
    expect(s.status).toBe(200);
    const session = s.session!;
    const pid = PID + 12;
    const joined = await mcpTool(B.baseUrl, session, "chat_join", { name: "Ezri", pid, conversation: remote }, bearer(KEY_B));
    expect(joined.status).toBe(200);
    await waitFor("Ezri hosted on A", () => A.manager.getRoom(room)!.getAgent("Ezri")?.host === "bravo");
    injected.length = 0;
    expect((await post(A.baseUrl, "/api/send", { sender: "Rami", text: "@Ezri hosted MCP ping", conversation: room, token: WEB }, webHdr)).status).toBe(200);
    const w = await waitFor("B's injector for Ezri", () => injected.find((i) => i.pid === pid));
    const regB = B.manager.bindingsOf("Ezri")[0].registration;
    expect(w.prompt).toContain(`chat_send(sender="Ezri", registration="${regB}")`);
    expect(w.prompt).not.toContain("curl");
    for (const secret of [KEY_A, KEY_B, LINK]) expect(w.prompt).not.toContain(secret);
    const since = Number(/since=(\d+)/.exec(w.prompt)![1]);
    const read = await mcpTool(B.baseUrl, session, "chat_read", { sender: "Ezri", since, registration: regB }, bearer(KEY_B));
    expect(read.status).toBe(200);
    expect(read.text).toContain("@Ezri hosted MCP ping");
  });

  it("the hosted registration A holds is not a credential on A", async () => {
    const hosted = A.manager.bindingsOf("Curzon").find((e) => e.host === "bravo")!;
    expect(hosted).toBeDefined();
    expect((await get(A.baseUrl, `/api/agent/read?sender=Curzon&registration=${hosted.registration}`)).status).toBe(401);
    expect((await post(A.baseUrl, "/api/agent/send", { sender: "Curzon", text: "forged on A", registration: hosted.registration })).status).toBe(401);
  });

  it("the peer routes still take the link token, not an agent key", async () => {
    expect((await get(A.baseUrl, "/api/peer/rooms", bearer(LINK))).status).toBe(200);
    expect((await get(A.baseUrl, "/api/peer/rooms", bearer(KEY_A))).status).toBe(401);
    expect(existsSync(join(dirA, "joind-agent-key"))).toBe(false);
  });
});
