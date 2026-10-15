// Handling for a root layout that returns a full `<html>…</html>` document.
//
// A root layout may return its children (Farm then renders the document shell)
// or a whole document, as the create-app templates do. A whole document is
// composed as the response, with Farm's assets merged into it, rather than
// nested inside the generated shell, which would emit invalid nested
// `<html>`/`<head>`/`<body>`. This mirrors the production (Nitro) build's
// `hasFullDocument` path so dev and prod agree.

/** Peel Farm's leading `display:contents` wrapper divs (the stream root and any
 * layout-boundary divs) so the layout's own markup is exposed for inspection. */
function stripContentsWrappers(markup: string): string {
  let out = markup.replace(/^\s+/, "");
  const opener = /^<div\b[^>]*style="display\s*:\s*contents"[^>]*>/i;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(out))) {
    out = out.slice(match[0].length).replace(/^\s+/, "");
  }
  return out;
}

/**
 * When `markup` (a rendered layout tree, possibly wrapped in Farm's
 * `display:contents` boundary divs) is a full HTML document, return just that
 * `<html>…</html>` document (leading `<!DOCTYPE>` preserved when present);
 * otherwise return `null`.
 */
export function extractFarmFullDocument(markup: string): string | null {
  const inner = stripContentsWrappers(markup);
  if (!/^<!doctype/i.test(inner) && !/^<html[\s>]/i.test(inner)) return null;
  const start = markup.search(/<!doctype|<html[\s>]/i);
  const lower = markup.toLowerCase();
  let closeIndex = lower.lastIndexOf("</html>");
  // Keep the existing search for length-preserving case conversion. Unicode
  // such as İ expands when lowercased, so only then recover original offsets.
  if (lower.length !== markup.length) {
    closeIndex = -1;
    const closing = /<\/html>/gi;
    let match;
    while ((match = closing.exec(markup))) closeIndex = match.index;
  }
  if (start < 0 || closeIndex < 0) return null;
  const closeEnd = closeIndex + "</html>".length;
  let document = markup.slice(start, closeEnd);
  // React may flush Suspense reveal scripts after closing the app-authored
  // document and Farm's outer segment wrappers. Preserve that streamed tail
  // by moving it back inside the document body.
  const streamedTail = markup
    .slice(closeEnd)
    .replace(/^(?:\s*<\/div>)+/i, "")
    .trim();
  if (streamedTail) {
    document = document.replace(/<\/body>/i, () => `${streamedTail}</body>`);
  }
  return document;
}

/** True when a rendered layout tree is (or wraps) a full HTML document. */
export function isFarmFullDocument(markup: string): boolean {
  return extractFarmFullDocument(markup) !== null;
}

/**
 * True when `markup` *begins* a full HTML document once Farm's wrappers are
 * peeled — usable on a streamed prefix, before the closing `</html>` has been
 * flushed.
 */
export function opensFarmFullDocument(markup: string): boolean {
  const inner = stripContentsWrappers(markup);
  return /^<!doctype/i.test(inner) || /^<html[\s>]/i.test(inner);
}

/**
 * Give a layout's document a `<head>` when it renders none. `<head>` is optional in
 * HTML and React, but Farm's managed head assets (route props, the client runtime,
 * styles) are inserted before `</head>`, and without one they would be dropped and
 * the page would never hydrate. Matches the production build's helper.
 */
export function ensureFarmDocumentHead(markup: string): string {
  if (/<head[\s>]/i.test(markup)) return markup;
  return markup.replace(/<html([^>]*)>/i, (_match, attributes: string) => {
    return `<html${attributes}><head></head>`;
  });
}

/**
 * Wrap the body's content in the `#root` element the client hydrates, unless the document
 * already has one. Matches the production build's helper.
 */
export function ensureFarmDocumentRoot(markup: string): string {
  if (/\sid=["']root["']/i.test(markup)) return markup;
  return markup
    .replace(
      /<body\b([^>]*)>/i,
      (_match, attributes: string) => `<body${attributes}><div id="root">`,
    )
    .replace(/<\/body>/i, () => "</div></body>");
}

/** True when the markup already links a favicon. Matches the production build's helper. */
export function hasFarmDocumentIcon(markup: string): boolean {
  return /<link\b[^>]*\brel=["']?(?:shortcut )?icon\b/i.test(markup);
}

/** Remove document title elements before inserting a higher-priority title. */
export function removeFarmDocumentTitles(markup: string): string {
  return markup.replace(/<title\b[^>]*>[\s\S]*?<\/title>\s*/gi, "");
}

export interface FarmFullDocumentAssets {
  /** Farm-managed `<head>` markup (styles, client/runtime scripts, metadata). */
  headAssets: string;
  /** Markup injected just before `</body>` (client bootstrap / entry scripts). */
  bodyFooter: string;
  /** Extra `<html>` attributes to merge (theme, direction). */
  htmlAttributes?: string;
  /** Existing attributes Farm owns and must replace before merging. */
  replaceHtmlAttributes?: readonly string[];
  /**
   * Add `<link rel="icon" href="data:,">` unless the document already links an icon, so
   * the browser doesn't request a missing /favicon.ico. Matches the generated shell.
   */
  fallbackIcon?: boolean;
}

/**
 * Compose a layout's own full document with Farm's managed head + body assets,
 * instead of nesting it inside the shell. String replacements use function
 * replacers so any `$`-sequences (`$&`, `$'`, `$$`) in the injected markup or
 * the document are inserted literally rather than expanded.
 */
export function composeFarmFullDocument(
  documentHtml: string,
  assets: FarmFullDocumentAssets,
): string {
  let html = ensureFarmDocumentHead(documentHtml);

  if (assets.htmlAttributes) {
    html = html.replace(/<html\b([^>]*)>/i, (_match, attrs: string) => {
      let nextAttributes = attrs;
      for (const name of assets.replaceHtmlAttributes ?? []) {
        const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        nextAttributes = nextAttributes.replace(
          new RegExp("\\s+" + escapedName + "=(?:\"[^\"]*\"|'[^']*'|[^\\s>]+)", "gi"),
          "",
        );
      }
      return `<html${nextAttributes}${assets.htmlAttributes}>`;
    });
  }

  html = ensureFarmDocumentRoot(html);

  const headAssets = [
    assets.fallbackIcon && !hasFarmDocumentIcon(html) ? '<link rel="icon" href="data:,">' : "",
    assets.headAssets,
  ]
    .filter(Boolean)
    .join("\n  ");
  if (headAssets) {
    html = html.replace(/<\/head>/i, () => `  ${headAssets}\n</head>`);
  }
  if (assets.bodyFooter) {
    html = html.replace(/<\/body>/i, () => `  ${assets.bodyFooter}\n</body>`);
  }

  return /^\s*<!doctype/i.test(html) ? html : `<!DOCTYPE html>\n${html}`;
}
