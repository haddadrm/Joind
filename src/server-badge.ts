/**
 * The server badge: a short code on a colour that tells servers apart on the
 * rail mark, the remote room headings, member avatars and the favicon.
 *
 * Default: the first letter or digit of the server name, upper-cased, on a
 * colour picked from BADGE_PALETTE by a hash of the lower-cased name. Every
 * palette colour carries white text at 4.5:1 or better, which holds in both
 * themes because the badge draws its own background.
 *
 * Override: a manual code (1 or 2 letters or digits) and a #rrggbb colour,
 * kept in `<data dir>/server-badge.json` with the favicon option. The
 * effective badge is what /api/instance shows and what this server sends its
 * linked peers (GET /api/peer/rooms), so a peer shows the same badge for it.
 *
 * public/marks.js carries the same default rule for a peer too old to send
 * its badge; tests/marks.test.ts holds the two in step.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export interface ServerBadge {
  /** One or two letters or digits. */
  code: string;
  /** #rrggbb, lower case. */
  color: string;
}

/** The badge as /api/instance shows it: `auto` when it is the default. */
export interface EffectiveBadge extends ServerBadge {
  auto: boolean;
}

/** What the operator set. Absent fields fall back to the default. */
export interface BadgeSettings {
  code?: string;
  color?: string;
  /** Draw the badge on the favicon so two servers' tabs differ. */
  faviconBadge?: boolean;
}

/** White text clears 4.5:1 on each (tests/marks.test.ts checks it). */
export const BADGE_PALETTE: readonly string[] = [
  "#0e7490", // cyan
  "#b45309", // amber
  "#15803d", // green
  "#1d4ed8", // blue
  "#be123c", // rose
  "#475569", // slate
  "#4d7c0f", // lime
  "#a21caf", // fuchsia
];

const CODE = /^[\p{L}\p{N}]{1,2}$/u;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const FIRST = /[\p{L}\p{N}]/u;

/** FNV-1a over the UTF-16 code units of the lower-cased name. */
export function badgeHash(name: string): number {
  const s = name.toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The automatic badge for a server name. */
export function defaultBadge(name: string): ServerBadge {
  const m = FIRST.exec(name);
  const first = m ? m[0].toUpperCase() : "J";
  const code = Array.from(first).slice(0, 2).join("");
  return { code, color: BADGE_PALETTE[badgeHash(name) % BADGE_PALETTE.length] };
}

/** A valid manual code (trimmed), or null. */
export function validBadgeCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return CODE.test(t) ? t : null;
}

/** A valid colour, lower-cased, or null. */
export function validBadgeColor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return COLOR.test(t) ? t.toLowerCase() : null;
}

/** A badge received from a linked peer: kept only when both fields are
 *  valid, so nothing a peer sends reaches the page unchecked. */
export function peerBadge(v: unknown): ServerBadge | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const code = validBadgeCode(r.code);
  const color = validBadgeColor(r.color);
  return code && color ? { code, color } : undefined;
}

export function badgeSettingsPath(dataDir: string): string {
  return join(dataDir, "server-badge.json");
}

/** Why an update was refused (400). */
export class BadgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadgeError";
  }
}

/** A requested change: a string sets, null or "" clears, undefined keeps. */
export interface BadgePatch {
  code?: unknown;
  color?: unknown;
  faviconBadge?: unknown;
}

export class ServerBadgeStore {
  private readonly file: string;
  private settings: BadgeSettings = {};

  constructor(dataDir: string, private readonly serverName: string, log: (line: string) => void = (l) => console.log(l)) {
    this.file = badgeSettingsPath(dataDir);
    if (!existsSync(this.file)) return;
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const code = validBadgeCode(r.code);
      const color = validBadgeColor(r.color);
      this.settings = {
        ...(code ? { code } : {}),
        ...(color ? { color } : {}),
        ...(r.faviconBadge === true ? { faviconBadge: true } : {}),
      };
    } catch (err) {
      // A preference, not a credential: fall back to the defaults and say so.
      // The next save from Settings replaces the file.
      log(`  [server-badge] cannot read ${this.file} (${(err as Error).message}); using the default badge`);
    }
  }

  /** The badge this server shows for itself and sends its peers. */
  effective(): EffectiveBadge {
    const d = defaultBadge(this.serverName);
    const code = this.settings.code ?? d.code;
    const color = this.settings.color ?? d.color;
    return { code, color, auto: this.settings.code === undefined && this.settings.color === undefined };
  }

  faviconBadge(): boolean {
    return this.settings.faviconBadge === true;
  }

  current(): BadgeSettings {
    return { ...this.settings };
  }

  /** Apply a change, validated as a whole before anything is written. */
  update(patch: BadgePatch): BadgeSettings {
    const next: BadgeSettings = { ...this.settings };
    if (patch.code !== undefined) {
      if (patch.code === null || patch.code === "") delete next.code;
      else {
        const code = validBadgeCode(patch.code);
        if (!code) throw new BadgeError("code must be 1 or 2 letters or digits");
        next.code = code;
      }
    }
    if (patch.color !== undefined) {
      if (patch.color === null || patch.color === "") delete next.color;
      else {
        const color = validBadgeColor(patch.color);
        if (!color) throw new BadgeError("color must be #rrggbb");
        next.color = color;
      }
    }
    if (patch.faviconBadge !== undefined) {
      if (typeof patch.faviconBadge !== "boolean") throw new BadgeError("faviconBadge must be true or false");
      if (patch.faviconBadge) next.faviconBadge = true;
      else delete next.faviconBadge;
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmp, this.file);
    this.settings = next;
    return this.current();
  }
}
