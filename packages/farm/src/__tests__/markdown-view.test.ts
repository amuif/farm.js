// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createFarmMarkdownSourceResponse } from "../app-markdown-runtime";
import { createMarkdownMirrorResponse, resolveMarkdownConfig } from "../markdown";
import {
  createFarmMarkdownETag,
  parseFarmMarkdownHeadings,
  selectFarmMarkdownView,
} from "../markdown-view";

const pricing = `---
title: Pricing
---

# Pricing

Plans for every team.

## Plans

### Free

Up to 3 projects.

### Pro

Unlimited projects.

## FAQ

\`\`\`md
## Not a heading
\`\`\`

## FAQ

Second FAQ heading.
`;

describe("Markdown sections", () => {
  it("parses headings with GitHub-style ids, skipping front matter and code fences", () => {
    expect(
      parseFarmMarkdownHeadings(pricing).map(({ id, level, text }) => ({ id, level, text })),
    ).toEqual([
      { id: "pricing", level: 1, text: "Pricing" },
      { id: "plans", level: 2, text: "Plans" },
      { id: "free", level: 3, text: "Free" },
      { id: "pro", level: 3, text: "Pro" },
      { id: "faq", level: 2, text: "FAQ" },
      { id: "faq-1", level: 2, text: "FAQ" },
    ]);
  });

  it("returns one section with its subsections", () => {
    const view = selectFarmMarkdownView(
      pricing,
      new URLSearchParams("section=plans"),
      "/pricing.md",
    );
    expect(view).toEqual({
      status: 200,
      body: "## Plans\n\n### Free\n\nUp to 3 projects.\n\n### Pro\n\nUnlimited projects.\n",
    });
  });

  it("lists the outline with section links and token estimates", () => {
    const view = selectFarmMarkdownView(pricing, new URLSearchParams("outline"), "/pricing.md");
    expect(view.status).toBe(200);
    expect(view.body).toContain("# Outline of /pricing.md");
    expect(view.body).toContain("- [Pricing](/pricing.md?section=pricing) ~");
    expect(view.body).toContain("  - [Plans](/pricing.md?section=plans) ~");
    expect(view.body).toContain("    - [Pro](/pricing.md?section=pro) ~");
    expect(view.body).toContain("  - [FAQ](/pricing.md?section=faq-1) ~");
    expect(view.body).not.toContain("Not a heading");
  });

  it("answers an unknown section with a 404 that lists the valid ids", () => {
    const view = selectFarmMarkdownView(
      pricing,
      new URLSearchParams("section=enterprise"),
      "/pricing.md",
    );
    expect(view.status).toBe(404);
    expect(view.body).toContain("`enterprise` is not a section of /pricing.md");
    expect(view.body).toContain("- `plans`");
  });

  it("returns the whole document without outline or section", () => {
    expect(selectFarmMarkdownView(pricing, new URLSearchParams(), "/pricing.md")).toEqual({
      status: 200,
      body: pricing,
    });
  });
});

describe("Markdown responses", () => {
  const html =
    "<html><head><title>Pricing</title></head><body><main><h1>Pricing</h1><h2>Plans</h2><p>Free and Pro.</p><h2>FAQ</h2><p>Questions.</p></main></body></html>";
  const mirror = (url: string, init: RequestInit = {}) =>
    createMarkdownMirrorResponse({
      request: new Request(url, init),
      config: resolveMarkdownConfig({ expose: ["/pricing"] }),
      renderPage: async () =>
        new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    });

  it("serves sections of a generated mirror", async () => {
    const response = await mirror("http://farm.test/pricing.md?section=faq");
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("## FAQ\n\nQuestions.\n");
  });

  it("adds an ETag and answers If-None-Match with 304", async () => {
    const first = await mirror("http://farm.test/pricing.md");
    const etag = first?.headers.get("etag");
    expect(etag).toMatch(/^W\/"/);
    expect(etag).toBe(createFarmMarkdownETag(await first!.text()));

    const second = await mirror("http://farm.test/pricing.md", {
      headers: { "If-None-Match": etag! },
    });
    expect(second?.status).toBe(304);
    expect(await second?.text()).toBe("");
    expect(second?.headers.get("etag")).toBe(etag);
  });

  it("gives each view its own ETag", async () => {
    const whole = await mirror("http://farm.test/pricing.md");
    const section = await mirror("http://farm.test/pricing.md?section=plans");
    expect(whole?.headers.get("etag")).not.toBe(section?.headers.get("etag"));
  });

  it("applies the same views to page.md sources", async () => {
    const response = await createFarmMarkdownSourceResponse({
      request: new Request("http://farm.test/pricing?outline", {
        headers: { Accept: "text/markdown" },
      }),
      resolveSource: () => ({ source: pricing, filePath: "/app/src/app/pricing/page.md" }),
    });
    expect(response?.status).toBe(200);
    expect(response?.headers.get("etag")).toMatch(/^W\/"/);
    expect(await response?.text()).toContain("- [Plans](/pricing.md?section=plans)");
  });

  it("keeps HEAD bodiless", async () => {
    const response = await mirror("http://farm.test/pricing.md?section=plans", { method: "HEAD" });
    expect(response?.status).toBe(200);
    expect(response?.headers.get("etag")).toMatch(/^W\/"/);
    expect(await response?.text()).toBe("");
  });
});
