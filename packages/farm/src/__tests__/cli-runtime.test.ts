import { describe, expect, it, vi } from "vitest";

// Vue, Svelte, Solid and Preact apps don't install React, so the entry the CLI loads must
// not reach it. Any import of React from this module graph now fails the test.
// (vi.mock is hoisted above any helper, so each factory throws inline.)
vi.mock("react", () => {
  throw new Error("React is not installed in this app");
});
vi.mock("react/jsx-runtime", () => {
  throw new Error("React is not installed in this app");
});
vi.mock("react-dom", () => {
  throw new Error("React is not installed in this app");
});
vi.mock("react-dom/server", () => {
  throw new Error("React is not installed in this app");
});

describe("@farm.js/core/internal/cli-runtime", () => {
  it("loads without React", async () => {
    const runtime = await import("../cli-runtime");
    expect(typeof runtime.loadConfig).toBe("function");
    expect(typeof runtime.logger.info).toBe("function");
  });
});
