/**
 * Web reconnect, server side (6 Oct 2026, mobile-crew diagnosis):
 *
 * 1. Name lock: POST /api/web/register with a different name than the one
 *    registered answers 409 and, to a caller holding the web token only,
 *    names the registered viewer so the page can adopt it before it opens
 *    the socket. Without the token the answer is the same 403 as before and
 *    carries nothing new.
 * 6. The web-token reads that took the token from the query only accept the
 *    X-Joind-Token header too (the agent-auth gate already did), with the
 *    same token and the same comparison. Run under agent-auth require so the
 *    gate and the routes are checked together.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
  return { ...actual, processTreeOnce: () => () => Promise.resolve(new Map()) };
});

import { startJoind, type JoindHandle } from "../src/index.js";
import type { JoindConfig } from "../src/config.js";

const WEB = "c".repeat(64);
const WRONG = "d".repeat(64);
const AGENT_KEY = "k".repeat(43);

interface Answer { status: number; body: unknown; text: string }

async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) as unknown : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, text };
}

type WsOutcome = { kind: "init" } | { kind: "close"; code: number };

async function openSocket(base: string, token: string, name: string): Promise<WsOutcome> {
  const { default: WebSocket } = await import("ws");
  const url = `${base.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}&name=${encodeURIComponent(name)}`;
  return new Promise<WsOutcome>((resolve) => {
    const ws = new WebSocket(url);
    ws.on("message", (raw) => {
      const ev = JSON.parse(String(raw)) as { type?: string };
      if (ev.type === "init") { resolve({ kind: "init" }); ws.close(); }
    });
    ws.on("close", (code) => resolve({ kind: "close", code }));
    ws.on("error", () => undefined);
  });
}

/** The reads that checked `req.query.token` only before this change. */
const QUERY_TOKEN_READS: string[] = [
  "/api/messages",
  "/api/export",
  "/api/conversations/ROOM/export.json",
  "/api/dms",
  "/api/decisions",
  "/api/pins",
  "/api/search?q=hello",
  "/api/message/1",
  "/api/export/decisions",
  "/api/export/summary",
  "/api/conversations",
];

describe("web reconnect: name lock and header tokens", { timeout: 30_000 }, () => {
  let dir: string;
  let S: JoindHandle;
  let room: string;

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), "joind-webreconnect-"));
    const cfg: JoindConfig = {
      port: 0, host: "127.0.0.1", dataDir: join(dir, "data"), instance: "webreconnect", crewHome: join(dir, "crew"),
      humanNames: ["Rami"], presenceGraceMs: 1_800_000, logFile: "none",
      webToken: WEB, webTokenUserSet: true, links: [], agentAuth: "require", agentKey: AGENT_KEY,
    };
    S = await startJoind(cfg);
    room = S.manager.createConversation("ops").id;
    S.manager.getRoom(room)!.send("Kira", "hello ops");
    S.manager.setActive(room);
  }, 30_000);

  afterAll(async () => {
    await S?.close().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("fix 1: the name lock tells a token holder the registered name", () => {
    it("the first registration wins", async () => {
      const a = await call(S.baseUrl, "POST", "/api/web/register", { token: WEB, name: "Rami" });
      expect(a.status).toBe(200);
      expect(a.body).toEqual({ ok: true, name: "Rami" });
    });

    it("a different name with the token answers 409 naming the registered viewer", async () => {
      const a = await call(S.baseUrl, "POST", "/api/web/register", { token: WEB, name: "human" });
      expect(a.status).toBe(409);
      expect((a.body as { registered?: string }).registered).toBe("Rami");
    });

    it("without the token, or with a wrong one, the answer is 403 and names nobody", async () => {
      for (const token of [undefined, "", WRONG]) {
        const a = await call(S.baseUrl, "POST", "/api/web/register", { token, name: "human" });
        expect(a.status, `token ${String(token)}`).toBe(403);
        expect(a.body).toEqual({ error: "unauthorized" });
        expect(a.text).not.toContain("Rami");
      }
    });

    it("the same name stays idempotent and the registration is unchanged", async () => {
      const a = await call(S.baseUrl, "POST", "/api/web/register", { token: WEB, name: "Rami" });
      expect(a.status).toBe(200);
      expect(a.body).toEqual({ ok: true, name: "Rami" });
    });

    it("the socket refuses the old name and accepts the adopted one", async () => {
      expect(await openSocket(S.baseUrl, WEB, "human")).toEqual({ kind: "close", code: 4403 });
      expect(await openSocket(S.baseUrl, WRONG, "Rami")).toEqual({ kind: "close", code: 4401 });
      expect(await openSocket(S.baseUrl, WEB, "Rami")).toEqual({ kind: "init" });
    });
  });

  describe("fix 6: query-token reads accept the X-Joind-Token header", () => {
    const pathOf = (p: string): string => p.replace("ROOM", room);
    const withQuery = (p: string, token: string): string => `${p}${p.includes("?") ? "&" : "?"}token=${token}`;

    it("the header alone is enough on every such read", async () => {
      for (const p of QUERY_TOKEN_READS) {
        const a = await call(S.baseUrl, "GET", pathOf(p), undefined, { "X-Joind-Token": WEB });
        expect(a.status, `${p} with the header only`).toBe(200);
      }
    });

    it("the query token still works as before", async () => {
      for (const p of QUERY_TOKEN_READS) {
        const a = await call(S.baseUrl, "GET", withQuery(pathOf(p), WEB));
        expect(a.status, `${p} with the query only`).toBe(200);
      }
    });

    it("no token, or a wrong one in either place, is refused (401 at the gate under require)", async () => {
      for (const p of QUERY_TOKEN_READS) {
        const none = await call(S.baseUrl, "GET", pathOf(p));
        expect(none.status, `${p} with no token`).toBe(401);
        const wrongHeader = await call(S.baseUrl, "GET", pathOf(p), undefined, { "X-Joind-Token": WRONG });
        expect([401, 403], `${p} with a wrong header`).toContain(wrongHeader.status);
        const wrongQuery = await call(S.baseUrl, "GET", withQuery(pathOf(p), WRONG));
        expect([401, 403], `${p} with a wrong query token`).toContain(wrongQuery.status);
      }
    });

    it("the header wins over the query, as at the gate: a wrong header is not rescued by a right query", async () => {
      for (const p of QUERY_TOKEN_READS) {
        const a = await call(S.baseUrl, "GET", withQuery(pathOf(p), WEB), undefined, { "X-Joind-Token": WRONG });
        expect([401, 403], `${p} wrong header, right query`).toContain(a.status);
      }
    });

    it("the agent key passes the gate but is not a web token at the route", async () => {
      for (const p of QUERY_TOKEN_READS) {
        const a = await call(S.baseUrl, "GET", pathOf(p), undefined, { Authorization: `Bearer ${AGENT_KEY}` });
        expect(a.status, `${p} with the agent key only`).toBe(403);
      }
    });
  });
});
