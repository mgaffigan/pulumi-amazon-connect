/**
 * Composition is the whole reason this library records rather than interprets: a fragment from
 * another module — or another package — has to work with no wiring. These tests pin that down.
 */

import { describe, expect, it } from "vitest";
import { currentRecorder, disconnect, play, withScope } from "../src/index.js";
import { recordFlow, recordFragment } from "../src/testing/index.js";
import {
  askForAccount,
  greet,
  greetAsynchronously,
  greetFromBuildTimeData,
} from "./fixtures/patterns.js";

const root = { onError: () => disconnect() };

describe("cross-module fragments", () => {
  it("records a fragment imported from another module", () => {
    const flow = recordFlow(() => {
      greet("the patterns package");
      disconnect();
    }, root);

    expect(flow.Actions.some((a) => a.Parameters.Text === "Hello from the patterns package.")).toBe(
      true,
    );
  });

  it("keeps a fragment's return value usable by the caller", () => {
    const flow = recordFlow(() => {
      const account = askForAccount("Enter your account number.");
      play(`Looking up ${account}.`);
      disconnect();
    }, root);

    expect(
      flow.Actions.some((a) => a.Parameters.Text === "Looking up $.Attributes.accountNumber."),
    ).toBe(true);
  });

  it("records a fragment that closes over build-time data", () => {
    const flow = recordFlow(() => {
      greetFromBuildTimeData();
      disconnect();
    }, root);

    expect(flow.Actions.some((a) => a.Parameters.Text === "recorded from build-time data")).toBe(
      true,
    );
  });

  it("rejects an async fragment used as the flow itself", () => {
    // Caught up front: the rest of the fragment would run after everything below it was recorded.
    expect(() => recordFlow(greetAsynchronously, root)).toThrow(/returned a promise/);
  });

  it("rejects an async fragment whose promise was dropped mid-flow", async () => {
    // Nothing can catch this at the call site — the promise is discarded and the flow body returns
    // normally. It surfaces when the fragment resumes and tries to record into a finished flow,
    // which is the difference between a loud failure and an action that silently vanishes.
    let escaped: Promise<void> | undefined;
    recordFlow(() => {
      escaped = greetAsynchronously();
      disconnect();
    }, root);

    await expect(escaped).rejects.toThrow(/after the flow finished/);
  });

  it("throws a useful error when an action is called outside a flow", () => {
    expect(() => play("nowhere")).toThrow(/No flow is being recorded/);
  });
});

describe("identifier stability", () => {
  it("gives the same fragment used twice two distinct, non-colliding subtrees", () => {
    const flow = recordFlow(() => {
      greet("first");
      greet("second");
      disconnect();
    }, root);

    const ids = flow.Actions.map((a) => a.Identifier);
    expect(new Set(ids).size).toBe(ids.length);
    expect(flow.Actions.filter((a) => a.Type === "MessageParticipant")).toHaveLength(2);
  });

  it("produces byte-identical JSON across repeated builds", () => {
    const build = () =>
      recordFlow(() => {
        withScope("intro", () => greet("a"));
        askForAccount("Account?");
        disconnect();
      }, root);

    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  it("keeps identifiers inside a scope stable when unrelated actions are inserted above it", () => {
    const idsIn = (flow: Awaited<ReturnType<typeof recordFlow>>) =>
      flow.Actions.filter((a) => a.Identifier.startsWith("intro-")).map((a) => a.Identifier);

    const before = recordFlow(() => {
      withScope("intro", () => greet("a"));
      disconnect();
    }, root);

    const after = recordFlow(() => {
      play("a newly inserted announcement");
      withScope("intro", () => greet("a"));
      disconnect();
    }, root);

    // This is why scopes exist: adding an action above must not renumber everything below.
    expect(idsIn(after)).toEqual(idsIn(before));
  });
});

describe("recorder isolation", () => {
  it("keeps a nested recording out of the flow that started it", () => {
    // Recording is synchronous, so two flows can only overlap by nesting. The inner one must not
    // append to the outer, and the outer must still be current afterwards.
    let inner: ReturnType<typeof recordFlow> | undefined;
    const outer = recordFlow(() => {
      play("outer first");
      inner = recordFlow(() => {
        play("inner only");
        disconnect();
      }, root);
      play("outer second");
      disconnect();
    }, root);

    const textsOf = (flow: ReturnType<typeof recordFlow>) =>
      flow.Actions.map((x) => x.Parameters.Text).filter((t) => typeof t === "string");

    expect(textsOf(outer)).toEqual(["outer first", "outer second"]);
    expect(textsOf(inner as ReturnType<typeof recordFlow>)).toEqual(["inner only"]);
  });

  it("exposes the recorder only while a flow is being built", () => {
    expect(() => currentRecorder()).toThrow(/No flow is being recorded/);
    recordFlow(() => {
      expect(currentRecorder()).toBeDefined();
      disconnect();
    }, root);
    expect(() => currentRecorder()).toThrow(/No flow is being recorded/);
  });
});

describe("recordFragment", () => {
  it("records a fragment standalone, without an enclosing flow", () => {
    // Fragment libraries need to test their own output; an unhandled error vertex is expected in
    // isolation because the caller normally supplies the handler.
    const flow = recordFragment(() => greet("standalone"));

    expect(flow.Actions.map((a) => a.Type)).toContain("MessageParticipant");
  });
});
