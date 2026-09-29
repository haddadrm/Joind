/**
 * Images on a message (composer plus-menu, 29 Sep 2026).
 *
 * Schema: a message keeps its `image` field (the first image, as before),
 * and a message with two or more images also carries `images`, the full
 * list in order (its first entry equals `image`). A single-image message is
 * byte-for-byte what it was, so an older page, an older linked server or an
 * agent that knows only `image` still sees the first image, and a newer
 * reader takes `images` when present, else `image`.
 *
 * The web routes accept `image` (a string) and `images` (an array); both
 * are normalised here. Every entry must be this server's own upload path
 * (`/data/files/<name>`, the url /api/upload answers with), so a message can
 * never point the viewer's browser at another host or scheme.
 */
import type { ChatMessage } from "./room.js";

/** Most images one message may carry. */
export const MAX_IMAGES = 10;

/** An upload url as /api/upload answers it: letters, digits, dot, dash, underscore. */
const UPLOAD_URL = /^\/data\/files\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isUploadUrl(value: unknown): value is string {
  return typeof value === "string" && UPLOAD_URL.test(value) && !value.includes("..");
}

export type ImagesResult = { ok: true; images: string[] } | { ok: false; error: string };

/**
 * The images a web send carries: `images` when given (an array), else the
 * legacy single `image`, deduplicated in order. Absent or empty is an empty
 * list. Anything malformed is refused whole, never partly accepted.
 */
export function normalizeImages(image: unknown, images: unknown): ImagesResult {
  const out: string[] = [];
  if (images !== undefined && images !== null) {
    if (!Array.isArray(images)) return { ok: false, error: "images must be an array of upload urls" };
    for (const v of images as unknown[]) {
      if (!isUploadUrl(v)) return { ok: false, error: "every image must be an upload url (/data/files/...)" };
      if (!out.includes(v)) out.push(v);
    }
  }
  if (image !== undefined && image !== null && image !== "") {
    if (!isUploadUrl(image)) return { ok: false, error: "image must be an upload url (/data/files/...)" };
    if (!out.includes(image)) out.unshift(image);
  }
  if (out.length > MAX_IMAGES) return { ok: false, error: `at most ${MAX_IMAGES} images per message` };
  return { ok: true, images: out };
}

/** Every image a stored message carries, whichever schema wrote it. */
export function messageImages(m: Pick<ChatMessage, "image" | "images">): string[] {
  if (Array.isArray(m.images) && m.images.length > 0) return m.images.filter((u) => typeof u === "string");
  return typeof m.image === "string" && m.image ? [m.image] : [];
}

/** The text an agent reads for a message's images: " [image: url]" or " [images: a, b]", else "". */
export function imagesSuffix(m: Pick<ChatMessage, "image" | "images">): string {
  const list = messageImages(m);
  if (list.length === 0) return "";
  return list.length === 1 ? ` [image: ${list[0]}]` : ` [images: ${list.join(", ")}]`;
}
