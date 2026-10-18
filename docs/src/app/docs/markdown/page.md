---
title: "Markdown Mirrors"
description: "Expose markdown versions of app pages so agents, crawlers, docs tools, and support workflows can read rendered content as text."
section: "Content"
---

# Markdown Mirrors

Expose markdown versions of app pages so agents, crawlers, docs tools, and support workflows can read rendered content as text.

Every app page receives a markdown representation automatically:

- `page.tsx` routes are rendered on the server and converted into markdown.
- `page.md` and `page.mdx` routes return their original source.
- A `page.md` beside `page.tsx` overrides the generated representation without replacing the
  React page.

No configuration is required. Use source-authored pages for static content such as about pages,
policies, changelogs, and content-heavy marketing pages. Keep `page.tsx` as the canonical page when
the visual route needs React, and add a sidecar only when its generated markdown needs a curated
replacement.

## Representation precedence

| Files in a route folder      | HTML page         | Markdown representation |
| ---------------------------- | ----------------- | ----------------------- |
| `page.tsx`                   | Rendered React UI | Generated from HTML     |
| `page.tsx` and `page.md`     | Rendered React UI | Exact `page.md` source  |
| `page.md` or `page.mdx` only | Rendered Markdown | Exact source            |

## Markdown app pages

**src/app/about/page.mdx**

```mdx
---
title: About Farm
description: A markdown-first static page.
---

# About Farm

<Callout>Farm can render MDX from the app router.</Callout>
```

This creates `/about` automatically. Because the route is source-authored markdown, Farm also serves the raw source at `/about.md` by default.

## Override a React page

Keep the visual page in React:

**src/app/pricing/page.tsx**

```tsx
export default function PricingPage() {
  return <PricingCalculator />;
}
```

Then add an optional agent-focused representation beside it:

**src/app/pricing/page.md**

```md
# Pricing

Farm.js is free and open source.

## Plans

- Community: free
- Cloud: contact us
```

The browser still renders `page.tsx` at `/pricing`. Requests to `/pricing.md`, or requests to
`/pricing` with `Accept: text/markdown`, receive the exact contents of `page.md`.

## Configure MDX components

**farm.config.ts**

```ts
export default defineConfig({
  mdx: {
    components: "./src/markdown-components.tsx",
    markdownRoutes: true,
  },
});
```

**src/markdown-components.tsx**

```tsx
import { Callout } from "./components/callout";

export const components = {
  Callout,
};
```

Set `mdx.markdownRoutes` to `false` when source-authored pages should render as HTML only.

### Interactive components

A `"use client"` component the components module imports hydrates as an island in React apps, so
it works inside Markdown pages, including under a layout that hydrates as a whole route. The rest
of the page stays server HTML. Island props must be serializable, the same limit as other islands.

```tsx title="src/components/copy-button.tsx"
"use client";

import { useState } from "react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true))}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
```

Islands need `mdx.components` to be a module path. Components from a package that marks itself
`"use client"` render as static HTML on Markdown pages, and Farm logs which packages it left static.

## Restrict exposed pages

Automatic mirrors include all application page routes. Restrict them when an application contains
authenticated or private pages:

**farm.config.ts**

```ts
export default defineConfig({
  md: {
    expose: ["/", "/pricing", "/docs"],
    cache: 60,
  },
});
```

## Routes

| Page     | Markdown mirror |
| -------- | --------------- |
| /        | /index.md       |
| /pricing | /pricing.md     |
| /docs    | /docs.md        |

## Use cases

- AI assistants can fetch page content without parsing the full app shell.
- Pricing, docs, changelog, and policy pages become easy to cite.
- Teams can keep one source of truth: the actual rendered page.

Disable generated mirrors for every React page with `md: false`:

```ts
export default defineConfig({
  md: false,
});
```

Explicit `page.md` and `page.mdx` sources use `mdx.markdownRoutes`; set that option to `false` when
their raw routes must also be disabled.

## llms.txt

Set `agent: { llmsTxt: true }` to publish `/llms.txt`, an index that points language models at these
mirrors, and `/llms-full.txt`, which inlines them. See
[Agent readiness](/docs/configuration#agent-readiness).

## Per-route options

Routes can include a display title and cache override.

```ts
export default defineConfig({
  md: {
    expose: [
      {
        route: "/pricing",
        title: "Pricing",
        cache: 300,
      },
      "/docs/[...slug]",
    ],
    includeMetadata: true,
  },
});
```

## What gets returned

Markdown mirrors call the rendered page, strip scripts/styles and elements hidden by an attribute (`aria-hidden="true"`, or `hidden` except `hidden="until-found"`, which the browser can reveal), convert HTML headings, paragraphs, lists (ordered lists keep their numbers), blockquotes, tables (as GFM tables), and code blocks (keeping a `language-*` class or `data-language` as the fence language) into markdown, then return `text/markdown`. The mirror is built without CSS, so text hidden only by a stylesheet (`display: none`, a collapsed menu) still appears. Mark decorative text `aria-hidden` to keep it out of the mirror as well as out of screen readers.

**Terminal**

```bash
curl http://localhost:3000/pricing.md
```

Agents can also request the normal page URL with explicit content negotiation:

```bash
curl -H "Accept: text/markdown" http://localhost:3000/pricing
```

Farm returns the same markdown representation with `Content-Type: text/markdown`,
`Content-Location: /pricing.md`, and `Vary: Accept`. The HTML response also advertises the
`.md` URL through a `Link` header and a `<link rel="alternate" type="text/markdown">` tag in the
document head, while ordinary browser requests continue to receive HTML. Set
`metadata.alternates.types["text/markdown"]` to point the head link somewhere else.

Prerendered pages, such as those exporting `dynamic = "force-static"`, are served as static files in
production, so they answer every request with HTML. They still send the `Link` header, and their
`.md` URL works, so agents should follow the header or request the `.md` URL directly.

## Read part of a page

Agents can fetch less than the whole page. Every Markdown response, from a mirror or a `page.md`,
accepts two query parameters:

```bash
curl "http://localhost:3000/pricing.md?outline"
curl "http://localhost:3000/pricing.md?section=plans"
```

- `?outline` returns the heading tree. Each entry links to its section and estimates its size in
  tokens, so an agent can decide what to read.
- `?section=<id>` returns one heading and everything under it, up to the next heading at the same
  or a higher level. Ids follow GitHub's heading anchors (`## Team plans` is `team-plans`; a
  repeated heading gets `-1`, `-2`). An unknown id answers `404` with the list of valid ids.

Headings inside fenced code blocks and front matter are ignored. Every Markdown response also
carries an `ETag`, so an agent can re-check a page with `If-None-Match` and receive `304 Not
Modified` when it has not changed.

## Describe a page's forms

The mirror turns a form's labels and buttons into text, but not what the form submits. When a page
has forms, its mirror lists one more line under `Source:`:

```md
Source: /contact

Actions: /contact.md?actions
```

`?actions` answers with the page's forms as JSON, read from the same part of the page as the mirror
and with the same hidden-element rules:

```bash
curl "http://localhost:3000/contact.md?actions"
```

```json
{
  "page": "/contact",
  "markdown": "/contact.md",
  "actions": [
    {
      "type": "form",
      "method": "POST",
      "action": "/api/contact",
      "enctype": "application/x-www-form-urlencoded",
      "fields": [{ "name": "email", "type": "email", "label": "Email", "required": true }],
      "submit": [{ "label": "Send" }]
    }
  ]
}
```

- `action` is resolved the way a browser resolves it: an empty or missing `action` submits to the
  page itself. Same-origin targets are root-relative; a form that only submits through JavaScript
  has no `action` and is marked `requiresJavaScript`.
- `fields` carry each control's name, type, label, preset value, and constraints (`required`,
  `pattern`, `min`, `max`, `minLength`, `maxLength`, `accept`). Radio buttons and checkboxes that
  share a name become one field with `options`, as do a select's options. Disabled controls are left
  out, since a browser would not submit them. Hidden fields keep their values, so a submission
  without JavaScript can be repeated; password and file inputs never include a value.
- `submit` lists the buttons, with a button's own `formaction` or `formmethod` when it has one.
- A React server action form, rendered with React's hidden `$ACTION_` fields, includes
  `serverAction.id`.

A `page.md` source has no forms, so its `?actions` view is an empty list. The view carries an
`ETag` like every other Markdown response. Like the mirror itself, it is rendered with the caller's
request, so it shows the forms that caller would see.

## Production notes

- Restrict `md.expose` when authenticated or private pages should not have generated mirrors.
- Use `cache` for stable public pages.
- Add `page.md` beside `page.tsx` when the generated representation needs a precise override.
- Use `page.md` or `page.mdx` alone when markdown is the page source of truth.
- Use markdown mirrors for docs, pricing, policies, changelogs, release notes, and help center pages.
