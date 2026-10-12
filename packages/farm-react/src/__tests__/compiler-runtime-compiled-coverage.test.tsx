import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCompiledAndOriginal, removeCompiledModules } from "./compiled-module-harness";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const roots: Root[] = [];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

afterAll(removeCompiledModules);

async function mount(Component: React.ComponentType<Record<string, unknown>>, props = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<Component {...props} />));
  return container;
}

/** Runs the same interactions on React and compiled renders and compares each step. */
async function expectSameAsReact(
  source: string,
  name: string,
  steps: Array<(container: HTMLElement) => void | Promise<void>>,
  props: Record<string, unknown> = {},
) {
  const { compiled, original, names, reasons } = await loadCompiledAndOriginal(source);
  expect(reasons).toEqual([]);
  expect(names).toContain(name);
  const reactContainer = await mount(original[name], props);
  const compiledContainer = await mount(compiled[name], props);
  expect(compiledContainer.innerHTML).toBe(reactContainer.innerHTML);
  for (const step of steps) {
    for (const container of [reactContainer, compiledContainer]) {
      await act(async () => {
        await step(container);
      });
    }
    expect(compiledContainer.innerHTML).toBe(reactContainer.innerHTML);
  }
  return compiledContainer;
}

const click = (selector: string) => (container: HTMLElement) =>
  container.querySelector<HTMLElement>(selector)!.click();

describe("compiled components match React", () => {
  it("with useState declared after derived values and handlers", async () => {
    await expectSameAsReact(
      `
        import { useState } from "react";
        export function LateState() {
          const [count, setCount] = useState(1);
          const doubled = count * 2;
          const reset = () => {
            setCount(0);
            setOpen(false);
          };
          const [open, setOpen] = useState(false);
          return (
            <section className={open ? "open" : "closed"}>
              <output>{doubled}</output>
              <button id="inc" onClick={() => setCount(count + 1)}>Inc</button>
              <button id="toggle" onClick={() => setOpen(!open)}>Toggle</button>
              <button id="reset" onClick={reset}>Reset</button>
            </section>
          );
        }
      `,
      "LateState",
      [click("#inc"), click("#toggle"), click("#inc"), click("#reset"), click("#toggle")],
    );
  });
});
