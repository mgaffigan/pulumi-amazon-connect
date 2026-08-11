import { describe, expect, it } from "vitest";
import {
  attr,
  disconnect,
  type FlowJson,
  flowIf,
  flowLoop,
  flowSwitch,
  onError,
  play,
  setAttributes,
  showView,
  withScope,
} from "../src/index.js";
import { problemsFor, recordFlow } from "../src/testing/index.js";

/**
 * Records a flow with a root error handler, which is how flows are meant to be written: one
 * declaration of what happens when something breaks, covering every action beneath it.
 */
function record(flow: () => void) {
  return recordFlow(flow, { onError: () => disconnect() });
}

function only(flow: FlowJson, type: string) {
  const matches = flow.Actions.filter((a) => a.Type === type);
  expect(matches, `expected exactly one ${type}`).toHaveLength(1);
  return matches[0] as FlowJson["Actions"][number];
}

function byId(flow: FlowJson, id: string) {
  const action = flow.Actions.find((a) => a.Identifier === id);
  expect(action, `no action with identifier ${id}`).toBeDefined();
  return action as FlowJson["Actions"][number];
}

function withText(flow: FlowJson, text: string) {
  return flow.Actions.filter((a) => a.Parameters.Text === text);
}

describe("sequencing", () => {
  it("chains actions in source order and ends with a disconnect", () => {
    const flow = record(() => {
      play("first");
      play("second");
      disconnect();
    });

    expect(flow.Version).toBe("2019-10-30");
    const first = withText(flow, "first")[0];
    const second = withText(flow, "second")[0];
    expect(first?.Transitions.NextAction).toBe(second?.Identifier);
    expect(flow.StartAction).toBe(first?.Identifier);

    const end = flow.Actions.find(
      (a) => a.Type === "DisconnectParticipant" && a.Identifier !== first?.Identifier,
    );
    expect(end?.Transitions).toEqual({});
  });

  it("synthesizes a terminal action when the flow just runs out", () => {
    const flow = record(() => {
      play("only thing");
    });

    // Connect needs a real transition target, so the emitter supplies one rather than leaving a
    // dangling NextAction.
    const target = byId(flow, withText(flow, "only thing")[0]?.Transitions.NextAction as string);
    expect(target.Type).toBe("DisconnectParticipant");
    expect(target.Transitions).toEqual({});
  });

  it("interpolates refs into text as JSONPaths", () => {
    const flow = record(() => {
      play(`Hello ${attr("firstName")}, welcome back.`);
      disconnect();
    });

    expect(only(flow, "MessageParticipant").Parameters).toEqual({
      Text: "Hello $.Attributes.firstName, welcome back.",
    });
  });

  it("rejects a message with no source, and one with two", () => {
    expect(() =>
      record(() => {
        play({});
      }),
    ).toThrow(/exactly one of/);
    expect(() =>
      record(() => {
        play({ text: "a", ssml: "<speak/>" });
      }),
    ).toThrow(/exactly one of/);
  });
});

describe("flowIf", () => {
  it("emits one Compare and converges both branches on the continuation", () => {
    const flow = record(() => {
      flowIf(
        { op: "equals", left: attr("tier"), right: "gold" },
        { ifTrue: () => play("VIP"), ifFalse: () => play("Standard") },
      );
      play("shared tail");
      disconnect();
    });

    const compare = only(flow, "Compare");
    expect(compare.Parameters).toEqual({ ComparisonValue: "$.Attributes.tier" });
    expect(compare.Transitions.Conditions).toEqual([
      { NextAction: expect.any(String), Condition: { Operator: "Equals", Operands: ["gold"] } },
    ]);

    const whenTrue = byId(flow, compare.Transitions.Conditions?.[0]?.NextAction as string);
    const whenFalse = byId(flow, compare.Transitions.NextAction as string);
    expect(whenTrue.Parameters).toEqual({ Text: "VIP" });
    expect(whenFalse.Parameters).toEqual({ Text: "Standard" });

    // The whole point of continuations: the tail is emitted once and both branches point at it.
    expect(withText(flow, "shared tail")).toHaveLength(1);
    expect(whenTrue.Transitions.NextAction).toBe(withText(flow, "shared tail")[0]?.Identifier);
    expect(whenFalse.Transitions.NextAction).toBe(withText(flow, "shared tail")[0]?.Identifier);
  });

  it("routes NoMatchingCondition to the same action as the else branch", () => {
    const flow = record(() => {
      flowIf(
        { op: "equals", left: attr("tier"), right: "gold" },
        { ifTrue: () => play("VIP"), ifFalse: () => play("Standard") },
      );
      disconnect();
    });

    const compare = only(flow, "Compare");
    const noMatch = compare.Transitions.Errors?.find((e) => e.ErrorType === "NoMatchingCondition");
    // Same identifier, not a second copy of the else branch.
    expect(noMatch?.NextAction).toBe(compare.Transitions.NextAction);
    expect(withText(flow, "Standard")).toHaveLength(1);
  });

  it("maps operators to their flow-language names", () => {
    const flow = record(() => {
      flowIf(
        { op: "lessThan", left: attr<number>("holdSeconds"), right: 6 },
        { ifTrue: () => play("almost") },
      );
      disconnect();
    });

    expect(only(flow, "Compare").Transitions.Conditions?.[0]?.Condition).toEqual({
      Operator: "NumberLessThan",
      Operands: ["6"],
    });
  });

  it("collapses an empty branch into the continuation instead of emitting a no-op", () => {
    const flow = record(() => {
      flowIf({ op: "equals", left: attr("tier"), right: "gold" }, { ifTrue: () => play("VIP") });
      play("tail");
      disconnect();
    });

    expect(only(flow, "Compare").Transitions.NextAction).toBe(
      withText(flow, "tail")[0]?.Identifier,
    );
  });
});

describe("flowSwitch", () => {
  it("emits N cases against a single Compare action", () => {
    const flow = record(() => {
      flowSwitch(attr("dept"), {
        cases: [
          { value: "sales", run: () => play("Sales") },
          { value: "support", run: () => play("Support") },
          { value: "billing", run: () => play("Billing") },
        ],
        otherwise: () => play("Main menu"),
      });
      disconnect();
    });

    // Three cases cost one action here; nested flowIfs would have cost three.
    expect(flow.Actions.filter((a) => a.Type === "Compare")).toHaveLength(1);
    expect(only(flow, "Compare").Transitions.Conditions).toHaveLength(3);
  });
});

describe("flowLoop", () => {
  it("transitions the body back to the loop action", () => {
    const flow = record(() => {
      flowLoop(3, () => {
        play("still waiting");
      });
      disconnect();
    });

    const loop = only(flow, "Loop");
    expect(loop.Parameters).toEqual({ LoopCount: "3" });

    const [continueTo, doneTo] = loop.Transitions.Conditions ?? [];
    expect(continueTo?.Condition.Operands).toEqual(["ContinueLooping"]);
    expect(doneTo?.Condition.Operands).toEqual(["DoneLooping"]);

    // The back-edge is what makes it a loop: the body's last action returns to the Loop action.
    const body = byId(flow, continueTo?.NextAction as string);
    expect(body.Parameters).toEqual({ Text: "still waiting" });
    expect(body.Transitions.NextAction).toBe(loop.Identifier);
  });

  it("rejects a count outside the range Connect accepts", () => {
    expect(() =>
      record(() => {
        flowLoop(101, () => play("x"));
      }),
    ).toThrow(/between 0 and 100/);
  });
});

describe("onError", () => {
  it("wires every action in the body to one shared handler", () => {
    const flow = record(() => {
      onError(
        () => {
          play("one");
          play("two");
        },
        () => {
          play("sorry");
          disconnect();
        },
      );
      disconnect();
    });

    // Emitted once, shared by both body actions.
    expect(withText(flow, "sorry")).toHaveLength(1);
    const handlerId = withText(flow, "sorry")[0]?.Identifier;
    for (const text of ["one", "two"]) {
      expect(withText(flow, text)[0]?.Transitions.Errors).toContainEqual({
        NextAction: handlerId,
        ErrorType: "NoMatchingError",
      });
    }
  });

  it("resolves to the innermost handler when scopes nest", () => {
    const flow = record(() => {
      onError(
        () => {
          onError(
            () => play("inner body"),
            () => play("inner handler"),
          );
          play("outer body");
        },
        () => play("outer handler"),
      );
      disconnect();
    });

    expect(withText(flow, "inner body")[0]?.Transitions.Errors?.[0]?.NextAction).toBe(
      withText(flow, "inner handler")[0]?.Identifier,
    );
    expect(withText(flow, "outer body")[0]?.Transitions.Errors?.[0]?.NextAction).toBe(
      withText(flow, "outer handler")[0]?.Identifier,
    );
  });

  it("does not route a failure inside the handler back to itself", () => {
    const flow = record(() => {
      onError(
        () => play("body"),
        () => play("handler"),
      );
      disconnect();
    });

    const handler = withText(flow, "handler")[0];
    expect(handler?.Transitions.Errors ?? []).not.toContainEqual(
      expect.objectContaining({ NextAction: handler?.Identifier }),
    );
  });

  it("reports an action that can fail with no handler anywhere above it", () => {
    // No root handler supplied: this is the case validation exists to catch.
    const problems = problemsFor(() => {
      play("unprotected");
      disconnect();
    });

    expect(problems.join("\n")).toMatch(/no error handler/);
  });

  it("accepts an action whose own onError is supplied inline", () => {
    const problems = problemsFor(() => {
      play({ text: "hello", onError: () => disconnect() });
      disconnect();
    });

    expect(problems).toEqual([]);
  });

  it("reports an empty string parameter value, naming the action and the property", () => {
    // Connect rejects these with `Invalid Action property value. Path: 0.Parameter`, which names
    // neither the action nor the property — so the deploy failure is unactionable without this.
    const problems = problemsFor(
      () => {
        setAttributes({ lastSearch: "" });
        disconnect();
      },
      { onError: () => disconnect() },
    );

    expect(problems.join("\n")).toMatch(/empty string at Parameters\.Attributes\.lastSearch/);
  });

  it("reports an empty comparison operand, which lives outside Parameters", () => {
    // Connect rejects this with `Invalid branch. Path: 0.Evaluate` — the block index and nothing
    // else — and the fix is never to fill the operand in, since it cannot compare against blank.
    const problems = problemsFor(
      () => {
        flowIf({ left: attr("error"), op: "equals", right: "" }, { ifTrue: () => disconnect() });
        disconnect();
      },
      { onError: () => disconnect() },
    );

    expect(problems.join("\n")).toMatch(/empty operand \(Equals\)/);
    expect(problems.join("\n")).toMatch(/sentinel/);
  });

  it("finds an empty string nested inside a structured parameter", () => {
    const problems = problemsFor(
      () => {
        showView({
          viewId: "arn:aws:connect:us-east-1:aws:view/after-contact-work:1",
          data: { lastSearch: "", validationError: "" },
        });
        disconnect();
      },
      { onError: () => disconnect() },
    );

    // Every offender is reported, so one build fixes them all.
    expect(problems.join("\n")).toMatch(/ViewData\.lastSearch/);
    expect(problems.join("\n")).toMatch(/ViewData\.validationError/);
  });

  it("accepts a whitespace value, which the service does too", () => {
    const problems = problemsFor(
      () => {
        setAttributes({ lastSearch: " " });
        disconnect();
      },
      { onError: () => disconnect() },
    );

    expect(problems).toEqual([]);
  });
});

describe("attributes", () => {
  it("renders refs and literals into the attribute map", () => {
    const flow = record(() => {
      setAttributes({ tier: "gold", source: attr("channel") });
      disconnect();
    });

    expect(only(flow, "UpdateContactAttributes").Parameters).toEqual({
      Attributes: { tier: "gold", source: "$.Attributes.channel" },
      TargetContact: "Current",
    });
  });

  it("rejects an attribute key that would corrupt the JSONPath", () => {
    expect(() =>
      record(() => {
        setAttributes({ "bad.key": "x" });
      }),
    ).toThrow(/not valid in a JSONPath/);
  });
});

describe("validation", () => {
  it("rejects a flow that records nothing", () => {
    expect(() => record(() => {})).toThrow(/recorded no actions/);
  });

  it("produces no dangling transition targets", () => {
    const flow = record(() => {
      withScope("menu", () => {
        flowSwitch(attr("choice"), {
          cases: [
            { value: "1", run: () => play("one") },
            {
              value: "2",
              run: () => {
                play("two");
                disconnect();
              },
            },
          ],
          otherwise: () => play("none"),
        });
      });
      disconnect();
    });

    const known = new Set(flow.Actions.map((a) => a.Identifier));
    for (const action of flow.Actions) {
      const targets = [
        action.Transitions.NextAction,
        ...(action.Transitions.Errors ?? []).map((e) => e.NextAction),
        ...(action.Transitions.Conditions ?? []).map((c) => c.NextAction),
      ].filter((t): t is string => t !== undefined);
      for (const target of targets) expect(known).toContain(target);
    }
  });

  it("names scopes in identifiers", () => {
    const flow = record(() => {
      withScope("greeting", () => play("hi"));
      disconnect();
    });

    expect(withText(flow, "hi")[0]?.Identifier).toBe("greeting-play");
  });
});
