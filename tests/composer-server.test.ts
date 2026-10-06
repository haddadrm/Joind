/**
 * Composer plus-menu, server side (29 Sep 2026).
 *
 * Several images per message: `image` stays the first image, `images` is
 * added only for two or more, the web routes accept either field, every
 * entry must be this server's own upload url, at most ten. Agents see every
 * image through /api/agent/read (the JSON) and chat_read (the text suffix),
 * and a linked server's mirror carries the field as it is.
 *
 * Prompt snippets: per viewer, token-gated CRUD with validation, stored in
 * the data dir's snippets.json.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("../src/terminals.js", async () => {
  const actual = await vi.importActual<typeof import("../src/terminals.js")>("../src/terminals.js");
  return { ...actual, processTreeOnce: () => () => Promise.resolve(new Map()) };
});
vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return { ...actual, inject: vi.fn(async () => undefined) };
});

import { startJoind, type JoindHandle } from "../src/index.js";
import type { JoindConfig } from "../src/config.js";
import type { ChatMessage } from "../src/room.js";
import { normalizeImages, messageImages, imagesSuffix, isUploadUrl, MAX_IMAGES } from "../src/attachments.js";
import { validateSnippet, SnippetError, SnippetStore, SNIPPET_LIMITS } from "../src/snippets.js";
import { MirrorRoom, type MirrorTransport } from "../src/mirror.js";

const WEB = "c".repeat(64);

interface Answer { status: number; json: Record<string, unknown> }

async function call(base: string, method: string, path: string, body?: unknown, token: string | null = WEB): Promise<Answer> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers["X-Joind-Token"] = token;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = { raw: text }; }
  return { status: res.status, json };
}

const IMG = (n: number): string[] => Array.from({ length: n }, (_, i) => `/data/files/1700000000000-abc${i}.png`);

describe("attachments helpers", () => {
  it("accepts only this server's upload urls", () => {
    expect(isUploadUrl("/data/files/1-a.png")).toBe(true);
    for (const bad of ["javascript:alert(1)", "http://evil.test/a.png", "//evil.test/a.png", "/data/files/../conversations.json",
      "/data/files/a/b.png", "/data/files/", "data:image/png;base64,AAAA", "/data/files/a.png?x=1", " /data/files/a.png", 7, null]) {
      expect(isUploadUrl(bad)).toBe(false);
    }
  });

  it("normalises image and images, first image first, deduplicated", () => {
    expect(normalizeImages(undefined, undefined)).toEqual({ ok: true, images: [] });
    expect(normalizeImages("", [])).toEqual({ ok: true, images: [] });
    expect(normalizeImages("/data/files/a.png", undefined)).toEqual({ ok: true, images: ["/data/files/a.png"] });
    expect(normalizeImages(undefined, ["/data/files/a.png", "/data/files/b.png", "/data/files/a.png"]))
      .toEqual({ ok: true, images: ["/data/files/a.png", "/data/files/b.png"] });
    expect(normalizeImages("/data/files/z.png", ["/data/files/a.png"]))
      .toEqual({ ok: true, images: ["/data/files/z.png", "/data/files/a.png"] });
  });

  it("refuses a malformed list whole and caps the count", () => {
    expect(normalizeImages(undefined, "/data/files/a.png").ok).toBe(false);
    expect(normalizeImages(undefined, ["/data/files/a.png", "javascript:x"]).ok).toBe(false);
    expect(normalizeImages("http://x/a.png", undefined).ok).toBe(false);
    expect(normalizeImages(undefined, IMG(MAX_IMAGES)).ok).toBe(true);
    expect(normalizeImages(undefined, IMG(MAX_IMAGES + 1)).ok).toBe(false);
  });

  it("reads either schema back and writes the agent suffix", () => {
    expect(messageImages({ image: "/data/files/a.png" })).toEqual(["/data/files/a.png"]);
    expect(messageImages({ image: "/data/files/a.png", images: ["/data/files/a.png", "/data/files/b.png"] })).toEqual(["/data/files/a.png", "/data/files/b.png"]);
    expect(messageImages({})).toEqual([]);
    expect(imagesSuffix({})).toBe("");
    expect(imagesSuffix({ image: "/data/files/a.png" })).toBe(" [image: /data/files/a.png]");
    expect(imagesSuffix({ image: "/data/files/a.png", images: ["/data/files/a.png", "/data/files/b.png"] })).toBe(" [images: /data/files/a.png, /data/files/b.png]");
  });
});

describe("snippet validation", () => {
  it("requires a title and text on create and bounds them", () => {
    expect(validateSnippet({ title: " Hi \n there ", text: "a\r\nb\u0001" }, false)).toEqual({ title: "Hi there", text: "a\nb" });
    expect(() => validateSnippet({ title: "", text: "x" }, false)).toThrow(SnippetError);
    expect(() => validateSnippet({ title: "x", text: "   " }, false)).toThrow(SnippetError);
    expect(() => validateSnippet({ title: 5, text: "x" }, false)).toThrow(SnippetError);
    expect(() => validateSnippet({ title: "x".repeat(SNIPPET_LIMITS.title + 1), text: "x" }, false)).toThrow(SnippetError);
    expect(() => validateSnippet({ title: "x", text: "x".repeat(SNIPPET_LIMITS.text + 1) }, false)).toThrow(SnippetError);
    expect(() => validateSnippet({}, true)).toThrow(SnippetError);
    expect(validateSnippet({ text: "only" }, true)).toEqual({ text: "only" });
  });

  it("keeps a damaged file from failing the store", () => {
    const d = mkdtempSync(join(tmpdir(), "joind-snip-"));
    try {
      writeFileSync(join(d, "snippets.json"), "{not json");
      const s = new SnippetStore(d);
      expect(s.list("Rami")).toEqual([]);
      s.create("Rami", { title: "a", text: "b" });
      expect(new SnippetStore(d).list("Rami").map((x) => x.title)).toEqual(["a"]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("does not treat inherited object keys as a viewer's list", () => {
    const d = mkdtempSync(join(tmpdir(), "joind-snip-"));
    try {
      const s = new SnippetStore(d);
      expect(s.list("__proto__")).toEqual([]);
      expect(s.list("constructor")).toEqual([]);
      s.create("__proto__", { title: "a", text: "b" });
      expect(new SnippetStore(d).list("__proto__").length).toBe(1);
      expect(new SnippetStore(d).list("Rami")).toEqual([]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("mirror of a remote room carries every image", () => {
  it("a forwarded message keeps image and images as the home stored them", () => {
    const transport: MirrorTransport = {
      isUp: () => true,
      register: async () => ({ ok: true, registration: "H1", online: [] }),
      leave: async () => undefined,
      send: async (): Promise<ChatMessage> => { throw new Error("unused"); },
      act: async () => undefined,
      failed: () => undefined,
    };
    const m = new MirrorRoom({ server: "home", homeId: "c-1", name: "ops", queueFile: null, transport, selfName: "here" });
    const msg: ChatMessage = { id: 5, sender: "Rami", text: "two", timestamp: 1, image: "/data/files/a.png", images: ["/data/files/a.png", "/data/files/b.png"] };
    m.applyEvent({ seq: 1, type: "message", data: msg });
    const got = m.readForView(10, "Rami").find((x) => x.id === 5);
    expect(got?.images).toEqual(["/data/files/a.png", "/data/files/b.png"]);
    expect(got?.image).toBe("/data/files/a.png");
  });
});

describe("composer routes", { timeout: 30_000 }, () => {
  let dir: string;
  let S: JoindHandle;
  let room: string;

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), "joind-composer-"));
    const cfg: JoindConfig = {
      port: 0, host: "127.0.0.1", dataDir: join(dir, "data"), instance: "composer", crewHome: join(dir, "crew"),
      humanNames: ["Rami"], presenceGraceMs: 1_800_000, logFile: "none",
      webToken: WEB, webTokenUserSet: true, links: [],
    };
    S = await startJoind(cfg);
    room = S.manager.createConversation("ops").id;
    S.manager.setActive(room);
  });

  afterAll(async () => {
    await S?.close().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("snippets: 409 before a viewer registers, 403 without the token on every route", async () => {
    expect((await call(S.baseUrl, "GET", "/api/snippets")).status).toBe(409);
    expect((await call(S.baseUrl, "POST", "/api/web/register", { token: WEB, name: "Rami" })).status).toBe(200);
    for (const [method, path, body] of [
      ["GET", "/api/snippets", undefined], ["POST", "/api/snippets", { title: "a", text: "b" }],
      ["PUT", "/api/snippets/x", { title: "a" }], ["DELETE", "/api/snippets/x", undefined],
    ] as const) {
      expect((await call(S.baseUrl, method, path, body, null)).status).toBe(403);
      expect((await call(S.baseUrl, method, path, body, "f".repeat(64))).status).toBe(403);
    }
    expect((await call(S.baseUrl, "GET", "/api/snippets")).json.snippets).toEqual([]);
  });

  it("snippets: create, list, edit, delete, persisted as plain text", async () => {
    const text = "<img src=x onerror=alert(1)> review @Kira\nline two";
    const c = await call(S.baseUrl, "POST", "/api/snippets", { title: "Review", text });
    expect(c.status).toBe(200);
    const snip = c.json.snippet as { id: string; title: string; text: string };
    expect(snip.text).toBe(text);
    const l = await call(S.baseUrl, "GET", "/api/snippets");
    expect((l.json.snippets as Array<{ id: string }>).map((s) => s.id)).toEqual([snip.id]);
    const u = await call(S.baseUrl, "PUT", `/api/snippets/${snip.id}`, { title: "Review two" });
    expect(u.status).toBe(200);
    expect((u.json.snippet as { title: string; text: string })).toMatchObject({ title: "Review two", text });
    const file = join(dir, "data", "snippets.json");
    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { users: Record<string, Array<{ title: string; text: string }>> };
    expect(onDisk.users.Rami[0]).toMatchObject({ title: "Review two", text });
    expect((await call(S.baseUrl, "DELETE", `/api/snippets/${snip.id}`)).status).toBe(200);
    expect((await call(S.baseUrl, "DELETE", `/api/snippets/${snip.id}`)).status).toBe(404);
    expect((await call(S.baseUrl, "PUT", `/api/snippets/${snip.id}`, { title: "x" })).status).toBe(404);
  });

  it("snippets: validation answers 400 and the caller cannot name another owner", async () => {
    expect((await call(S.baseUrl, "POST", "/api/snippets", { title: "", text: "x" })).status).toBe(400);
    expect((await call(S.baseUrl, "POST", "/api/snippets", { title: "x", text: 3 })).status).toBe(400);
    expect((await call(S.baseUrl, "POST", "/api/snippets", { title: "x", text: "y".repeat(SNIPPET_LIMITS.text + 1) })).status).toBe(400);
    const c = await call(S.baseUrl, "POST", "/api/snippets", { title: "mine", text: "t", owner: "Mallory", user: "Mallory" });
    expect(c.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(join(dir, "data", "snippets.json"), "utf8")) as { users: Record<string, unknown[]> };
    expect(Object.keys(onDisk.users)).toEqual(["Rami"]);
  });

  it("images: several in one message, first in image, all in images; one stays as before", async () => {
    const r = S.manager.getRoom(room)!;
    const three = IMG(3);
    const s = await call(S.baseUrl, "POST", "/api/send", { sender: "Rami", text: "three", images: three, token: WEB });
    expect(s.status).toBe(200);
    const m = r.getMessageById(s.json.id as number)!;
    expect(m.image).toBe(three[0]);
    expect(m.images).toEqual(three);
    const one = await call(S.baseUrl, "POST", "/api/send", { sender: "Rami", text: "one", images: [three[0]], token: WEB });
    const m1 = r.getMessageById(one.json.id as number)!;
    expect(m1.image).toBe(three[0]);
    expect("images" in m1).toBe(false);
    const legacy = await call(S.baseUrl, "POST", "/api/send", { sender: "Rami", text: "legacy", image: three[1], token: WEB });
    const m2 = r.getMessageById(legacy.json.id as number)!;
    expect(m2.image).toBe(three[1]);
    expect("images" in m2).toBe(false);
    // Persisted as written: the JSONL line carries both fields.
    const line = readFileSync(join(dir, "data", "conversations", `${room}.jsonl`), "utf8").split("\n").find((x) => x.includes("\"three\""))!;
    expect(JSON.parse(line)).toMatchObject({ image: three[0], images: three });
  });

  it("images: refused when not upload urls, not an array, or more than ten", async () => {
    for (const body of [
      { images: ["javascript:alert(1)"] }, { images: ["https://evil.test/x.png"] }, { images: "/data/files/a.png" },
      { image: "/data/files/../conversations.json" }, { images: IMG(MAX_IMAGES + 1) },
    ]) {
      const a = await call(S.baseUrl, "POST", "/api/send", { sender: "Rami", text: "x", token: WEB, ...body });
      expect(a.status).toBe(400);
    }
  });

  it("images: an agent sees every image through /api/agent/read and the chat_read text", async () => {
    expect((await call(S.baseUrl, "POST", "/api/agent/join", { name: "Kira", pid: 999_811, conversation: room }, null)).status).toBe(200);
    const read = await fetch(`${S.baseUrl}/api/agent/read?sender=Kira&pid=999811&limit=50`);
    const body = await read.json() as { messages: ChatMessage[] };
    const three = body.messages.find((m) => m.text === "three")!;
    expect(messageImages(three)).toEqual(IMG(3));
    expect(imagesSuffix(three)).toBe(` [images: ${IMG(3).join(", ")}]`);
  });

  it("images: a DM carries several images too", async () => {
    const d = await call(S.baseUrl, "POST", "/api/dm/send", { to: "Kira", text: "pics", images: IMG(2), token: WEB });
    expect(d.status).toBe(200);
    const m = S.manager.getRoom(d.json.conversationId as string)!.getMessageById(d.json.id as number)!;
    expect(m.images).toEqual(IMG(2));
    expect((await call(S.baseUrl, "POST", "/api/dm/send", { to: "Kira", text: "bad", images: ["http://x/y.png"], token: WEB })).status).toBe(400);
     const thread = await (await fetch(`${S.baseUrl}/api/dms?with=Kira&token=${WEB}`)).json() as { routesTo: string; routesToRemote: boolean };
    expect(thread.routesTo).toBe(d.json.conversationId);
    expect(thread.routesToRemote).toBe(false);
  });

  it("export writes every image of a message", async () => {
    const res = await fetch(`${S.baseUrl}/api/export?token=${WEB}`);
    const md = await res.text();
    for (const u of IMG(3)) expect(md).toContain(`![image](${u})`);
  });
});
