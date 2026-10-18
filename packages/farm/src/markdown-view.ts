/**
 * Partial reads of a Markdown representation for agents: `?outline` returns the
 * heading tree, `?section=<id>` returns one section. Every Markdown response also
 * carries an ETag so an agent can re-check a page with `If-None-Match`.
 */

export interface FarmMarkdownHeading {
  /** GitHub-style slug, unique within the document. */
  id: string;
  level: number;
  text: string;
  /** Line index of the heading. */
  start: number;
  /** Line index where the section ends (exclusive): the next heading at the same or a higher level. */
  end: number;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^\s{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

/** Parse ATX headings, skipping front matter and fenced code blocks. */
export function parseFarmMarkdownHeadings(markdown: string): FarmMarkdownHeading[] {
  const lines = markdown.split("\n");
  const headings: FarmMarkdownHeading[] = [];
  const used = new Map<string, number>();
  let index = 0;

  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, lineIndex) => lineIndex > 0 && line.trim() === "---");
    if (close > 0) index = close + 1;
  }

  let fence: string | null = null;
  for (; index < lines.length; index++) {
    const line = lines[index];
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const match = ATX_HEADING.exec(line);
    if (!match) continue;
    const text = match[2].trim();
    const base = slugifyHeading(text) || "section";
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    headings.push({
      id: count === 0 ? base : `${base}-${count}`,
      level: match[1].length,
      text,
      start: index,
      end: lines.length,
    });
  }

  for (let headingIndex = 0; headingIndex < headings.length; headingIndex++) {
    const heading = headings[headingIndex];
    const next = headings
      .slice(headingIndex + 1)
      .find((candidate) => candidate.level <= heading.level);
    if (next) heading.end = next.start;
  }

  return headings;
}

/** GitHub's heading anchor rules: lowercase, drop punctuation, spaces to hyphens. */
function slugifyHeading(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

/** Rough token estimate for budgeting: about four characters per token. */
export function estimateFarmMarkdownTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface FarmMarkdownView {
  status: number;
  body: string;
}

/**
 * Select the part of a Markdown document a request asks for. Returns the whole
 * document when the request has neither `outline` nor `section`.
 */
export function selectFarmMarkdownView(
  markdown: string,
  searchParams: URLSearchParams,
  markdownPath: string,
): FarmMarkdownView {
  const wantsOutline = searchParams.has("outline");
  const sectionId = searchParams.get("section");
  if (!wantsOutline && sectionId === null) return { status: 200, body: markdown };

  const lines = markdown.split("\n");
  const headings = parseFarmMarkdownHeadings(markdown);
  const sectionText = (heading: FarmMarkdownHeading) =>
    lines.slice(heading.start, heading.end).join("\n").trim();

  if (sectionId !== null) {
    const heading = headings.find((candidate) => candidate.id === sectionId);
    if (heading) return { status: 200, body: `${sectionText(heading)}\n` };
    const available = headings.map((candidate) => `- \`${candidate.id}\``).join("\n");
    return {
      status: 404,
      body:
        `# Section not found\n\n\`${sectionId}\` is not a section of ${markdownPath}.\n\n` +
        (available ? `Available sections:\n\n${available}\n` : "This page has no sections.\n"),
    };
  }

  const minLevel = Math.min(...headings.map((heading) => heading.level));
  const entries = headings.map((heading) => {
    const indent = "  ".repeat(heading.level - minLevel);
    const tokens = estimateFarmMarkdownTokens(sectionText(heading));
    return `${indent}- [${heading.text}](${markdownPath}?section=${encodeURIComponent(heading.id)}) ~${tokens} tokens`;
  });
  return {
    status: 200,
    body:
      `# Outline of ${markdownPath}\n\n` +
      `About ${estimateFarmMarkdownTokens(markdown)} tokens in total. Request one section with \`?section=<id>\`.\n\n` +
      (entries.length > 0 ? `${entries.join("\n")}\n` : "This page has no headings.\n"),
  };
}

/** Weak ETag over the body, synchronous so it works on every runtime. */
export function createFarmMarkdownETag(body: string): string {
  // cyrb53: fast, well-distributed, and no dependency on node:crypto.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < body.length; index++) {
    const code = body.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  return `W/"${hash}-${body.length.toString(36)}"`;
}

function ifNoneMatchIncludes(header: string | null, etag: string): boolean {
  if (!header) return false;
  const opaque = etag.replace(/^W\//, "");
  return header
    .split(",")
    .map((token) => token.trim())
    .some((token) => token === "*" || token.replace(/^W\//, "") === opaque);
}

/**
 * Build the final Markdown response: apply `?outline` / `?section`, add an
 * ETag, and answer a matching `If-None-Match` with 304.
 */
export function createFarmMarkdownViewResponse(options: {
  request: Request;
  requestUrl?: URL;
  markdown: string;
  status: number;
  headers: Headers;
  markdownPath: string;
}): Response {
  const url = options.requestUrl ?? new URL(options.request.url);
  const view = selectFarmMarkdownView(options.markdown, url.searchParams, options.markdownPath);
  const status = view.status === 200 ? options.status : view.status;
  const etag = createFarmMarkdownETag(view.body);
  options.headers.set("ETag", etag);

  if (status === 200 && ifNoneMatchIncludes(options.request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: options.headers });
  }
  return new Response(options.request.method === "HEAD" ? null : view.body, {
    status,
    headers: options.headers,
  });
}
