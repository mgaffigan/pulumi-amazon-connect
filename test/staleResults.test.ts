/**
 * Results that a later action overwrites.
 *
 * Connect gives `$.External`, `$.Views.ViewResultData` and `$.StoredCustomerInput` no scoping: the
 * next Lambda, view or collection replaces what is there, and the references the previous one handed
 * back go on reading the same paths — now pointing at someone else's values. That is invisible in the
 * emitted JSON and shows up as a wrong answer on a live contact, so it is rejected where it is
 * written instead.
 */

import * as pulumi from "@pulumi/pulumi";
import { describe, expect, it } from "vitest";
import {
  attr,
  collectInput,
  connectLambda,
  disconnect,
  existingView,
  flowIf,
  flowLoop,
  onError,
  play,
  setAttributes,
  setFlowAttributes,
  shape,
} from "../src/index.js";
import { recordFlow } from "../src/testing/index.js";

pulumi.runtime.setMocks(
  {
    newResource(args: pulumi.runtime.MockResourceArgs) {
      return { id: `${args.name}-id`, state: { ...args.inputs, arn: `arn:${args.name}` } };
    },
    call(args: pulumi.runtime.MockCallArgs) {
      return args.inputs;
    },
  },
  "project",
  "stack",
);

const root = { onError: () => disconnect() };

/** A Lambda whose handler is irrelevant here: only the invocation's effect on `$.External` matters. */
function lambda(name: string) {
  return connectLambda(name, {
    handler: async () => ({ tier: "gold" }),
  });
}

const lookup = lambda("lookupCustomer");
const balance = lambda("checkBalance");

describe("a Lambda's result", () => {
  it("is readable up to the next invocation", () => {
    const flow = recordFlow(() => {
      const customer = lookup({});
      setAttributes({ tier: customer.tier });
      const account = balance({});
      setAttributes({ tier2: account.tier });
      disconnect();
    }, root);

    const written = flow.Actions.filter((a) => a.Type === "UpdateContactAttributes").map(
      (a) => (a.Parameters as { Attributes: Record<string, string> }).Attributes,
    );
    expect(written).toEqual([{ tier: "$.External.tier" }, { tier2: "$.External.tier" }]);
  });

  it("is rejected once another Lambda has replaced it", () => {
    expect(() =>
      recordFlow(() => {
        const customer = lookup({});
        balance({});
        setAttributes({ tier: customer.tier });
        disconnect();
      }, root),
    ).toThrow(
      /\$\.External no longer holds the result of Lambda "lookupCustomer": Lambda "checkBalance" replaced it/,
    );
  });

  it("feeds the next invocation, which is a chained call and not a stale read", () => {
    // Connect resolves an action's parameters and only then invokes, so the slot still holds the
    // previous result while this one's input is being built.
    const flow = recordFlow(() => {
      const customer = lookup({});
      balance({ tier: customer.tier });
      disconnect();
    }, root);

    const chained = flow.Actions.filter((a) => a.Type === "InvokeLambdaFunction")[1]?.Parameters as
      | { LambdaInvocationAttributes: object }
      | undefined;
    expect(chained?.LambdaInvocationAttributes).toEqual({ tier: "$.External.tier" });
  });

  it("is rejected when interpolated into text rather than passed as a parameter", () => {
    // Interpolation never touches `path`, so the check has to sit on `toString` as well — otherwise
    // the most common way to spend a reference is the one way that escapes it.
    expect(() =>
      recordFlow(() => {
        const customer = lookup({});
        balance({});
        play(`You are ${customer.tier}.`);
        disconnect();
      }, root),
    ).toThrow(/no longer holds the result of Lambda "lookupCustomer"/);
  });

  it("is rejected inside the next invocation's own error handler", () => {
    // The handler is reached because that invocation failed, so whatever is in `$.External` there is
    // nobody's — least of all the previous call's.
    expect(() =>
      recordFlow(() => {
        const customer = lookup({});
        balance({}, { onError: () => play(`${customer.tier}`) });
        disconnect();
      }, root),
    ).toThrow(/no longer holds the result of Lambda "lookupCustomer"/);
  });

  it("survives an asynchronous invocation, which fills nothing", () => {
    const notify = connectLambda("notify", {
      invocationType: "ASYNCHRONOUS",
      handler: async () => undefined,
    });

    const flow = recordFlow(() => {
      const customer = lookup({});
      void notify({});
      setAttributes({ tier: customer.tier });
      disconnect();
    }, root);

    expect(flow.Actions.some((a) => a.Type === "InvokeLambdaFunction")).toBe(true);
  });

  it("survives actions that fill a different slot", () => {
    const view = existingView({ viewId: "v1", output: shape<{ note: string }>() });

    const flow = recordFlow(() => {
      const customer = lookup({});
      const submitted = view.show({});
      setAttributes({ tier: customer.tier, note: submitted.note });
      disconnect();
    }, root);

    expect(flow.Actions.some((a) => a.Type === "ShowView")).toBe(true);
  });
});

describe("a branch", () => {
  it("keeps its own result readable inside itself", () => {
    const flow = recordFlow(() => {
      flowIf(
        { op: "equals", left: attr("vip"), right: "true" },
        {
          ifTrue: () => {
            const customer = lookup({});
            setAttributes({ tier: customer.tier });
          },
        },
      );
      disconnect();
    }, root);

    expect(flow.Actions.some((a) => a.Type === "InvokeLambdaFunction")).toBe(true);
  });

  it("does not invalidate a result for the branch beside it", () => {
    // Only one branch runs, so an invocation in the first cannot have replaced anything the second
    // reads.
    const flow = recordFlow(() => {
      const customer = lookup({});
      flowIf(
        { op: "equals", left: attr("vip"), right: "true" },
        {
          ifTrue: () => {
            balance({});
          },
          ifFalse: () => setAttributes({ tier: customer.tier }),
        },
      );
      disconnect();
    }, root);

    expect(flow.Actions.some((a) => a.Type === "Compare")).toBe(true);
  });

  it("invalidates what it may have replaced, for the code after it", () => {
    expect(() =>
      recordFlow(() => {
        const customer = lookup({});
        flowIf(
          { op: "equals", left: attr("vip"), right: "true" },
          {
            ifTrue: () => {
              balance({});
            },
          },
        );
        setAttributes({ tier: customer.tier });
        disconnect();
      }, root),
    ).toThrow(/Lambda "checkBalance" on a branch that may not run replaced it/);
  });

  it("invalidates its own result too, since it may not have run", () => {
    let escaped: { tier: { toString(): string } } | undefined;
    expect(() =>
      recordFlow(() => {
        flowIf(
          { op: "equals", left: attr("vip"), right: "true" },
          {
            ifTrue: () => {
              escaped = lookup({});
            },
          },
        );
        setAttributes({ tier: String(escaped?.tier) });
        disconnect();
      }, root),
    ).toThrow(/no longer holds the result of Lambda "lookupCustomer"/);
  });
});

describe("an error scope", () => {
  it("does not invalidate its body from its handler, which the body never falls into", () => {
    // The handler is recorded first but runs last, and only on failure. Merging what it replaced at
    // the point it was captured would reject the body's very first read.
    const flow = recordFlow(() => {
      const customer = lookup({});
      onError(
        () => setAttributes({ tier: customer.tier }),
        () => {
          balance({});
        },
      );
      disconnect();
    }, root);

    expect(flow.Actions.some((a) => a.Type === "UpdateContactAttributes")).toBe(true);
  });

  it("invalidates what its handler may have replaced, for the code after it", () => {
    expect(() =>
      recordFlow(() => {
        const customer = lookup({});
        onError(
          () => play("working"),
          () => {
            balance({});
          },
        );
        setAttributes({ tier: customer.tier });
        disconnect();
      }, root),
    ).toThrow(/Lambda "checkBalance" on a branch that may not run replaced it/);
  });
});

describe("a loop body", () => {
  it("rejects a result it both reads and replaces", () => {
    // Correct on the first iteration and wrong on every one after it, which is exactly the kind of
    // bug that only shows up under load.
    expect(() =>
      recordFlow(() => {
        const customer = lookup({});
        flowLoop(3, () => {
          setAttributes({ tier: customer.tier });
          balance({});
        });
        disconnect();
      }, root),
    ).toThrow(/only correct on the first iteration/);
  });

  it("accepts a result it produces and reads within the same iteration", () => {
    const flow = recordFlow(() => {
      flowLoop(3, () => {
        const customer = lookup({});
        setAttributes({ tier: customer.tier });
      });
      disconnect();
    }, root);

    expect(flow.Actions.some((a) => a.Type === "Loop")).toBe(true);
  });
});

describe("other slots", () => {
  it("rejects a view result read after another view", () => {
    const first = existingView({ viewId: "v1", output: shape<{ nickname: string }>() });
    const second = existingView({ viewId: "v2", output: shape<{ note: string }>() });

    expect(() =>
      recordFlow(() => {
        const a = first.show({});
        second.show({});
        setAttributes({ nickname: a.nickname });
        disconnect();
      }, root),
    ).toThrow(/\$\.Views\.ViewResultData no longer holds the result of a view/);
  });

  it("rejects a view's action read after another view", () => {
    // `$.Views.Action` is refilled by the same ShowView that refills the data, so it goes stale with
    // it rather than surviving as the previous view's choice.
    const first = existingView({ viewId: "v1", actions: ["Next"] });
    const second = existingView({ viewId: "v2", actions: ["Done"] });

    expect(() =>
      recordFlow(() => {
        const a = first.show({});
        second.show({});
        setAttributes({ chose: a.$action });
        disconnect();
      }, root),
    ).toThrow(/no longer holds the result of a view/);
  });

  it("hands a view's action handler that view's own result", () => {
    const view = existingView({
      viewId: "v1",
      actions: ["Next"],
      output: shape<{ note: string }>(),
    });

    const flow = recordFlow(() => {
      view.show({ on: { Next: (result) => setAttributes({ note: result.note }) } });
      disconnect();
    }, root);

    const written = flow.Actions.find((a) => a.Type === "UpdateContactAttributes")?.Parameters as {
      Attributes: Record<string, string>;
    };
    expect(written.Attributes).toEqual({ note: "$.Views.ViewResultData.note" });
  });

  it("lets a view's data carry the previous view's result, and a prompt the last collection", () => {
    const first = existingView({ viewId: "v1", output: shape<{ nickname: string }>() });
    const second = existingView({
      viewId: "v2",
      input: shape<{ nickname: string }>(),
      output: shape<{ note: string }>(),
    });

    const flow = recordFlow(() => {
      const a = first.show({});
      second.show({ data: { nickname: a.nickname } });
      const account = collectInput({ text: "Account?", timeoutSeconds: 5, maxLength: 8 });
      collectInput({ text: `You entered ${account}. Try again.`, timeoutSeconds: 5, maxLength: 8 });
      disconnect();
    }, root);

    const shown = flow.Actions.filter((a) => a.Type === "ShowView")[1]?.Parameters as
      | { ViewData: object }
      | undefined;
    expect(shown?.ViewData).toEqual({ nickname: "$.Views.ViewResultData.nickname" });

    const retry = flow.Actions.filter((a) => a.Type === "GetParticipantInput")[1];
    expect(retry?.Parameters.Text).toBe("You entered $.StoredCustomerInput. Try again.");
  });

  it("rejects a collected input read after the next collection", () => {
    expect(() =>
      recordFlow(() => {
        const account = collectInput({ text: "Account?", timeoutSeconds: 5, maxLength: 8 });
        collectInput({ text: "PIN?", timeoutSeconds: 5, maxLength: 4 });
        setAttributes({ account });
        disconnect();
      }, root),
    ).toThrow(/\$\.StoredCustomerInput no longer holds the result of collectInput/);
  });

  it("accepts a result copied into a flow attribute before it is replaced", () => {
    // The suggested fix in the message, exercised: a flow attribute outlives every one of these slots.
    const flow = recordFlow(() => {
      const customer = lookup({});
      setFlowAttributes({ tier: customer.tier });
      balance({});
      setAttributes({ tier: attr("tier") });
      play(`Your tier is ${attr("tier")}.`);
      disconnect();
    }, root);

    expect(flow.Actions.some((a) => a.Type === "UpdateFlowAttributes")).toBe(true);
  });
});
