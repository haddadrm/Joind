/**
 * Stored XSS in message rendering: the page renders message Markdown with the
 * vendored marked, then sanitizes it (public/sanitize.js over the vendored
 * DOMPurify) before innerHTML. These tests load the same three files into a
 * jsdom window, as the page does, and check what reaches the DOM.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { JSDOM } from "jsdom";

const PUB = join(__dirname, "..", "public");

interface PageWindow {
  eval(src: string): unknown;
  document: Document;
  marked: { parse(src: string): string; setOptions(o: Record<string, unknown>): void };
  joindSanitizeHtml: ((html: string) => string) | null;
  pwned?: boolean;
}

let win: PageWindow;

/** marked plus the sanitizer, as renderContent does it. */
function render(md: string): HTMLElement {
  const html = win.joindSanitizeHtml!(win.marked.parse(md));
  const el = win.document.createElement("div");
  el.innerHTML = html;
  return el;
}

function vendored(prefix: string): string {
  const f = readdirSync(join(PUB, "vendor")).find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`vendored ${prefix} missing`);
  return readFileSync(join(PUB, "vendor", f), "utf8");
}

beforeAll(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only" });
  win = dom.window as unknown as PageWindow;
  win.eval(vendored("marked-"));
  win.eval(vendored("purify-"));
  win.eval(readFileSync(join(PUB, "sanitize.js"), "utf8"));
  win.marked.setOptions({ breaks: true, gfm: true });
});

/** Every attribute of every element, lower-cased names. */
function attrs(root: HTMLElement): Array<{ tag: string; name: string; value: string }> {
  const out: Array<{ tag: string; name: string; value: string }> = [];
  for (const el of Array.from(root.querySelectorAll("*"))) {
    for (const a of Array.from(el.attributes)) out.push({ tag: el.tagName, name: a.name.toLowerCase(), value: a.value });
  }
  return out;
}

function assertInert(root: HTMLElement): void {
  for (const a of attrs(root)) {
    expect(a.name.startsWith("on"), `${a.tag} ${a.name}`).toBe(false);
    if (a.name === "href" || a.name === "src") {
      expect(/^\s*(javascript|vbscript|data):/i.test(a.value), `${a.tag} ${a.name}=${a.value}`).toBe(false);
    }
    expect(a.name).not.toBe("style");
  }
  expect(root.querySelector("script, svg, math, iframe, object, embed, style, form, textarea, select, button, link, meta, base")).toBeNull();
}

describe("message HTML is sanitized before it reaches the DOM", () => {
  it("loads the vendored, pinned marked and DOMPurify", () => {
    expect(readdirSync(join(PUB, "vendor")).sort()).toEqual(["marked-17.0.5.umd.js", "purify-3.4.16.min.js"]);
    expect(typeof win.joindSanitizeHtml).toBe("function");
  });

  it("drops the onerror handler of a raw image", () => {
    const el = render("hi <img src=x onerror=alert(1)> there");
    assertInert(el);
    const img = el.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("x");
    expect(el.textContent).toContain("hi");
  });

  it("strips javascript:, vbscript: and data: links in every spelling", () => {
    const cases = [
      "[click](javascript:alert(1))",
      '<a href="JaVaScRiPt:alert(1)">x</a>',
      '<a href="java&#x09;script:alert(1)">x</a>',
      '<a href=" javascript:alert(1)">x</a>',
      '<a href="&#106;avascript:alert(1)">x</a>',
      "[v](vbscript:msgbox(1))",
      "[d](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
      "![img](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)",
      '<img src="data:image/png;base64,AAAA">',
      '<a href="file:///C:/Windows/win.ini">f</a>',
    ];
    for (const md of cases) {
      const el = render(md);
      assertInert(el);
      for (const a of Array.from(el.querySelectorAll("a"))) expect(a.hasAttribute("href"), md).toBe(false);
      for (const i of Array.from(el.querySelectorAll("img"))) expect(i.hasAttribute("src"), md).toBe(false);
    }
  });

  it("removes svg, script, iframe, style and forms, and inline handlers everywhere", () => {
    const md = [
      "<svg onload=alert(1)><circle r=5 /></svg>",
      "<script>window.pwned = true</script>",
      '<iframe src="https://example.com"></iframe>',
      "<style>body{display:none}</style>",
      '<form action="https://evil.example"><input type="text" name="t"><button>go</button></form>',
      '<p onclick="alert(1)" style="position:fixed">styled</p>',
      '<a href="https://example.com" onmouseover="alert(1)">hover</a>',
      "<details open ontoggle=alert(1)><summary>s</summary>inside</details>",
      '<math><mi xlink:href="javascript:alert(1)">m</mi></math>',
    ].join("\n\n");
    const el = render(md);
    assertInert(el);
    expect(el.textContent).toContain("styled");
    expect(el.textContent).toContain("inside");
    expect(el.querySelector("input")).toBeNull();
    expect(win.pwned).toBeUndefined();
  });

  it("drops page classes but keeps a code block's language class", () => {
    const el = render('<div class="ask-chip open">fake chip</div>\n\n```js\nlet x = 1;\n```');
    expect(el.querySelector(".ask-chip")).toBeNull();
    expect(el.querySelector("code")!.getAttribute("class")).toBe("language-js");
  });

  it("still renders the Markdown messages use today", () => {
    const md = [
      "# Heading", "## Sub", "Some *em*, **strong**, ~~gone~~ and `code`.",
      "- one\n- two", "1. first\n2. second",
      "> quoted", "---",
      "| a | b |\n|:--|--:|\n| 1 | 2 |",
      "```\nblock\n```",
      "[site](https://example.com/page#frag) and <https://example.org> and [rel](/data/files/x.png) and [anchor](#top)",
      "![pic](https://example.com/p.png) ![up](/data/files/a.png)",
      "- [x] done\n- [ ] todo",
      "mail [me](mailto:a@b.c)",
    ].join("\n\n");
    const el = render(md);
    assertInert(el);
    for (const tag of ["h1", "h2", "em", "strong", "del", "code", "ul", "ol", "li", "blockquote", "hr", "table", "th", "td", "pre", "img"]) {
      expect(el.querySelector(tag), tag).not.toBeNull();
    }
    const hrefs = Array.from(el.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://example.com/page#frag", "https://example.org", "/data/files/x.png", "#top", "mailto:a@b.c"]);
    for (const a of Array.from(el.querySelectorAll("a"))) expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(Array.from(el.querySelectorAll("img")).map((i) => i.getAttribute("src"))).toEqual(["https://example.com/p.png", "/data/files/a.png"]);
    const boxes = Array.from(el.querySelectorAll("input"));
    expect(boxes.length).toBe(2);
    for (const b of boxes) {
      expect(b.getAttribute("type")).toBe("checkbox");
      expect(b.hasAttribute("disabled")).toBe(true);
    }
    expect(el.querySelector("th")!.getAttribute("align")).toBe("left");
  });

  it("keeps text such as @names and #N for the DOM passes that follow", () => {
    const el = render("@Odo see #12 and `#5`");
    expect(el.textContent!.trim()).toBe("@Odo see #12 and #5");
    expect(el.querySelector("code")!.textContent).toBe("#5");
  });
});
