// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  createFarmMarkdownViewResponse,
  estimateFarmMarkdownTokens,
  selectFarmMarkdownView,
} from "../markdown-view";

const paragraph = (index: number) =>
  `Paragraph ${index} explains one part of the guide in enough words to take up some room in a part.`;

const guide = [
  "# Guide",
  "",
  ...Array.from({ length: 6 }, (_, section) => [
    `## Step ${section + 1}`,
    "",
    ...Array.from({ length: 4 }, (_, item) => [paragraph(section * 4 + item), ""]).flat(),
  ]).flat(),
].join("\n");

const view = (markdown: string, query: string) =>
  selectFarmMarkdownView(markdown, new URLSearchParams(query), "/guide.md");

/** Follows Continue links from the first part, returning each part's body without its footer. */
function readAll(markdown: string, query: string) {
  const parts: string[] = [];
  let next: string | undefined = `/guide.md?${query}`;
  while (next) {
    const result = view(markdown, next.split("?")[1]!);
    expect(result.status).toBe(200);
    const match = /\n\n---\n\nContinue: (\S+) \(about \d+ more tokens\)\n$/.exec(result.body);
    expect(result.headers?.Link).toBe(match ? `<${match[1]}>; rel="next"` : undefined);
    parts.push(match ? result.body.slice(0, match.index) : result.body.replace(/\n$/, ""));
    next = match?.[1];
    expect(parts.length).toBeLessThan(50);
  }
  return parts;
}

describe("Markdown token budgets", () => {
  it("reads a long page in parts that fit the budget and rejoin into the page", () => {
    const parts = readAll(guide, "max_tokens=100");
    expect(parts.length).toBeGreaterThan(3);
    for (const part of parts) {
      expect(estimateFarmMarkdownTokens(part)).toBeLessThanOrEqual(100);
      // Cut where a reader pauses: each part starts at a heading or a paragraph.
      expect(part).toMatch(/^(#|Paragraph)/);
    }
    expect(parts.join("\n\n")).toBe(guide.replace(/\n+$/, ""));
  });

  it("returns a page that already fits unchanged, with no continuation", () => {
    expect(view("# Short\n\nOne line.\n", "max_tokens=100")).toEqual({
      status: 200,
      body: "# Short\n\nOne line.\n",
    });
  });

  it("closes a code block that does not fit and reopens it in the next part", () => {
    const code = Array.from({ length: 80 }, (_, index) => `  const value${index} = ${index};`);
    const markdown = ["# Code", "", "```ts", ...code, "```", "", "After the code."].join("\n");
    const parts = readAll(markdown, "max_tokens=100");
    expect(parts.length).toBeGreaterThan(2);
    for (const [index, part] of parts.entries()) {
      const fences = part.split("\n").filter((line) => line.startsWith("```"));
      // Every part is valid Markdown on its own: its fences pair up.
      expect(fences.length % 2).toBe(0);
      if (index > 0 && index < parts.length - 1) expect(part.startsWith("```ts\n")).toBe(true);
    }
    expect(parts.at(-1)).toContain("After the code.");
    const rejoined = parts
      .join("\n")
      .replace(/\n```\n```ts\n/g, "\n")
      .replace(/\n\n/g, "\n");
    expect(rejoined).toContain(code.join("\n"));
  });

  it("keeps the section in continuation links", () => {
    const first = view(guide, "section=step-2&max_tokens=100");
    expect(first.body.startsWith("## Step 2\n")).toBe(true);
    expect(first.headers?.Link).toMatch(
      /^<\/guide\.md\?section=step-2&max_tokens=100&cursor=\d+\.[0-9a-z]+>; rel="next"$/,
    );
    const parts = readAll(guide, "section=step-2&max_tokens=100");
    expect(parts.join("\n\n")).not.toContain("Step 3");
    expect(parts.join("\n\n")).toContain(paragraph(7));
  });

  it("reports a page that changed between parts, and rejects bad budgets and cursors", () => {
    const first = view(guide, "max_tokens=100");
    const cursor = /cursor=([^>]+)>/.exec(first.headers!.Link!)![1]!;
    const changed = view(
      guide.replace("Paragraph 3", "Paragraph three"),
      `max_tokens=100&cursor=${cursor}`,
    );
    expect(changed.status).toBe(409);
    expect(changed.body).toContain("Start again at /guide.md?max_tokens=100.");

    for (const query of ["max_tokens=99", "max_tokens=abc", "max_tokens=", "max_tokens=1e3"]) {
      expect(view(guide, query).status).toBe(400);
    }
    for (const cursor of ["0.abc", "9999.abc", "x", "3"]) {
      expect(view(guide, `max_tokens=100&cursor=${cursor}`).status).toBe(400);
    }
  });

  it("sends the Link header and keeps ETags on a part", async () => {
    const request = (headers: HeadersInit = {}) =>
      createFarmMarkdownViewResponse({
        request: new Request("https://acme.test/guide.md?max_tokens=100", { headers }),
        markdown: guide,
        status: 200,
        headers: new Headers({ "Content-Type": "text/markdown; charset=utf-8" }),
        markdownPath: "/guide.md",
      });
    const response = request();
    expect(response.headers.get("link")).toMatch(/^<\/guide\.md\?max_tokens=100&cursor=/);
    expect((await response.text()).startsWith("# Guide\n")).toBe(true);
    expect(request({ "if-none-match": response.headers.get("etag")! }).status).toBe(304);
  });

  it("points the outline at budgeted reads", () => {
    expect(view(guide, "outline").body).toContain("or read in parts with `?max_tokens=<n>`");
  });
});
