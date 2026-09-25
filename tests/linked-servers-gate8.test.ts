/**
 * Linked servers, Codex gate round 8: member release debt. Both tests fail
 * on 54b9ec9 and run the production paths: the link registry's recovery
 * after a restart, and a mirror's own departure.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("../src/inject.js", async () => {
  const actual = await vi.importActual<typeof import("../src/inject.js")>("../src/inject.js");
  return { ...actual, inject: vi.fn(async () => undefined) };
});

import { LinkRegistry, type FetchLike } from "../src/link.js";
import { MirrorRoom } from "../src/mirror.js";
import { ConversationManager } from "../src/manager.js";

async function waitFor<T>(what: string, fn: () => T | undefined | false, ms = 3_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A fake home of hosted members, over HTTP-shaped fetch. */
function memberHome() {
  const members = new Map<string, string>();
  const hostedOf = new Map<string, string>();
  const st = { down: false, n: 0 };
  const fetchImpl: FetchLike = async (url, init) => {
    if (st.down) throw new Error("connect ECONNREFUSED (test)");
    const body = JSON.parse(init.body ?? "{}") as Record<string, string>;
    const ok = (o: unknown) => ({ status: 200, text: async () => JSON.stringify(o) });
    if (url.includes("/api/peer/rooms")) return ok({ server: "home", rooms: [{ id: "c-1", name: "ops", createdAt: 1, messageCount: 0, starred: false }] });
    if (url.includes("/api/peer/register")) {
      const reg = `H${++st.n}`;
      members.set(body.name, reg);
      hostedOf.set(body.name, body.registration);
      return ok({ ok: true, registration: reg, online: [] });
    }
    if (url.includes("/api/peer/leave")) {
      const match = body.hostedRegistration ? hostedOf.get(body.name) === body.hostedRegistration : members.get(body.name) === body.registration;
      if (!members.has(body.name) || !match) return { status: 404, text: async () => JSON.stringify({ error: "No such registration" }) };
      members.delete(body.name);
      hostedOf.delete(body.name);
      return ok({ ok: true });
    }
    return ok({});
  };
  return { members, st, fetchImpl };
}

function registry(dir: string, home: ReturnType<typeof memberHome>) {
  const manager = new ConversationManager(join(dir, "data"));
  const reg = new LinkRegistry([{ name: "home", url: "http://127.0.0.1:1", token: "tok-12345678" }], {
    selfName: "here", linksDir: join(dir, "links"), manager, fetchImpl: home.fetchImpl, backoffMinMs: 20, backoffMaxMs: 40,
  });
  const stop = () => { reg.stop(); for (const r of manager.listRemote()) r.room.destroy(); };
  return { manager, reg, stop };
}

async function joinCurzon(r: ReturnType<typeof registry>): Promise<MirrorRoom> {
  await r.reg.get("home")!.discover();
  const m = r.manager.getRoom("home:c-1") as MirrorRoom;
  const out = await r.reg.registerMember("home:c-1", "Curzon", "reg-local", { pid: 999_981 });
  if (!out.ok) throw new Error("register");
  m.join("Curzon", 999_981, undefined, undefined, undefined, undefined, "reg-local");
  r.reg.commitMember("home:c-1", "Curzon", out);
  return m;
}

describe("gate round 8: member release debt", () => {
  it("finding 1: a room holding only release debt is recovered after a restart, and the debt is released", async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-g8-a-"));
    const home = memberHome();
    const first = registry(dir, home);
    try {
      const m = await joinCurzon(first);
      expect(home.members.get("Curzon")).toBe("H1");
      home.st.down = true;
      m.leave("Curzon");                                  // the last member leaves while the home is unreachable
      await waitFor("the debt on disk", () => existsSync(join(dir, "links", "home", "c-1.members.json")));
      first.stop();                                       // this server restarts
      home.st.down = false;
      const second = registry(dir, home);
      try {
        await second.reg.get("home")!.discover();         // production recovery: discovery, link up, restore
        await waitFor("H1 released at the home", () => !home.members.has("Curzon"));
        const m2 = second.manager.getRoom("home:c-1") as MirrorRoom;
        expect(m2.hasLocalMembers()).toBe(false);
        await waitFor("the debt cleared", () => m2.pendingMemberReleases().length === 0);
      } finally { second.stop(); }
    } finally { first.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("finding 2: a departure whose release record cannot be written fails and keeps the member; once it can, the debt is on disk first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-g8-b-"));
    const home = memberHome();
    const r = registry(dir, home);
    try {
      const m = await joinCurzon(r);
      home.st.down = true;                                // the release will fail too
      const tmp = join(dir, "links", "home", "c-1.members.json.tmp");
      mkdirSync(tmp, { recursive: true });                // the atomic write fails
      expect(() => m.leave("Curzon")).toThrow(/could not be saved/);
      expect(m.getAgent("Curzon")).toBeDefined();
      expect(m.homeRegistrationOf("Curzon")).toBe("H1");
      rmSync(tmp, { recursive: true, force: true });
      m.leave("Curzon");
      expect(m.getAgent("Curzon")).toBeUndefined();
      expect(JSON.parse(readFileSync(join(dir, "links", "home", "c-1.members.json"), "utf-8"))).toMatchObject({ members: [{ name: "Curzon", live: null, releasesOwed: ["reg-local"] }] });
    } finally { r.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
});
