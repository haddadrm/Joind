import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig, tokensEqual, injectWebToken, validWebName, loadWebName, webTokenPath, webNamePath, canRegister } from "../src/config.js";

describe("tokensEqual", () => {
  const token = "a".repeat(64);

  it("accepts the exact token and rejects wrong or missing tokens", () => {
    expect(tokensEqual(token, token)).toBe(true);
    expect(tokensEqual("b".repeat(64), token)).toBe(false);
    expect(tokensEqual("", token)).toBe(false);
    expect(tokensEqual(undefined, token)).toBe(false);
  });

  it("rejects prefixes and case-mangled tokens", () => {
    expect(tokensEqual(token.slice(0, 32), token)).toBe(false);
    expect(tokensEqual(token.toUpperCase(), token)).toBe(false);
  });
});

describe("injectWebToken", () => {
  it("injects the token script before </head>", () => {
    const html = "<html><head><title>t</title></head><body>hi</body></html>";
    const out = injectWebToken(html, "abc123");
    expect(out.indexOf('<script>window.__JOIND_TOKEN="abc123";</script>')).toBeGreaterThan(-1);
    expect(out.indexOf("</head>")).toBeGreaterThan(out.indexOf("__JOIND_TOKEN"));
    expect(out.indexOf("<body>")).toBeGreaterThan(out.indexOf("</head>"));
  });

  it("strips non-hex characters from the token (defensive)", () => {
    const out = injectWebToken("<head></head>", 'ab"cd<script>');
    expect(out).toContain('window.__JOIND_TOKEN="abcdc";');
  });

  it("appends the script when no </head> exists", () => {
    const out = injectWebToken("<body>only</body>", "abc123");
    expect(out.indexOf("__JOIND_TOKEN")).toBeGreaterThan(-1);
  });
});

describe("loadConfig webToken", () => {
  it("honors the JOIND_WEB_TOKEN env override", () => {
    process.env.JOIND_WEB_TOKEN = "envtoken123";
    const cfg = loadConfig([]);
    expect(cfg.webToken).toBe("envtoken123");
    expect(cfg.webTokenUserSet).toBe(true);
    delete process.env.JOIND_WEB_TOKEN;
  });

  it("flags generated tokens as not user-set", () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-token-test-"));
    try {
      const cfg = loadConfig(["--data-dir", dir]);
      expect(cfg.webTokenUserSet).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags the --web-token flag as user-set", () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-token-test-"));
    try {
      const cfg = loadConfig(["--data-dir", dir, "--web-token", "flagtoken"]);
      expect(cfg.webToken).toBe("flagtoken");
      expect(cfg.webTokenUserSet).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists a generated token BESIDE the data dir and reuses it", () => {
    const parent = mkdtempSync(join(tmpdir(), "joind-token-parent-"));
    const dir = join(parent, "data");
    try {
      const first = loadConfig(["--data-dir", dir]);
      expect(first.webToken).toMatch(/^[a-f0-9]{64}$/);
      // The token must live outside the data dir: /data serves files only,
      // but depth-in-layers means the secret never sits in a web-served tree.
      const tokenPath = webTokenPath(dir);
      expect(tokenPath).toBe(join(parent, "joind-web-token"));
      expect(existsSync(tokenPath)).toBe(true);
      expect(existsSync(join(dir, "web-token"))).toBe(false);

      const second = loadConfig(["--data-dir", dir]);
      expect(second.webToken).toBe(first.webToken);
      expect(readFileSync(tokenPath, "utf8").trim()).toBe(first.webToken);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("the --web-token flag beats the persisted file", () => {
    const dir = mkdtempSync(join(tmpdir(), "joind-token-test-"));
    try {
      const cfg = loadConfig(["--data-dir", dir, "--web-token", "flagtoken"]);
      expect(cfg.webToken).toBe("flagtoken");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("canRegister", () => {
  it("accepts the first registration when nothing is registered", () => {
    expect(canRegister(null, "Rami")).toBe("accept-first");
  });

  it("accepts re-registering the identical name (idempotent)", () => {
    expect(canRegister("Rami", "Rami")).toBe("accept-same");
  });

  it("rejects a different name over HTTP (renames go over the websocket)", () => {
    expect(canRegister("Rami", "Bob")).toBe("reject-conflict");
    expect(canRegister("Rami", "rami")).toBe("reject-conflict"); // exact match only
  });
});

describe("validWebName", () => {
  it("accepts sane names and trims whitespace", () => {
    expect(validWebName("Rami")).toBe("Rami");
    expect(validWebName("  human  ")).toBe("human");
    expect(validWebName("a".repeat(64))).toBe("a".repeat(64));
  });

  it("rejects empty, over-long, non-string, and control-character names", () => {
    expect(validWebName("")).toBeNull();
    expect(validWebName("   ")).toBeNull();
    expect(validWebName("a".repeat(65))).toBeNull();
    expect(validWebName(undefined)).toBeNull();
    expect(validWebName(42)).toBeNull();
    expect(validWebName("bad\nname")).toBeNull();
    expect(validWebName("bad\x7fname")).toBeNull();
  });
});

describe("web name persistence path", () => {
  it("webNamePath sits beside the data dir and loadWebName round-trips", () => {
    const parent = mkdtempSync(join(tmpdir(), "joind-name-parent-"));
    const dir = join(parent, "data");
    try {
      expect(webNamePath(dir)).toBe(join(parent, "joind-web-name"));
      expect(loadWebName(dir)).toBeNull();
      writeFileSync(webNamePath(dir), "Rami\n", { mode: 0o600 });
      expect(loadWebName(dir)).toBe("Rami");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
