/**
 * A view's outputs, from the template that renders them to the flow that reads them.
 *
 * The output contract is the set of field names: a component reports its value back under its `Name`,
 * and the flow reads `$.Views.ViewResultData.<Name>`. Nothing checks those two spellings against each
 * other at runtime — a mismatch yields an empty reference and no error anywhere — so the whole point of
 * declaring outputs is to make them the same declaration.
 */

import { describe, expect, it } from "vitest";
import {
  Container,
  defineView,
  disconnect,
  existingView,
  FormInput,
  play,
  setAttributes,
  shape,
  Table,
  TextBox,
} from "../src/index.js";
import { recordFlow } from "../src/testing/index.js";

const root = { onError: () => disconnect() };

interface Outputs {
  notes: string;
  PatientTable: Array<{ pat_id: string }>;
}

/** Authored once, then shown from a flow — the two halves this file is about. */
function patientView() {
  return defineView({
    title: "Patient",
    actions: ["Next"],
    inputs: shape<{ facilityName: string }>(),
    outputs: shape<Outputs>(),
    body: ({ inputs, actions, fields }) =>
      Container({}, [
        TextBox(inputs.facilityName),
        Table({
          name: fields.PatientTable,
          items: "$.patients",
          columns: [{ label: "Patient", id: "pat_id" }],
          actions: [{ label: "Choose", action: actions.Next }],
        }),
        FormInput({ name: fields.notes, label: "Notes" }),
        // Unnamed, so it renders but submits nothing.
        Table({ items: "$.other", columns: [{ label: "Other", id: "x" }] }),
      ]),
  });
}

describe("view outputs", () => {
  it("counts a named table as a field, since the flow reads its rows", () => {
    // An unnamed table renders but submits nothing, so it is not part of the contract.
    expect(patientView().fields).toEqual(["PatientTable", "notes"]);
  });

  it("puts the declared field name on the wire", () => {
    const body = patientView().Template.Body[0];
    const input = body?.Content.find(
      (c) => typeof c === "object" && c !== null && c.Type === "FormInput",
    );
    expect(input && typeof input === "object" ? input.Props.Name : undefined).toBe("notes");
  });

  it("rejects a field name that did not come from the declared outputs", () => {
    expect(() =>
      defineView({
        title: "Typo",
        actions: ["Next"],
        outputs: shape<Outputs>(),
        body: ({ actions }) =>
          Container({}, [
            FormInput({ name: "notse", label: "Notes" }),
            TextBox("x", { variant: "h2" }),
            Table({
              items: "$.p",
              columns: [{ label: "Patient", id: "pat_id" }],
              actions: [{ label: "Go", action: actions.Next }],
            }),
          ]),
      }),
    ).toThrow(/did not come from the declared outputs: notse/);
  });

  it("leaves literal field names alone when no outputs are declared", () => {
    const view = defineView({
      title: "Loose",
      actions: ["Next"],
      body: ({ actions }) =>
        Container({}, [
          FormInput({ name: "notes" }),
          Table({
            items: "$.p",
            columns: [{ label: "Patient", id: "pat_id" }],
            actions: [{ label: "Go", action: actions.Next }],
          }),
        ]),
    });
    expect(view.fields).toEqual(["notes"]);
  });

  it("carries inputs, outputs and actions into the flow with no redeclaration", () => {
    const authored = patientView();
    // `view:` replaces the input/output/actions triple that would otherwise be retyped here.
    const patient = existingView({ viewId: "view-1", view: authored });

    expect(patient.actions).toEqual(["Next"]);

    const flow = recordFlow(() => {
      const result = patient.show({
        data: { facilityName: "Acme" },
        on: { Next: () => play("next") },
      });
      setAttributes({
        notes: result.notes,
        patientId: result.PatientTable.at(0).pat_id,
      });
      disconnect();
    }, root);

    const update = flow.Actions.find((a) => a.Type === "UpdateContactAttributes") as
      | { Parameters: { Attributes: Record<string, string> } }
      | undefined;
    const attributes = update?.Parameters.Attributes;

    // The same names the template rendered, on the paths the real exported flow uses.
    expect(attributes).toEqual({
      notes: "$.Views.ViewResultData.notes",
      patientId: "$.Views.ViewResultData.PatientTable.0.pat_id",
    });
  });

  it("reads the chosen action as a value, beside the submitted data", () => {
    const patient = existingView({ viewId: "view-1", view: patientView() });

    const flow = recordFlow(() => {
      const result = patient.show({ data: { facilityName: "Acme" } });
      setAttributes({ chose: result.$action, notes: result.notes });
      disconnect();
    }, root);

    const update = flow.Actions.find((a) => a.Type === "UpdateContactAttributes") as
      | { Parameters: { Attributes: Record<string, string> } }
      | undefined;

    // `$.Views.Action` is a sibling of the data root, not a field under it.
    expect(update?.Parameters.Attributes).toEqual({
      chose: "$.Views.Action",
      notes: "$.Views.ViewResultData.notes",
    });
  });

  it("shadows no data field, because $ cannot appear in a field name", () => {
    // Why the key is `$`-prefixed: a component's Name becomes a path segment, and `$` is illegal
    // there, so nothing a view submits can ever collide with the interception at the root.
    const view = existingView({ viewId: "v1", output: shape<{ nested: { $action: string } }>() });

    expect(() =>
      recordFlow(() => {
        setAttributes({ x: view.show({}).nested.$action });
        disconnect();
      }, root),
    ).toThrow(/contains a character that is not valid in a JSONPath segment/);
  });

  it("shows views one after another without nesting", () => {
    // The point of the fall-through default: three screens in series read as three statements,
    // and each one's result is available to the statements that follow it.
    const first = existingView({
      viewId: "v1",
      actions: ["Next"],
      output: shape<{ nickname: string }>(),
    });
    const second = existingView({ viewId: "v2", output: shape<{ note: string }>() });

    const flow = recordFlow(() => {
      const a = first.show({});
      setAttributes({ nickname: a.nickname });
      const b = second.show({});
      setAttributes({ note: b.note });
      disconnect();
    }, root);

    const shows = flow.Actions.filter((a) => a.Type === "ShowView");
    expect(shows).toHaveLength(2);

    // The unhandled "Next" branch converges on the same action the ShowView falls through to,
    // which is the next statement rather than a nested block.
    const [firstShow] = shows;
    const condition = firstShow?.Transitions.Conditions?.[0];
    expect(condition?.Condition.Operands).toEqual(["Next"]);
    expect(condition?.NextAction).toBe(firstShow?.Transitions.NextAction);

    const attributeActions = flow.Actions.filter((a) => a.Type === "UpdateContactAttributes");
    expect(
      attributeActions.map((a) => (a.Parameters as { Attributes: object }).Attributes),
    ).toEqual([
      { nickname: "$.Views.ViewResultData.nickname" },
      { note: "$.Views.ViewResultData.note" },
    ]);
  });

  it("needs no actions at all", () => {
    const notice = defineView({
      title: "Please wait",
      body: () => Container({}, [TextBox("One moment.")]),
    });

    expect(notice.Actions).toEqual([]);
    expect(notice.fields).toEqual([]);
  });
});
