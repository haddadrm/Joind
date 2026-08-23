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
