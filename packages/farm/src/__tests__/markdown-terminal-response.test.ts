// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createMarkdownMirrorResponse, resolveMarkdownConfig } from "../markdown";

describe("Markdown terminal page responses", () => {
  it.each([307, 401, 403])(
    "cancels the unused body when explaining an access response (%s)",
    async (status) => {
      const cancel = vi.fn();
      const page = new Response(new ReadableStream({ cancel }), {
        status,
        headers: status === 307 ? { location: "/login" } : undefined,
      });
      const response = await createMarkdownMirrorResponse({
        request: new Request("https://farm.test/account.md"),
        config: resolveMarkdownConfig(true),
        renderPage: () => page,
      });
      expect(response?.status).toBe(status);
      expect(response?.headers.get("content-type")).toContain("text/markdown");
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each([200, 201, 204, 304, 404, 429, 500, 503])(
    "returns a non-HTML %s response without consuming or replacing it",
    async (status) => {
      const page = new Response([204, 304].includes(status) ? null : '{"message":"original"}', {
        status,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "retry-after": "60",
          "x-app-response": "kept",
          "set-cookie": "session=; Max-Age=0; Path=/",
        },
      });
      const renderPage = vi.fn(() => page);
      const response = await createMarkdownMirrorResponse({
        request: new Request("https://farm.test/account.md?outline"),
        config: resolveMarkdownConfig(true),
        renderPage,
      });
      expect(response).toBe(page);
      expect(page.bodyUsed).toBe(false);
      expect(response?.headers.get("retry-after")).toBe("60");
      expect(response?.headers.get("x-app-response")).toBe("kept");
      expect(response?.headers.getSetCookie()).toEqual(["session=; Max-Age=0; Path=/"]);
      expect(renderPage).toHaveBeenCalledOnce();
    },
  );

  it("keeps HEAD status and headers, and cancels the unused GET body", async () => {
    const cancel = vi.fn();
    const page = new Response(new ReadableStream({ cancel }), {
      status: 429,
      statusText: "Slow down",
      headers: { "content-type": "application/json", "retry-after": "60" },
    });
    const response = await createMarkdownMirrorResponse({
      request: new Request("https://farm.test/account.md", { method: "HEAD" }),
      config: resolveMarkdownConfig(true),
      renderPage: () => page,
    });
    expect(response?.status).toBe(429);
    expect(response?.statusText).toBe("Slow down");
    expect(response?.headers.get("retry-after")).toBe("60");
    expect(response?.body).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not wait for an unused HEAD body's asynchronous cancellation", async () => {
    let finishCancel!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      finishCancel = resolve;
    });
    const page = new Response(new ReadableStream({ cancel: () => cancelled }), { status: 503 });
    try {
      const response = await createMarkdownMirrorResponse({
        request: new Request("https://farm.test/account.md", { method: "HEAD" }),
        config: resolveMarkdownConfig(true),
        renderPage: () => page,
      });
      expect(response?.status).toBe(503);
      expect(response?.body).toBeNull();
    } finally {
      finishCancel();
    }
  });

  it("does not replace a terminal response when unused-body cancellation rejects", async () => {
    const page = new Response(
      new ReadableStream({
        cancel: () => Promise.reject(new Error("upstream already closed")),
      }),
      { status: 503 },
    );
    const response = await createMarkdownMirrorResponse({
      request: new Request("https://farm.test/account.md", { method: "HEAD" }),
      config: resolveMarkdownConfig(true),
      renderPage: () => page,
    });
    expect(response?.status).toBe(503);
    expect(response?.body).toBeNull();
  });
});
