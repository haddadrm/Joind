/**
 * Composer plus-menu, page side (29 Sep 2026): the pure helpers in
 * public/ui-helpers.js, and the link card as the page draws it: the
 * Markdown the URL dialog writes, rendered by the vendored marked, cleaned
 * by public/sanitize.js, then decorated by decorateLinkCards from
 * public/app.js (its source is lifted from the file, so the test runs the
 * shipped function).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { JSDOM } from "jsdom";

const PUB = join(__dirname, "..", "public");

interface Snip { id: string; title: string; text: string }
interface Helpers {
  linkCardUrl(raw: unknown): string | null;
  linkCardLabel(href: string): string;
  linkCardMarkdown(raw: unknown, title?: unknown): string | null;
  fileLinkMarkdown(name: string, url: string): string;
  messageImageList(msg: unknown): string[];
  filterSnippets(list: Snip[], q: string): Snip[];
  insertText(value: string, start: number | null, end: number | null, text: string, ownLine?: boolean): { value: string; caret: number };
  imagesThatFit(have: number, adding: number, max: number): { take: number; refused: number };
}

function loadHelpers(): Helpers {
  const src = readFileSync(join(PUB, "ui-helpers.js"), "utf8");
  const mod: { exports: Helpers | Record<string, never> } = { exports: {} };
  new Function("module", src)(mod);
  return mod.exports as Helpers;
}

const ui = loadHelpers();

describe("link card helpers", () => {
  it("accepts http and https only", () => {
    expect(ui.linkCardUrl("https://example.com/a/b?q=1#x")).toBe("https://example.com/a/b?q=1#x");
    expect(ui.linkCardUrl("  http://Example.com  ")).toBe("http://example.com/");
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>", "vbscript:x", "file:///c:/x",
      "//example.com", "example.com", "https://user:pw@example.com/", "https://exa mple.com", "http://", "", null, 5,
      "java\nscript:alert(1)", "https://example.com/\u0000"]) {
      expect(ui.linkCardUrl(bad), String(bad)).toBeNull();
    }
  });

  it("labels a card by host and path", () => {
    expect(ui.linkCardLabel("https://example.com/")).toBe("example.com");
    expect(ui.linkCardLabel("https://example.com:8080/docs/a%20b?q=1#f")).toBe("example.com:8080/docs/a b");
  });

  it("writes an ordinary link with the card title, escaping the text", () => {
    expect(ui.linkCardMarkdown("https://example.com/x", "Spec")).toBe('[Spec](<https://example.com/x> "card")');
    expect(ui.linkCardMarkdown("https://example.com/x", "")).toBe('[https://example.com/x](<https://example.com/x> "card")');
    expect(ui.linkCardMarkdown("https://example.com/x", "a](javascript:alert(1)) [b\nc")).toBe('[a\\](javascript:alert(1)) \\[b c](<https://example.com/x> "card")');
    expect(ui.linkCardMarkdown("javascript:alert(1)", "x")).toBeNull();
  });

  it("writes a file link like chat_upload, with the name escaped", () => {
    expect(ui.fileLinkMarkdown("report.pdf", "/data/files/1-a.pdf")).toBe("📎 [report.pdf](/data/files/1-a.pdf)");
    expect(ui.fileLinkMarkdown("a](x)<img>.txt", "/data/files/1-a.txt")).toBe("📎 [a\\](x)\\<img\\>.txt](/data/files/1-a.txt)");
  });
});

describe("message images and composer helpers", () => {
  it("reads both schemas and keeps only upload urls", () => {
    expect(ui.messageImageList({ image: "/data/files/a.png" })).toEqual(["/data/files/a.png"]);
    expect(ui.messageImageList({ image: "/data/files/a.png", images: ["/data/files/a.png", "/data/files/b.png"] })).toEqual(["/data/files/a.png", "/data/files/b.png"]);
    expect(ui.messageImageList({ images: ["javascript:alert(1)", "https://evil.test/x.png", "/data/files/../x", "/data/files/ok.png"] })).toEqual(["/data/files/ok.png"]);
    expect(ui.messageImageList({ image: "http://evil.test/p.png" })).toEqual([]);
    expect(ui.messageImageList(null)).toEqual([]);
  });

  it("filters snippets by every word, title matches first", () => {
    const list: Snip[] = [
      { id: "1", title: "Deploy notes", text: "review the release" },
      { id: "2", title: "Review request", text: "please look" },
      { id: "3", title: "Other", text: "nothing" },
    ];
    expect(ui.filterSnippets(list, "").map((s) => s.id)).toEqual(["1", "2", "3"]);
    expect(ui.filterSnippets(list, "review").map((s) => s.id)).toEqual(["2", "1"]);
    expect(ui.filterSnippets(list, "REVIEW please").map((s) => s.id)).toEqual(["2"]);
    expect(ui.filterSnippets(list, "zzz")).toEqual([]);
  });

  it("inserts at the cursor, on its own line when asked", () => {
    expect(ui.insertText("hello world", 6, 6, "big ")).toEqual({ value: "hello big world", caret: 10 });
    expect(ui.insertText("hello world", 0, 5, "bye")).toEqual({ value: "bye world", caret: 3 });
    expect(ui.insertText("abc", 3, 3, "[x](y)", true)).toEqual({ value: "abc\n[x](y)", caret: 10 });
    expect(ui.insertText("ab", 1, 1, "L", true)).toEqual({ value: "a\nL\nb", caret: 4 });
    expect(ui.insertText("", null, null, "L", true)).toEqual({ value: "L", caret: 1 });
  });

  it("caps images per message", () => {
    expect(ui.imagesThatFit(0, 3, 10)).toEqual({ take: 3, refused: 0 });
    expect(ui.imagesThatFit(8, 5, 10)).toEqual({ take: 2, refused: 3 });
    expect(ui.imagesThatFit(10, 1, 10)).toEqual({ take: 0, refused: 1 });
  });
});

interface PageWindow {
  eval(src: string): unknown;
  document: Document;
  marked: { parse(src: string): string; setOptions(o: Record<string, unknown>): void };
  joindSanitizeHtml: (html: string) => string;
  joindUi: Helpers;
  decorateLinkCards(root: HTMLElement): void;
  pwned?: boolean;
}

function vendored(prefix: string): string {
  const f = readdirSync(join(PUB, "vendor")).find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`vendored ${prefix} missing`);
  return readFileSync(join(PUB, "vendor", f), "utf8");
}

/** One top-level function's source from app.js, by name. The file is
 *  normalised to LF first: a Windows checkout with core.autocrlf=true has
 *  CRLF line endings, and the closing delimiter would not be found (seen on
 *  the Y530 deploy gate, 30 Sep 2026). A missing delimiter fails loudly. */
function lift(raw: string, name: string): string {
  const src = raw.replace(/\r\n?/g, "\n");
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in app.js`);
  const end = src.indexOf("\n}\n", start);
  if (end < 0) throw new Error(`end of ${name} not found in app.js (no top-level closing brace line)`);
  return src.slice(start, end + 2);
}

describe("link cards as the page draws them", () => {
  let win: PageWindow;
  beforeAll(() => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", url: "http://joind.test/" });
    win = dom.window as unknown as PageWindow;
    win.eval(vendored("marked-"));
    win.eval(vendored("purify-"));
    win.eval(readFileSync(join(PUB, "sanitize.js"), "utf8"));
    win.eval(readFileSync(join(PUB, "ui-helpers.js"), "utf8"));
    win.marked.setOptions({ breaks: true, gfm: true });
    const app = readFileSync(join(PUB, "app.js"), "utf8");
    win.eval(lift(app, "lucideIcon") + "\n" + lift(app, "decorateLinkCards") + "\nwindow.decorateLinkCards = decorateLinkCards;");
  });

  function draw(md: string): HTMLElement {
    const el = win.document.createElement("div");
    el.innerHTML = win.joindSanitizeHtml(win.marked.parse(md));
    win.decorateLinkCards(el);
    return el;
  }

  it("a titled card shows the title and the host and path", () => {
    const el = draw("see\n" + ui.linkCardMarkdown("https://example.com/docs/page?x=1", "The <b>spec</b>")!);
    const card = el.querySelector("a.link-card") as HTMLAnchorElement;
    expect(card).not.toBeNull();
    expect(card.getAttribute("href")).toBe("https://example.com/docs/page?x=1");
    expect(card.getAttribute("rel")).toBe("noopener noreferrer");
    expect(card.getAttribute("target")).toBe("_blank");
    expect(card.querySelector(".link-card-title")!.textContent).toBe("The <b>spec</b>");
    expect(card.querySelector(".link-card-url")!.textContent).toBe("example.com/docs/page");
    expect(el.querySelector("b")).toBeNull();
    expect(el.querySelector("[title]")).toBeNull();
  });

  it("an untitled card shows host and path", () => {
    const el = draw(ui.linkCardMarkdown("https://example.com/a", "")!);
    expect(el.querySelector(".link-card-title")!.textContent).toBe("example.com/a");
  });

  it("a hand-written card with a javascript: or data: url is no card and no live link", () => {
    for (const md of ['[x](javascript:alert(1) "card")', '[x](<javascript:alert(1)> "card")', '[x](data:text/html,hi "card")',
      '<a href="javascript:alert(1)" title="card">x</a>', '<a href="https://ok.test" title="card" onclick="window.pwned=true">x</a>']) {
      const el = draw(md);
      for (const a of Array.from(el.querySelectorAll("a"))) {
        expect(/^\s*(javascript|data|vbscript):/i.test(a.getAttribute("href") ?? ""), md).toBe(false);
        expect(a.getAttribute("onclick")).toBeNull();
      }
      if (md.includes("javascript") || md.includes("data:")) expect(el.querySelector("a.link-card"), md).toBeNull();
    }
    expect(win.pwned).toBeUndefined();
  });

  it("an ordinary link is left alone", () => {
    const el = draw("[docs](https://example.com)");
    expect(el.querySelector("a.link-card")).toBeNull();
    expect(el.querySelector("a")!.getAttribute("href")).toBe("https://example.com");
  });
});
