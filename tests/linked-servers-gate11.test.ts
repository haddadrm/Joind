/**
 * Gate round 11 (hosted presence marker), finding 1: a refill after an outage
 * replaced the mirror's roster silently. The subscription resumes from the
 * snapshot's cursor, so the membership events of the outage never arrive, and
 * an open browser kept a member who had left, or a host it no longer had.
 * The refill now announces roster changes as leave and join events.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ConversationManager } from "../src/manager.js";
import { LinkClient, type FetchLike } from "../src/link.js";
import type { RoomEvent } from "../src/room.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe("refill announces roster changes", () => {
  it("emits leave for a member gone, join for a member new or changed, nothing for an unchanged one", async () => {
    const dir = tmp("joind-gate11-");
    const manager = new ConversationManager(join(dir, "data"));
    const hosted = { name: "Curzon", pid: 0, joinedAt: 1, active: true, lastSeen: 1, host: "laptop" };
    const direct = { name: "Curzon", pid: 4242, joinedAt: 2, active: true, lastSeen: 2 };
    const jadzia = { name: "Jadzia", pid: 7, joinedAt: 1, active: true, lastSeen: 1 };
    const codex = { name: "Codex", pid: 9, joinedAt: 1, active: true, lastSeen: 1 };
    const ezri = { name: "Ezri", pid: 11, joinedAt: 3, active: true, lastSeen: 3 };
    let call = 0;
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("/api/peer/rooms")) return { status: 200, text: async () => JSON.stringify({ server: "y530", rooms: [{ id: "c-9", name: "cpm", createdAt: 1, messageCount: 0, starred: false }] }) };
      if (url.includes("/api/peer/messages")) {
        call += 1;
        const members = call === 1 ? [hosted, jadzia, codex] : [direct, jadzia, ezri];
        return { status: 200, text: async () => JSON.stringify({ server: "y530", room: "c-9", name: "cpm", messages: [{ id: 7, sender: "J", text: "t", timestamp: 1 }], members, cursor: 42, complete: true }) };
      }
      return { status: 404, text: async () => "{}" };
    };
    const c = new LinkClient({ link: { name: "y530", url: "http://127.0.0.1:1", token: "tok-12345678" }, selfName: "here", linksDir: join(dir, "links"), manager, fetchImpl });
    try {
      await c.discover();
      const m = c.getMirror("c-9")!;
      const events: RoomEvent[] = [];
      m.on("room", (ev: RoomEvent) => events.push(ev));
      await c.fill(m);                       // first fill: history, announces nothing
      expect(events).toEqual([]);
      expect(m.who().find((a) => a.name === "Curzon")?.host).toBe("laptop");
      await c.fill(m, undefined, true);      // refill after an outage: announces
      expect(m.who().find((a) => a.name === "Curzon")?.host).toBeUndefined();
      const leaves = events.filter((e) => e.type === "leave").map((e) => (e.data as { name: string }).name);
      const joins = events.filter((e) => e.type === "join").map((e) => e.data as { name: string; host?: string; pid: number });
      expect(leaves).toEqual(["Codex"]);
      expect(joins.map((a) => a.name).sort()).toEqual(["Curzon", "Ezri"]);
      const curzon = joins.find((a) => a.name === "Curzon")!;
      expect(curzon.host).toBeUndefined();
      expect(curzon.pid).toBe(4242);
      expect(events.some((e) => e.type === "message")).toBe(false); // id 7 was already here
    } finally {
      c.stop();
      for (const r of manager.listRemote()) r.room.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
