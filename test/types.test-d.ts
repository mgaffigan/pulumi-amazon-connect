/**
 * The compile errors are the product.
 *
 * Each `@ts-expect-error` here marks something the flow language cannot express. If one of these
 * ever starts compiling, the library has begun accepting code that would fail at deploy time or on
 * a live contact — so the assertion is that they keep failing.
 */

import { assertType, describe, expectTypeOf, it } from "vitest";
import {
  attr,
  type ContactFlowEvent,
  Container,
  collectInput,
  connectLambda,
  defineView,
  existingView,
  FormInput,
  flowIf,
  flowLoop,
  goto,
  type Label,
  label,
  play,
  type Ref,
  shape,
  Table,
  type ViewResult,
  wait,
} from "../src/index.js";

describe("comparisons", () => {
  it("rejects comparing two runtime values", () => {
    // The flow language has no operator that compares two dynamic values. Allowing this would
    // produce a flow Connect rejects; instead it cannot be written.
    // @ts-expect-error right must be a literal, never a Ref
    void flowIf({ op: "equals", left: attr("a"), right: attr("b") }, {});
  });

  it("rejects a text operator on a numeric reference", () => {
    // @ts-expect-error startsWith is not available on Ref<number>
    void flowIf({ op: "startsWith", left: attr<number>("holdSeconds"), right: "1" }, {});
  });

  it("rejects a numeric operator on a string reference", () => {
    // @ts-expect-error lessThan is not available on Ref<string>
    void flowIf({ op: "lessThan", left: attr<string>("tier"), right: "gold" }, {});
  });

  it("rejects an operand whose type does not match the reference", () => {
    // @ts-expect-error right must be a number when left is Ref<number>
    void flowIf({ op: "lessThan", left: attr<number>("holdSeconds"), right: "six" }, {});
  });

  it("accepts the operators each type does support", () => {
    void flowIf({ op: "lessThan", left: attr<number>("holdSeconds"), right: 6 }, {});
    void flowIf({ op: "contains", left: attr<string>("tier"), right: "gold" }, {});
    void flowIf({ op: "equals", left: attr<string>("tier"), right: "gold" }, {});
  });
});

describe("lambdas", () => {
  it("caps the invocation timeout at Connect's limit of 8 seconds", () => {
    void connectLambda("ok", {
      timeoutSeconds: 8,
      handler: async (_event: ContactFlowEvent<{ phone: string }>) => ({ tier: "gold" }),
    });

    void connectLambda("tooLong", {
      // @ts-expect-error Connect allows at most 8 seconds
      timeoutSeconds: 30,
      handler: async (_event: ContactFlowEvent<{ phone: string }>) => ({ tier: "gold" }),
    });
  });

  it("rejects a nested return type under STRING_MAP", () => {
    // Connect flattens STRING_MAP responses, so a nested object would arrive as "[object Object]"
    // at runtime. Neither overload accepts it, so the whole call fails to compile.
    // @ts-expect-error STRING_MAP responses must be a flat map of strings
    void connectLambda("nested", {
      responseType: "STRING_MAP",
      handler: async (_event: ContactFlowEvent<{ id: string }>) => ({ customer: { tier: "gold" } }),
    });
  });

  it("allows an absent value under STRING_MAP", () => {
    // JSON.stringify drops an undefined value, so the key simply does not appear in the response —
    // which is exactly what a handler with nothing to report wants to say.
    const facilities = new Map<string, string>();
    const lookup = connectLambda("optional", {
      responseType: "STRING_MAP",
      handler: async (event: ContactFlowEvent<{ search: string }>) => ({
        facilityId: facilities.get(event.Details.Parameters.search),
        table: "facilities",
      }),
    });

    // Connect has no undefined: an omitted key reads as the empty string, so the ref is a plain
    // Ref<string> and stays usable everywhere a ref is.
    const result = lookup({ search: "acme" });
    expectTypeOf(result.facilityId).toEqualTypeOf<Ref<string>>();
  });

  it("allows nesting under JSON", () => {
    void connectLambda("nested", {
      responseType: "JSON",
      handler: async (_event: ContactFlowEvent<{ id: string }>) => ({ customer: { tier: "gold" } }),
    });
  });

  it("types results as references, not values", () => {
    const lookup = connectLambda("lookup", {
      handler: async (_event: ContactFlowEvent<{ phone: string }>) => ({ tier: "gold" }),
    });

    const result = lookup({ phone: "+15555550100" });
    expectTypeOf(result.tier).toEqualTypeOf<Ref<string>>();
    // A flow cannot read the value, only point at where it will be.
    assertType<Ref<string>>(result.tier);
  });
});

describe("views", () => {
  const patientSearch = existingView({
    viewId: "view-1",
    actions: ["Next", "Back"],
    input: shape<{ facilityName: string; attempt: number }>(),
    output: shape<{
      patient_name: string;
      PatientTable: Array<{ pat_id: string; mrn_no: string }>;
    }>(),
  });

  it("takes handlers for only the actions that branch", () => {
    // An unhandled action continues with whatever follows the show call, so partial is the point.
    patientSearch.show({
      on: { Next: () => play("next") },
      data: { facilityName: "Acme", attempt: 1 },
    });

    patientSearch.show({ data: { facilityName: "Acme", attempt: 1 } });
  });

  it("still rejects a handler for an action the view cannot raise", () => {
    patientSearch.show({
      // @ts-expect-error "Cancel" is not one of the view's actions
      on: { Cancel: () => play("nope") },
      data: { facilityName: "Acme", attempt: 1 },
    });
  });

  it("rejects an action the view does not declare", () => {
    patientSearch.show({
      // @ts-expect-error "Sideways" is not one of this view's actions
      on: { Next: () => play("n"), Back: () => play("b"), Sideways: () => play("s") },
      data: { facilityName: "Acme", attempt: 1 },
    });
  });

  it("checks the data the view is given", () => {
    patientSearch.show({
      on: { Next: () => play("n"), Back: () => play("b") },
      // @ts-expect-error facilityName is required and attempt must be a number
      data: { attempt: "one" },
    });
  });

  it("accepts refs anywhere the view expects a value", () => {
    patientSearch.show({
      on: { Next: () => play("n"), Back: () => play("b") },
      data: { facilityName: attr<string>("facility"), attempt: attr<number>("attempt") },
    });
  });

  it("types results to the view's output, with tables indexed positionally", () => {
    const result = patientSearch.show({
      on: { Next: () => play("n"), Back: () => play("b") },
      data: { facilityName: "Acme", attempt: 1 },
    });

    expectTypeOf(result.patient_name).toEqualTypeOf<Ref<string>>();
    expectTypeOf(result.PatientTable.at(0).pat_id).toEqualTypeOf<Ref<string>>();

    // @ts-expect-error the view submits no such field
    void result.not_a_field;
  });

  it("makes data optional for a view that takes none", () => {
    const simple = existingView({ viewId: "v", actions: ["Ok"] });
    simple.show({ on: { Ok: () => play("ok") } });
  });
});

describe("action options", () => {
  it("rejects a timeout handler on an action that has no timeout outcome", () => {
    // play() cannot time out, so offering onTimeout would imply a branch that never exists.
    // @ts-expect-error MessageParticipant has no timeout outcome
    void play({ text: "hi", onTimeout: () => play("never") });
  });

  it("offers the outcomes an action does have", () => {
    void collectInput({
      text: "Account number?",
      timeoutSeconds: 5,
      phoneNumber: { format: "E164" },
      onInvalidPhoneNumber: () => play("not a phone number"),
      onError: () => play("failed"),
    });
  });

  it("rejects a timeout handler on a store-mode input", () => {
    // The AWS reference lists InputTimeLimitExceeded for this action, but Connect rejects a
    // store-mode GetParticipantInput that declares it. Confirmed against the live API.
    void collectInput({
      text: "Account number?",
      timeoutSeconds: 5,
      maxLength: 8,
      // @ts-expect-error store-mode input has no timeout outcome
      onTimeout: () => play("nothing entered"),
    });
  });

  it("rejects a wait event Connect does not define", () => {
    // @ts-expect-error only CustomerReturned and BotParticipantDisconnected exist
    void wait({ seconds: 10, on: { SomethingElse: () => play("x") } });
  });

  it("rejects a loop count that is not a number or numeric ref", () => {
    // @ts-expect-error LoopCount must be static or a single reference
    void flowLoop("3", () => play("x"));
  });
});

describe("view outputs", () => {
  interface Outputs {
    notes: string;
    count: number;
    PatientTable: Array<{ pat_id: string }>;
  }

  const authored = defineView({
    title: "Patient",
    actions: ["Next"],
    outputs: shape<Outputs>(),
    body: ({ actions, fields }) =>
      Container({}, [
        FormInput({ name: fields.notes }),
        Table({
          name: fields.PatientTable,
          items: "$.p",
          columns: [{ label: "Patient", id: "pat_id" }],
          actions: [{ label: "Go", action: actions.Next }],
        }),
      ]),
  });

  it("types what the flow reads back", () => {
    const view = existingView({ viewId: "v", view: authored });
    const result = view.show({ on: { Next: () => play("x") } });

    // A scalar field is a typed ref, and a table is addressed positionally, matching the wire format.
    expectTypeOf(result.notes).toEqualTypeOf<Ref<string>>();
    expectTypeOf(result.count).toEqualTypeOf<Ref<number>>();
    expectTypeOf(result.PatientTable.at(0).pat_id).toEqualTypeOf<Ref<string>>();
  });

  it("types $action as the view's declared action union", () => {
    const view = existingView({ viewId: "v", view: authored });
    // A handler sees it too, since it is handed the same result object.
    const result = view.show({
      on: { Next: (r) => expectTypeOf(r.$action).toEqualTypeOf<Ref<"Next">>() },
    });

    // Narrower than `Ref<string>`, so a comparison against a misspelled action name is rejected.
    expectTypeOf(result.$action).toEqualTypeOf<Ref<"Next">>();
  });

  it("rejects a field the view never declared", () => {
    void defineView({
      title: "Bad",
      actions: ["Next"],
      outputs: shape<Outputs>(),
      // @ts-expect-error `nots` is not a declared output field
      body: ({ fields }) => Container({}, [FormInput({ name: fields.nots })]),
    });
  });

  it("rejects reading a result field the view never submits", () => {
    const view = existingView({ viewId: "v", view: authored });
    const result = view.show({ on: { Next: () => play("x") } });
    // @ts-expect-error `missing` is not in the declared output type
    void result.missing;
  });

  it("needs no handlers at all", () => {
    const view = existingView({ viewId: "v", view: authored });
    expectTypeOf(view.show({})).toEqualTypeOf<ViewResult<Outputs, "Next">>();
  });
});

describe("jumps", () => {
  it("returns never, so the compiler knows execution ceased", () => {
    // This is the point of implementing goto as a throw: `never` is what lets TypeScript report the
    // statements below a jump as unreachable, rather than them silently contributing nothing.
    expectTypeOf(goto).returns.toBeNever();
  });

  it("takes a label object rather than a name", () => {
    const done = label("done");
    expectTypeOf(done).toEqualTypeOf<Label>();
    expectTypeOf(done.here()).toEqualTypeOf<Label>();

    // @ts-expect-error a jump targets a label, not a string
    void (() => goto("done"));
  });
});
