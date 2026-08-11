/**
 * Invariants derived from a real console-exported flow.
 *
 * These were checked against a 118-action production flow ("Where's My Med Event Flow"), covering
 * UpdateContactAttributes, Compare, InvokeLambdaFunction, ShowView, MessageParticipant, and
 * DisconnectParticipant. Where the AWS reference and the console disagreed, the console won — it is
 * the thing that actually reads and writes this JSON.
 */

import { describe, expect, it } from "vitest";
import {
  attr,
  collectInput,
  disconnect,
  existingView,
  type FlowJson,
  flowIf,
  flowLoop,
  play,
  setAttributes,
  setFlowAttributes,
  shape,
  showView,
  wait,
} from "../src/index.js";
import { recordFlow } from "../src/testing/index.js";

const root = { onError: () => disconnect() };

/** Collects every scalar leaf under an action's Parameters. */
function scalarsIn(flow: FlowJson): Array<{ path: string; value: unknown }> {
  const found: Array<{ path: string; value: unknown }> = [];
  const walk = (value: unknown, path: string): void => {
    if (value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        walk(v, `${path}[${i}]`);
      });
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
      return;
    }
    found.push({ path, value });
  };
  for (const action of flow.Actions) walk(action.Parameters, `${action.Identifier}.Parameters`);
  return found;
}

describe("wire conformance", () => {
  it("emits every parameter scalar as a string", () => {
    // Not one non-string scalar appears anywhere in the real export's Parameters. Numbers like
    // timeouts are quoted.
    const flow = recordFlow(() => {
      showView({
        viewId: "arn:aws:connect:us-east-1:1234:instance/abc/view/def",
        timeoutSeconds: 30,
        on: { Back: () => play("going back") },
      });
      setAttributes({ count: 3, enabled: true });
      disconnect();
    }, root);

    const nonStrings = scalarsIn(flow).filter((s) => typeof s.value !== "string");
    expect(nonStrings).toEqual([]);
  });

  it("wires a Compare's else branch to the same action as NoMatchingCondition", () => {
    // Confirmed against the real export: NextAction and the NoMatchingCondition error both name the
    // identical downstream identifier.
    const flow = recordFlow(() => {
      flowIf(
        { op: "equals", left: attr("code"), right: "200" },
        { ifTrue: () => play("ok"), ifFalse: () => play("not ok") },
      );
      disconnect();
    }, root);

    const compare = flow.Actions.find((a) => a.Type === "Compare");
    const noMatch = compare?.Transitions.Errors?.find((e) => e.ErrorType === "NoMatchingCondition");
    expect(noMatch?.NextAction).toBe(compare?.Transitions.NextAction);
  });

  it("puts the view version in the ARN qualifier, not a Version field", () => {
    const flow = recordFlow(() => {
      showView({
        viewId: "arn:aws:connect:us-east-1:1234:instance/abc/view/def",
        viewVersion: "$LATEST",
        on: { Back: () => play("back") },
      });
      disconnect();
    }, root);

    const view = flow.Actions.find((a) => a.Type === "ShowView");
    expect(view?.Parameters.ViewResource).toEqual({
      Id: "arn:aws:connect:us-east-1:1234:instance/abc/view/def:$LATEST",
    });
    expect(view?.Parameters).not.toHaveProperty("Version");
  });

  it("appends a published version number without a $, the way AWS's own flow does", () => {
    // `Sample after contact work flow` references
    // `arn:aws:connect:us-east-1:aws:view/after-contact-work:1`. Only the named qualifiers take a $.
    const flow = recordFlow(() => {
      showView({
        viewId: "arn:aws:connect:us-east-1:aws:view/after-contact-work",
        viewVersion: 1,
        on: { Submit: () => play("thanks") },
      });
      disconnect();
    }, root);

    const resource = flow.Actions.find((a) => a.Type === "ShowView")?.Parameters.ViewResource;
    expect(resource).toEqual({ Id: "arn:aws:connect:us-east-1:aws:view/after-contact-work:1" });
  });

  it("leaves an id that already carries a qualifier alone", () => {
    const flow = recordFlow(() => {
      showView({
        viewId: "arn:aws:connect:us-east-1:1234:instance/abc/view/def:$SAVED",
        viewVersion: "$LATEST",
        on: { Back: () => play("back") },
      });
      disconnect();
    }, root);

    const view = flow.Actions.find((a) => a.Type === "ShowView");
    const resource = view?.Parameters.ViewResource as { Id: string } | undefined;
    expect(resource?.Id).toMatch(/:\$SAVED$/);
  });

  it("always emits ViewData, empty when there is none", () => {
    const flow = recordFlow(() => {
      showView({
        viewId: "arn:aws:connect:us-east-1:1234:instance/abc/view/def",
        on: { Back: () => play("back") },
      });
      disconnect();
    }, root);

    expect(flow.Actions.find((a) => a.Type === "ShowView")?.Parameters.ViewData).toEqual({});
  });

  it("declares the three outcomes a real ShowView declares", () => {
    const flow = recordFlow(() => {
      showView({
        viewId: "view-1",
        on: { Back: () => play("back") },
      });
      disconnect();
    }, root);

    const errorTypes = flow.Actions.find((a) => a.Type === "ShowView")
      ?.Transitions.Errors?.map((e) => e.ErrorType)
      .sort();
    expect(errorTypes).toEqual(["NoMatchingCondition", "NoMatchingError", "TimeLimitExceeded"]);
  });

  it("uses the console's lower camel case for layout metadata", () => {
    // The AWS reference example capitalizes these, but every console export uses lower camel case,
    // and the console is what reads them. Capitalized keys leave every block stacked at the origin.
    const flow = recordFlow(() => {
      play("hello");
      disconnect();
    }, root);

    expect(flow.Metadata).toHaveProperty("entryPointPosition");
    expect(flow.Metadata).not.toHaveProperty("EntryPointPosition");

    const entry = Object.values(flow.Metadata?.ActionMetadata ?? {})[0];
    expect(entry).toHaveProperty("position");
    expect(entry).not.toHaveProperty("Position");
  });

  it("emits terminal actions with empty Parameters and Transitions", () => {
    const flow = recordFlow(() => {
      play("bye");
      disconnect();
    }, root);

    const terminal = flow.Actions.filter((a) => a.Type === "DisconnectParticipant");
    expect(terminal.length).toBeGreaterThan(0);
    for (const action of terminal) {
      expect(action.Parameters).toEqual({});
      expect(action.Transitions).toEqual({});
    }
  });

  it("reads view submissions from $.Views.ViewResultData", () => {
    // The real flow reads both plain fields and positional table cells out of this namespace.
    const patientSearch = existingView({
      viewId: "view-1",
      actions: ["Next"],
      output: shape<{
        patient_name: string;
        PatientTable: Array<{ pat_id: string }>;
      }>(),
    });

    const flow = recordFlow(() => {
      const result = patientSearch.show({ on: { Next: () => play("next") } });
      setAttributes({
        patient_name: result.patient_name,
        pat_id: result.PatientTable.at(0).pat_id,
      });
      disconnect();
    }, root);

    expect(flow.Actions.some((a) => a.Type === "ShowView")).toBe(true);

    const parameters = flow.Actions.find((a) => a.Type === "UpdateContactAttributes")?.Parameters as
      | { Attributes: Record<string, string> }
      | undefined;

    expect(parameters?.Attributes).toEqual({
      patient_name: "$.Views.ViewResultData.patient_name",
      pat_id: "$.Views.ViewResultData.PatientTable.0.pat_id",
    });
  });

  it("passes the submitted data to each action handler", () => {
    // Handlers are recorded during show(), so a handler that closed over show()'s return value
    // would hit the temporal dead zone. Passing the refs in is what makes this usable at all.
    const view = existingView({
      viewId: "v",
      actions: ["Picked"],
      output: shape<{ Rows: Array<{ id: string }> }>(),
    });

    const flow = recordFlow(() => {
      view.show({
        on: {
          Picked: (picked) => {
            setAttributes({ chosen: picked.Rows.at(2).id });
          },
        },
      });
      disconnect();
    }, root);

    const parameters = flow.Actions.find((a) => a.Type === "UpdateContactAttributes")?.Parameters as
      | { Attributes: Record<string, string> }
      | undefined;
    expect(parameters?.Attributes).toEqual({ chosen: "$.Views.ViewResultData.Rows.2.id" });
  });

  it("returns a view result that answers no `then`, and survives being awaited", async () => {
    // The result is a proxy that answers every property with a ref, so without a guard it would
    // answer `then` too. A promise resolved with such an object is inspected for `then`: today the
    // ref is not callable so the runtime moves on, but answering `then` with a ref at all is a trap
    // one callable ref away from breaking every `await` on a view result.
    const view = existingView({
      viewId: "v",
      actions: ["Ok"],
      output: shape<{ field_a: string }>(),
    });

    let resolved: unknown;
    recordFlow(() => {
      resolved = view.show({ on: { Ok: () => play("ok") } });
      disconnect();
    }, root);

    expect((resolved as { then?: unknown }).then).toBeUndefined();
    expect(String((resolved as { field_a: unknown }).field_a)).toBe(
      "$.Views.ViewResultData.field_a",
    );
  });

  it("emits flow attributes as {Type, Value} and declares NoMatchingError", () => {
    // Both recovered from Connect's validator: the reference renders this parameter with unbalanced
    // quotes and claims the action has no errors. A flow with this exact shape published cleanly.
    const flow = recordFlow(() => {
      setFlowAttributes({ attempts: "1" });
      disconnect();
    }, root);

    const action = flow.Actions.find((a) => a.Type === "UpdateFlowAttributes");
    expect(action?.Parameters).toEqual({
      FlowAttributes: { attempts: { Type: "String", Value: "1" } },
    });
    expect(action?.Transitions.Errors?.map((e) => e.ErrorType)).toEqual(["NoMatchingError"]);
  });

  it("names the Wait timeout TimeLimitSeconds", () => {
    // The reference calls it TimeoutSeconds; Connect rejects that name outright.
    const flow = recordFlow(() => {
      wait(30);
      disconnect();
    }, root);

    expect(flow.Actions.find((a) => a.Type === "Wait")?.Parameters).toEqual({
      TimeLimitSeconds: "30",
    });
  });

  it("gives a Loop a NextAction as well as its two conditions", () => {
    // Connect rejects any non-terminal action without a NextAction, conditions notwithstanding.
    const flow = recordFlow(() => {
      flowLoop(2, () => play("still here"));
      disconnect();
    }, root);

    const loop = flow.Actions.find((a) => a.Type === "Loop");
    expect(loop?.Transitions.NextAction).toBeDefined();
    expect(loop?.Transitions.Conditions).toHaveLength(2);
  });

  it("declares no InputTimeLimitExceeded on a store-mode input", () => {
    // The reference lists it; Connect rejects the action when it is present.
    const flow = recordFlow(() => {
      collectInput({ text: "Account?", timeoutSeconds: 5, maxLength: 8 });
      disconnect();
    }, root);

    const errorTypes = flow.Actions.find(
      (a) => a.Type === "GetParticipantInput",
    )?.Transitions.Errors?.map((e) => e.ErrorType);
    expect(errorTypes).toEqual(["NoMatchingError"]);
  });

  it("emits UpdateContactAttributes with exactly Attributes and TargetContact", () => {
    const flow = recordFlow(() => {
      setAttributes({ error_msg: " " });
      disconnect();
    }, root);

    expect(flow.Actions.find((a) => a.Type === "UpdateContactAttributes")?.Parameters).toEqual({
      Attributes: { error_msg: " " },
      TargetContact: "Current",
    });
  });
});
