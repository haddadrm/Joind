/**
 * Linked test servers that bind port 0 (6 Oct 2026, follow-up from the
 * web-reconnect gate). Two linked servers each name the other's URL in their
 * config before either has started, so the suite used to reserve a free port,
 * close it and bind it later, which left a window in which a parallel worker
 * could take the port (EADDRINUSE). Here each server binds port 0, its config
 * names the peer by a placeholder URL, and the link's fetch resolves that
 * placeholder to the peer's real address once the peer is up. Until then the
 * fetch fails the way a refused connection does, which is what a peer that
 * has not started yet looks like anyway.
 *
 * Every link request goes through the injected fetchImpl (src/link.ts), and
 * only the origin is rewritten: paths, queries and bodies reach the test's
 * own fetch wrapper unchanged.
 */
import type { FetchLike } from "../src/link.js";

const PLACEHOLDER = /^http:\/\/([a-z0-9-]+)\.joind-peer\.invalid(?=\/|$)/;

const realFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, text: () => res.text() };
};

export class PeerRoutes {
  private readonly bases = new Map<string, string>();

  /** The link URL a config names for `peer`; it resolves once `set` names its address. */
  url(peer: string): string {
    return `http://${peer}.joind-peer.invalid`;
  }

  /** The peer's real base URL (its handle's baseUrl), known once it has bound. */
  set(peer: string, baseUrl: string): void {
    this.bases.set(peer, baseUrl.replace(/\/+$/, ""));
  }

  /** A placeholder URL rewritten to its peer's address; other URLs unchanged. */
  resolve(url: string): string {
    const m = PLACEHOLDER.exec(url);
    if (!m) return url;
    const base = this.bases.get(m[1]);
    if (!base) throw new TypeError(`fetch failed: peer ${m[1]} is not up yet`);
    return base + url.slice(m[0].length);
  }

  /** The link fetch for a server: resolve the placeholder, then `inner` (default: real fetch). */
  wrap(inner: FetchLike = realFetch): FetchLike {
    return async (url, init) => inner(this.resolve(url), init);
  }
}
