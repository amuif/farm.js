import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCompiledComponent,
  type CompiledComponentDefinition,
  type CompilerKeyedRowBinding,
  type CompilerKeyedRowElement,
} from "../compiler-runtime";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

interface Row {
  id: number;
  label: string;
}

type Shape = "table" | "hidden-first" | "style";

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

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function rows(from: number, count: number, suffix = ""): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: from + index,
    label: `row ${from + index}${suffix}`,
  }));
}

// Every value that differs between rows is a binding, as the compiler emits.
function rowDescriptor(
  shape: Shape,
  row: Row,
  index: number,
  selected: number,
): CompilerKeyedRowElement {
  const cell = (
    tag: string,
    children: unknown[],
    attributes: { name: string; value: unknown }[] = [],
  ) => ({
    kind: "element" as const,
    tag,
    attributes,
    styles: [],
    children,
  });
  const button = cell(
    "button",
    ["x"],
    [
      { name: "type", value: "button" },
      { name: "disabled", value: true },
    ],
  );
  return {
    kind: "element",
    tag: "tr",
    attributes: [
      { name: "className", value: selected === row.id ? "danger" : "" },
      { name: "data-id", value: row.id },
      { name: "aria-selected", value: selected === row.id },
      ...(shape === "hidden-first" ? [{ name: "hidden", value: row.id % 2 === 0 }] : []),
      { name: "data-static", value: "kept" },
    ],
    styles: shape === "style" ? [{ name: "opacity", value: row.id % 2 ? 0.5 : 1 }] : [],
    children: [
      cell("td", [row.id], [{ name: "className", value: "col-md-1" }]),
      cell("td", [cell("a", ["#", row.id, " ", row.label], [{ name: "title", value: row.label }])]),
      cell("td", [index % 2 ? "" : index]),
      cell("td", [button]),
      cell("td", [], [{ name: "className", value: "col-md-6" }]),
    ],
  };
}

function rowBindings(shape: Shape, selected: () => number): CompilerKeyedRowBinding[] {
  const bindings: CompilerKeyedRowBinding[] = [
    {
      kind: "attribute",
      path: [],
      name: "className",
      read: (item) => (selected() === (item as Row).id ? "danger" : ""),
    },
    { kind: "attribute", path: [], name: "data-id", read: (item) => (item as Row).id },
    {
      kind: "attribute",
      path: [],
      name: "aria-selected",
      read: (item) => selected() === (item as Row).id,
    },
    { kind: "text", path: [0], read: (item) => [(item as Row).id] },
    {
      kind: "attribute",
      path: [1, 0],
      name: "title",
      read: (item) => (item as Row).label,
    },
    {
      kind: "text",
      path: [1, 0],
      read: (item) => ["#", (item as Row).id, " ", (item as Row).label],
    },
    { kind: "text", path: [2], read: (_item, index) => [index % 2 ? "" : index] },
  ];
  if (shape === "hidden-first") {
    bindings.push({
      kind: "attribute",
      path: [],
      name: "hidden",
      read: (item) => (item as Row).id % 2 === 0,
    });
  }
  if (shape === "style") {
    bindings.push({
      kind: "style",
      path: [],
      name: "opacity",
      read: (item) => ((item as Row).id % 2 ? 0.5 : 1),
    });
  }
  return bindings;
}

function mountRows(shape: Shape, cloneRows: boolean) {
  const counters = { creates: 0 };
  const clicks: string[] = [];
  let setRows: (next: (current: Row[]) => Row[]) => void = () => undefined;
  let setSelected: (id: number) => void = () => undefined;
  const definition: CompiledComponentDefinition<object> = {
    displayName: `TemplateRows${cloneRows ? "Cloned" : "Built"}`,
    reactivity: "hybrid",
    initialize: () => [[] as Row[], 0],
    render(_props, state, blocks) {
      const items = () => state[0].get() as Row[];
      const selected = () => state[1].get() as number;
      setRows = (next) => state[0].set((current) => next(current as Row[]));
      setSelected = (id) => state[1].set(id);
      return (
        <table>
          <blocks.KeyedRows
            id={0}
            items={items}
            dependencies={[0, 1]}
            structureDependencies={[0]}
            collectionDependency={0}
            rowKey={(item) => (item as Row).id}
            create={(item, index) => {
              counters.creates += 1;
              return rowDescriptor(shape, item as Row, index, selected());
            }}
            bindings={rowBindings(shape, selected)}
            events={[
              {
                name: "onClick",
                path: [1, 0],
                invoke: (item, index) => clicks.push(`${(item as Row).label}@${index}`),
              },
            ]}
            delegateEvents
            cloneRows={cloneRows}
            render={(event) => (
              <tbody>
                {items().map((row, index) => (
                  <tr key={row.id}>
                    <td>{row.id}</td>
                    <td>
                      <a onClick={event(row, index, 0)}>{row.label}</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          />
        </table>
      );
    },
    bindings: [{ kind: "block", id: 0, dependencies: [0, 1] }],
  };
  const Component = createCompiledComponent(definition);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  return {
    container,
    counters,
    clicks,
    async render() {
      await act(async () => root.render(<Component />));
    },
    async rows(next: (current: Row[]) => Row[]) {
      await act(async () => {
        setRows(next);
        await flush();
      });
    },
    async select(id: number) {
      await act(async () => {
        setSelected(id);
        await flush();
      });
    },
    html: () => container.querySelector("tbody")!.innerHTML,
  };
}

async function runScenario(shape: Shape, cloneRows: boolean) {
  const view = mountRows(shape, cloneRows);
  const snapshots: string[] = [];
  await view.render();
  await view.rows(() => rows(1, 40));
  snapshots.push(view.html());
  await view.rows(() => rows(100, 40));
  snapshots.push(view.html());
  await view.rows((current) => current.concat(rows(500, 25)));
  snapshots.push(view.html());
  await view.select(110);
  snapshots.push(view.html());
  await view.rows((current) =>
    current.map((row, index) => (index % 10 === 0 ? { ...row, label: `${row.label} !!!` } : row)),
  );
  snapshots.push(view.html());
  await view.rows((current) => {
    const next = current.slice();
    [next[1], next[30]] = [next[30], next[1]];
    return next;
  });
  snapshots.push(view.html());
  await view.rows((current) => current.filter((row) => row.id !== 105));
  snapshots.push(view.html());
  await act(async () => {
    view.container.querySelector<HTMLElement>("tbody tr:nth-child(4) a")!.click();
  });
  await view.rows(() => []);
  snapshots.push(view.html());
  return { snapshots, creates: view.counters.creates, clicks: view.clicks };
}

describe("cloned keyed rows", () => {
  it("produces the same DOM as building every row from its descriptor", async () => {
    const built = await runScenario("table", false);
    const cloned = await runScenario("table", true);

    expect(cloned.snapshots).toEqual(built.snapshots);
    expect(cloned.clicks).toEqual(built.clicks);
    expect(cloned.clicks).toEqual(["row 103@3"]);
    expect(built.snapshots[0]).toContain('data-static="kept"');
    expect(built.snapshots[3]).toContain('class="danger" data-id="110"');
  });

  it("builds one descriptor per committed props object instead of one per row", async () => {
    const built = await runScenario("table", false);
    const cloned = await runScenario("table", true);

    expect(built.creates).toBeGreaterThanOrEqual(105);
    expect(cloned.creates).toBe(1);
  });

  it("waits for a row that has every bound attribute before cloning", async () => {
    // Row 1 omits hidden, so its clones would add hidden after data-static.
    const built = await runScenario("hidden-first", false);
    const cloned = await runScenario("hidden-first", true);

    expect(cloned.snapshots).toEqual(built.snapshots);
    expect(built.snapshots[0]).toContain('aria-selected="false" hidden="" data-static="kept"');
    expect(cloned.creates).toBe(2);
  });

  it("keeps building rows with style bindings from descriptors", async () => {
    const built = await runScenario("style", false);
    const cloned = await runScenario("style", true);

    expect(cloned.snapshots).toEqual(built.snapshots);
    expect(cloned.creates).toBe(built.creates);
  });
});
