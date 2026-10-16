import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPreHydrationClickQueueScript } from "../server/renderer";

type HoldWindow = typeof window & {
  __FARM_PREHYDRATION_CLICK_QUEUE__?: Array<{ target: Element; kind: string }>;
  __FARM_HYDRATED__?: boolean;
};

const holdWindow = window as HoldWindow;

function submit(form: HTMLFormElement): Event {
  const event = new Event("submit", { bubbles: true, cancelable: true });
  form.dispatchEvent(event);
  return event;
}

describe("inline pre-hydration hold script", () => {
  beforeAll(() => {
    const script = createPreHydrationClickQueueScript();
    const source = script.replace(/^<script>/, "").replace(/<\/script>$/, "");
    new Function(source)();
  });

  afterAll(() => {
    // The capture listeners cannot be removed; leave them inert for later files.
    holdWindow.__FARM_HYDRATED__ = true;
    delete holdWindow.__FARM_PREHYDRATION_CLICK_QUEUE__;
    document.body.innerHTML = "";
  });

  beforeEach(() => {
    holdWindow.__FARM_HYDRATED__ = false;
    holdWindow.__FARM_PREHYDRATION_CLICK_QUEUE__!.length = 0;
    document.body.innerHTML = '<form id="form"><input name="q" /></form>';
  });

  it("holds a repeated submit of a queued form instead of letting it go native", () => {
    const form = document.getElementById("form") as HTMLFormElement;
    const reachedPage: Event[] = [];
    form.addEventListener("submit", (event) => reachedPage.push(event));

    const first = submit(form);
    const second = submit(form);

    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(reachedPage).toEqual([]);
    // Replayed once after hydration, not once per attempt.
    expect(holdWindow.__FARM_PREHYDRATION_CLICK_QUEUE__).toEqual([
      expect.objectContaining({ target: form, kind: "submit" }),
    ]);
  });

  it("lets submits through natively once the document is marked hydrated", () => {
    const form = document.getElementById("form") as HTMLFormElement;
    holdWindow.__FARM_HYDRATED__ = true;

    expect(submit(form).defaultPrevented).toBe(false);
    expect(holdWindow.__FARM_PREHYDRATION_CLICK_QUEUE__).toEqual([]);
  });
});
