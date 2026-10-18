import pc from "picocolors";
import type { FarmDoctorCheck, FarmDoctorCheckStatus } from "./doctor";

/**
 * `farm agent check`: probes a running app over HTTP the way an AI agent would
 * meet it, and reports which of Farm's agent surfaces answer and which are off.
 * It reads only public responses, so it works the same against `farm dev`, a
 * production build, or a deployed site.
 */

export interface FarmAgentCheckOptions {
  /** Base URL of the app, including its basePath. @default "http://localhost:3000" */
  url?: string;
  /** The page to check, relative to the base URL. @default "/" */
  path?: string;
  /** Path of the MCP endpoint. @default the catalog's MCP item, or "/api/mcp" */
  mcpPath?: string;
  /** Per-request timeout. @default 5000 */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface FarmAgentCheckReport {
  target: { url: string; page: string };
  health: "ready" | "attention" | "error";
  summary: Record<FarmDoctorCheckStatus, number>;
  checks: FarmDoctorCheck[];
}

interface Probe {
  status: number;
  type: string;
  headers: Headers;
  body: string;
}

const MISSING_PAGE = "__farm-agent-check-missing";

export async function runFarmAgentCheck(
  options: FarmAgentCheckOptions = {},
): Promise<FarmAgentCheckReport> {
  const base = new URL(options.url ?? "http://localhost:3000");
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error(`farm agent check needs an http(s) URL, not ${base.href}.`);
  }
  base.search = "";
  base.hash = "";
  const basePath = base.pathname.replace(/\/+$/, "");
  const at = (pathname: string) => new URL(`${basePath}${pathname}`, base.origin).href;
  const page = at(`/${(options.path ?? "/").replace(/^\/+/, "")}`);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const probe = async (url: string, init: RequestInit = {}): Promise<Probe> => {
    try {
      const response = await fetchImpl(url, {
        redirect: "follow",
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = init.method === "HEAD" ? "" : await response.text();
      return {
        status: response.status,
        type: response.headers.get("content-type")?.toLowerCase() ?? "",
        headers: response.headers,
        body,
      };
    } catch (error) {
      const reason =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
          ? `timed out after ${timeoutMs}ms`
          : "could not connect";
      return { status: 0, type: "", headers: new Headers(), body: reason };
    }
  };

  const checks: FarmDoctorCheck[] = [];
  const add = (check: FarmDoctorCheck) => checks.push(check);

  const html = await probe(page, { headers: { accept: "text/html" } });
  if (html.status === 0 || !html.type.includes("html")) {
    add({
      status: "fail",
      code: "AGENT_PAGE_UNREACHABLE",
      title: "Page did not answer with HTML",
      message:
        html.status === 0
          ? `${page}: ${html.body}.`
          : `${page} answered ${html.status} ${html.type || "with no content type"}.`,
      action: "Start the app (farm dev or farm start), or pass its URL: farm agent check <url>.",
    });
    return finalize({ url: base.href, page }, checks);
  }

  checkMetadata(html, add);
  const mirrorUrl = await checkMarkdown(page, html, probe, at, add);
  if (mirrorUrl) await checkMarkdownViews(mirrorUrl, probe, add);
  await checkLlms(at, probe, add);
  await checkCrawlers(at, probe, add);
  await checkApis(at, probe, add, options.mcpPath);

  return finalize({ url: base.href, page }, checks);
}

function checkMetadata(html: Probe, add: (check: FarmDoctorCheck) => void): void {
  const missing: string[] = [];
  if (!/<title\b[^>]*>\s*[^<\s]/i.test(html.body)) missing.push("<title>");
  if (!/<meta\b[^>]*name=["']description["'][^>]*>/i.test(html.body)) {
    missing.push("meta description");
  }
  if (!/<link\b[^>]*rel=["'][^"']*canonical[^"']*["'][^>]*>/i.test(html.body)) {
    missing.push("canonical link");
  }
  if (!/<html\b[^>]*\blang=["'][^"']+["']/i.test(html.body)) missing.push("html lang");
  add(
    missing.length === 0
      ? {
          status: "pass",
          code: "AGENT_METADATA",
          title: "Page metadata",
          message: "Title, description, canonical link, and language are set.",
        }
      : {
          status: "warn",
          code: "AGENT_METADATA",
          title: "Page metadata is incomplete",
          message: `Missing: ${missing.join(", ")}.`,
          action: "Export metadata with a title and description from the page or root layout.",
        },
  );
  add(
    /<script\b[^>]*type=["']application\/ld\+json["']/i.test(html.body)
      ? {
          status: "pass",
          code: "AGENT_JSON_LD",
          title: "Structured data",
          message: "The page carries schema.org JSON-LD.",
        }
      : {
          status: "info",
          code: "AGENT_JSON_LD",
          title: "No structured data",
          message: "The page has no schema.org JSON-LD for agents to resolve the site's identity.",
          action: "Set agent: { jsonLd: true } in farm.config.",
        },
  );
}

async function checkMarkdown(
  page: string,
  html: Probe,
  probe: (url: string, init?: RequestInit) => Promise<Probe>,
  at: (pathname: string) => string,
  add: (check: FarmDoctorCheck) => void,
): Promise<string | undefined> {
  const linkHeader = /<([^>]+)>\s*;[^,]*rel="?alternate"?[^,]*type="?text\/markdown/i.exec(
    html.headers.get("link") ?? "",
  )?.[1];
  const linkTag =
    /<link\b(?=[^>]*rel=["']alternate["'])(?=[^>]*type=["']text\/markdown["'])[^>]*href=["']([^"']+)["']/i.exec(
      html.body,
    )?.[1];
  const advertised = linkHeader ?? linkTag;
  const pageUrl = new URL(page);
  const guess = new URL(
    pageUrl.pathname.endsWith("/") ? `${pageUrl.pathname}index.md` : `${pageUrl.pathname}.md`,
    pageUrl,
  ).href;
  const mirrorUrl = advertised ? new URL(advertised, page).href : guess;

  add(
    advertised
      ? {
          status: "pass",
          code: "AGENT_MARKDOWN_ADVERTISED",
          title: "Markdown mirror is advertised",
          message: `${linkHeader ? "Link header" : "<link> tag"} points at ${advertised}.`,
        }
      : {
          status: "warn",
          code: "AGENT_MARKDOWN_ADVERTISED",
          title: "Markdown mirror is not advertised",
          message: "The page sends no rel=alternate type=text/markdown link.",
          action: "Keep md enabled (the default) and expose this route in md.expose.",
        },
  );

  const mirror = await probe(mirrorUrl);
  if (mirror.status !== 200 || !mirror.type.startsWith("text/markdown")) {
    add({
      status: advertised ? "fail" : "warn",
      code: "AGENT_MARKDOWN_MIRROR",
      title: "Markdown mirror did not answer",
      message: `${mirrorUrl} answered ${mirror.status || mirror.body} ${mirror.type}.`.trim(),
      action: "Check md in farm.config; agents read pages through their .md mirror.",
    });
    return undefined;
  }
  add({
    status: "pass",
    code: "AGENT_MARKDOWN_MIRROR",
    title: "Markdown mirror",
    message: `${mirrorUrl} answers text/markdown (about ${Math.ceil(mirror.body.length / 4)} tokens).`,
  });

  const negotiated = await probe(page, { headers: { accept: "text/markdown" } });
  add(
    negotiated.type.startsWith("text/markdown")
      ? {
          status: "pass",
          code: "AGENT_MARKDOWN_NEGOTIATION",
          title: "Content negotiation",
          message: "Accept: text/markdown on the page URL returns Markdown.",
        }
      : {
          status: "info",
          code: "AGENT_MARKDOWN_NEGOTIATION",
          title: "Page URL does not negotiate Markdown",
          message:
            "Accept: text/markdown returned HTML. Prerendered pages are static files and cannot negotiate; agents follow the Link header to the .md URL instead.",
        },
  );

  const missing = await probe(at(`/${MISSING_PAGE}.md`));
  add(
    missing.status === 404 && missing.type.startsWith("text/markdown")
      ? {
          status: "pass",
          code: "AGENT_MARKDOWN_404",
          title: "Markdown 404",
          message: "A missing .md page answers 404 in Markdown.",
        }
      : {
          status: "warn",
          code: "AGENT_MARKDOWN_404",
          title: "Missing .md pages do not answer in Markdown",
          message:
            `A missing .md page answered ${missing.status || missing.body} ${missing.type}.`.trim(),
          action: "Upgrade @farm.js/core; agents should get a Markdown 404 they can read.",
        },
  );
  return mirrorUrl;
}

async function checkMarkdownViews(
  mirrorUrl: string,
  probe: (url: string, init?: RequestInit) => Promise<Probe>,
  add: (check: FarmDoctorCheck) => void,
): Promise<void> {
  const view = (query: string) => {
    const url = new URL(mirrorUrl);
    url.search = query;
    return probe(url.href);
  };
  const outline = await view("outline");
  // A server without budgets ignores the parameter, so ask for an invalid one:
  // only a server that reads it answers 400.
  const budget = await view("max_tokens=0");
  const plain = await probe(mirrorUrl);
  const supported = [
    outline.status === 200 && outline.body.startsWith("# Outline of") ? "?outline" : undefined,
    budget.status === 400 ? "?max_tokens" : undefined,
    plain.headers.get("etag") ? "ETag" : undefined,
  ].filter(Boolean);
  add(
    supported.length === 3
      ? {
          status: "pass",
          code: "AGENT_MARKDOWN_VIEWS",
          title: "Partial reads",
          message: "The mirror serves ?outline, ?section, ?max_tokens, and ETags.",
        }
      : {
          status: "info",
          code: "AGENT_MARKDOWN_VIEWS",
          title: "Partial reads are not available",
          message: `Supported: ${supported.join(", ") || "none"}. Agents read the whole page each time.`,
          action: "Upgrade @farm.js/core for ?outline, ?section, ?max_tokens, and ETags.",
        },
  );
}

async function checkLlms(
  at: (pathname: string) => string,
  probe: (url: string, init?: RequestInit) => Promise<Probe>,
  add: (check: FarmDoctorCheck) => void,
): Promise<void> {
  const llms = await probe(at("/llms.txt"));
  const isIndex = llms.status === 200 && llms.type.startsWith("text/") && /^#\s/.test(llms.body);
  add(
    isIndex
      ? {
          status: "pass",
          code: "AGENT_LLMS_TXT",
          title: "llms.txt",
          message: `Lists ${(llms.body.match(/^- \[/gm) ?? []).length} pages.`,
        }
      : {
          status: "warn",
          code: "AGENT_LLMS_TXT",
          title: "No llms.txt",
          message: `${at("/llms.txt")} answered ${llms.status || llms.body}.`,
          action: "Set agent: { llmsTxt: true } in farm.config, or add src/app/llms.ts.",
        },
  );
  if (!isIndex) return;
  const full = await probe(at("/llms-full.txt"), { method: "HEAD" });
  add(
    full.status === 200
      ? {
          status: "pass",
          code: "AGENT_LLMS_FULL",
          title: "llms-full.txt",
          message: "The full-text index answers.",
        }
      : {
          status: "info",
          code: "AGENT_LLMS_FULL",
          title: "No llms-full.txt",
          message: "Agents must fetch each page separately.",
          action: "Leave agent.llmsTxt.full on (the default with llmsTxt: true).",
        },
  );
}

async function checkCrawlers(
  at: (pathname: string) => string,
  probe: (url: string, init?: RequestInit) => Promise<Probe>,
  add: (check: FarmDoctorCheck) => void,
): Promise<void> {
  const robots = await probe(at("/robots.txt"));
  if (robots.status !== 200 || !robots.type.startsWith("text/plain")) {
    add({
      status: "info",
      code: "AGENT_ROBOTS",
      title: "No robots.txt",
      message: "Crawlers and AI agents get no rules.",
      action: 'Set agent: { crawlers: { search: "allow", training: "block" } } in farm.config.',
    });
  } else {
    add(
      blocksEveryone(robots.body)
        ? {
            status: "warn",
            code: "AGENT_ROBOTS",
            title: "robots.txt blocks every agent",
            message: "User-agent: * is disallowed from /.",
            action: 'Allow AI search agents with agent: { crawlers: { search: "allow" } }.',
          }
        : {
            status: "pass",
            code: "AGENT_ROBOTS",
            title: "robots.txt",
            message: `${(robots.body.match(/^user-agent:/gim) ?? []).length} user-agent groups.`,
          },
    );
  }
  const sitemap = await probe(at("/sitemap.xml"), { method: "HEAD" });
  add(
    sitemap.status === 200
      ? {
          status: "pass",
          code: "AGENT_SITEMAP",
          title: "sitemap.xml",
          message: "The sitemap answers.",
        }
      : {
          status: "info",
          code: "AGENT_SITEMAP",
          title: "No sitemap.xml",
          message: "Agents discover pages only through links and llms.txt.",
          action: "Add src/app/sitemap.ts.",
        },
  );
}

/** Whether the `User-agent: *` group disallows the whole site. */
function blocksEveryone(robots: string): boolean {
  let inWildcard = false;
  let sawRule = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const field = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (field === "user-agent") {
      if (sawRule) inWildcard = false;
      sawRule = false;
      if (value === "*") inWildcard = true;
      continue;
    }
    sawRule = true;
    if (inWildcard && field === "disallow" && value === "/") return true;
  }
  return false;
}

async function checkApis(
  at: (pathname: string) => string,
  probe: (url: string, init?: RequestInit) => Promise<Probe>,
  add: (check: FarmDoctorCheck) => void,
  mcpPath: string | undefined,
): Promise<void> {
  const catalogUrl = at("/.well-known/api-catalog");
  const catalog = await probe(catalogUrl);
  let linkset: Array<Record<string, unknown>> | undefined;
  if (catalog.status === 200) {
    try {
      const parsed = JSON.parse(catalog.body) as { linkset?: unknown };
      if (Array.isArray(parsed.linkset)) linkset = parsed.linkset as Array<Record<string, unknown>>;
    } catch {
      // Reported below.
    }
  }
  const targets = (relation: string) =>
    (linkset ?? []).flatMap((context) =>
      Array.isArray(context[relation])
        ? (context[relation] as Array<{ href?: unknown; title?: unknown }>).filter(
            (target): target is { href: string; title?: unknown } =>
              typeof target.href === "string",
          )
        : [],
    );
  const linked = (relation: string) => targets(relation).map((target) => target.href);

  if (!linkset) {
    add({
      status: catalog.status === 200 ? "warn" : "info",
      code: "AGENT_API_CATALOG",
      title: catalog.status === 200 ? "API catalog is not a Linkset" : "No API catalog",
      message:
        catalog.status === 200
          ? `${catalogUrl} did not return an RFC 9727 Linkset.`
          : "Agents cannot discover the app's APIs from its origin.",
      action: "Set agent: { apiCatalog: true } in farm.config.",
    });
  } else {
    add({
      status: "pass",
      code: "AGENT_API_CATALOG",
      title: "API catalog",
      message: `${catalogUrl} lists ${linked("item").length} API${linked("item").length === 1 ? "" : "s"}.`,
    });
  }

  const specUrl = linked("service-desc")[0];
  const spec = await probe(specUrl ? new URL(specUrl, catalogUrl).href : at("/openapi.json"));
  let isSpec = false;
  try {
    isSpec = spec.status === 200 && "openapi" in (JSON.parse(spec.body) as object);
  } catch {
    isSpec = false;
  }
  add(
    isSpec
      ? {
          status: "pass",
          code: "AGENT_OPENAPI",
          title: "OpenAPI spec",
          message: "The spec answers as JSON.",
        }
      : {
          status: specUrl ? "fail" : "info",
          code: "AGENT_OPENAPI",
          title: specUrl ? "OpenAPI spec in the catalog did not answer" : "No OpenAPI spec",
          message: specUrl
            ? `${specUrl} answered ${spec.status || spec.body}.`
            : "Agents cannot read the shape of the app's HTTP API.",
          action: "Set openapi: { enabled: true } in farm.config.",
        },
  );

  // The catalog names its MCP endpoint by title or by an /mcp path; Farm's default is /api/mcp.
  const mcpHref = mcpPath
    ? undefined
    : targets("item").find(
        (target) =>
          (typeof target.title === "string" && /\bmcp\b/i.test(target.title)) ||
          /\/mcp\/?$/i.test(new URL(target.href, catalogUrl).pathname),
      )?.href;
  const mcpUrl = mcpHref
    ? new URL(mcpHref, catalogUrl).href
    : at(`/${(mcpPath ?? "/api/mcp").replace(/^\/+/, "")}`);
  const mcp = await probe(mcpUrl, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "farm-agent-check", version: "1.0.0" },
      },
    }),
  });
  if (mcp.status === 401) {
    const challenge = mcp.headers.get("www-authenticate");
    add(
      challenge
        ? {
            status: "pass",
            code: "AGENT_MCP",
            title: "MCP endpoint",
            message: `${mcpUrl} requires sign-in and says how (${challenge.split(/\s/)[0]}${challenge.includes("resource_metadata") ? " with OAuth metadata" : ""}).`,
          }
        : {
            status: "warn",
            code: "AGENT_MCP",
            title: "MCP endpoint does not say how to sign in",
            message: `${mcpUrl} answered 401 without WWW-Authenticate.`,
            action: "Upgrade @farm.js/mcp, and set mcp.oauth if tokens come from an OAuth server.",
          },
    );
  } else if (mcp.status >= 200 && mcp.status < 300) {
    add({
      status: "info",
      code: "AGENT_MCP",
      title: "MCP endpoint is public",
      message: `${mcpUrl} accepted an unauthenticated initialize request.`,
    });
  } else if (mcpHref) {
    add({
      status: "fail",
      code: "AGENT_MCP",
      title: "MCP endpoint in the catalog did not answer",
      message: `${mcpUrl} answered ${mcp.status || mcp.body}.`,
      action: "Check the top-level mcp config.",
    });
  } else {
    add({
      status: "info",
      code: "AGENT_MCP",
      title: "No MCP endpoint",
      message: `Nothing answered at ${mcpUrl}.`,
      action: "Add the top-level mcp config to expose API routes and server functions as tools.",
    });
  }
}

function finalize(
  target: FarmAgentCheckReport["target"],
  checks: FarmDoctorCheck[],
): FarmAgentCheckReport {
  const summary: Record<FarmDoctorCheckStatus, number> = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const check of checks) summary[check.status] += 1;
  return {
    target,
    health: summary.fail > 0 ? "error" : summary.warn > 0 ? "attention" : "ready",
    summary,
    checks,
  };
}

export function formatFarmAgentCheckReport(
  report: FarmAgentCheckReport,
  options: { color?: boolean } = {},
): string {
  const color = options.color === undefined ? pc : pc.createColors(options.color);
  const statusStyle: Record<FarmDoctorCheckStatus, (value: string) => string> = {
    pass: color.inverse,
    warn: color.yellow,
    fail: color.red,
    info: color.cyan,
  };
  const lines = [
    `${color.bold("FARM")} ${color.dim("/")} ${color.bold("AGENT CHECK")}`,
    color.dim(report.target.page),
    "",
  ];
  for (const check of report.checks) {
    lines.push(
      `${statusStyle[check.status](check.status.toUpperCase().padEnd(4))}  ${color.bold(check.title)}`,
    );
    lines.push(`      ${color.dim(check.message)}`);
    if (check.action) lines.push(`      ${color.dim(`Next: ${check.action}`)}`);
  }
  const { pass, warn, fail, info } = report.summary;
  lines.push(
    "",
    `${color.bold("SUMMARY")}  ${pass} passed / ${warn} warning${warn === 1 ? "" : "s"} / ${fail} failed / ${info} info`,
  );
  return lines.join("\n");
}
