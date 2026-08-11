/**
 * Jumps.
 *
 * `label`/`goto` are the one construct here that breaks the rule that a flow reads top to bottom, so
 * what they emit is worth pinning precisely: a label costs no action, a jump redirects the edge that
 * would have continued, and nothing after a jump runs.
 *
 * A jump is a real `throw` of the label object. That is what makes "execution ceases here" true rather
 * than merely documented, and it is why a label needs no name — identity is the label.
 */

import { describe, expect, it } from "vitest";
import {
  attr,
  disconnect,
  flowIf,
  getDigit,
  goto,
  type Label,
  label,
  play,
  setAttributes,
} from "../src/index.js";
import { recordFlow } from "../src/testing/index.js";

const root = { onError: () => disconnect() };

/** The action an identifier names, for asserting on where an edge points. */
function typeOf(flow: ReturnType<typeof recordFlow>, id: string | undefined) {
  return flow.Actions.find((a) => a.Identifier === id)?.Type;
}

function textOf(flow: ReturnType<typeof recordFlow>, id: string | undefined) {
  return flow.Actions.find((a) => a.Identifier === id)?.Parameters.Text;
}

describe("label and goto", () => {
  it("jumps backwards, and costs no action of its own", () => {
    const flow = recordFlow(() => {
      // No here(): a label marks the point it was created, which is what a backward jump wants.
      const menu = label("menu");
      play("Press 1 for sales.");
      goto(menu);
    }, root);

    // Two actions: the prompt and the synthesized terminal. The label and the jump emit nothing.
    expect(flow.Actions.map((a) => a.Type)).toEqual([
      "MessageParticipant",
      "DisconnectParticipant",
    ]);

    // The prompt loops back to itself, because that is what the label named.
    const prompt = flow.Actions.find((a) => a.Type === "MessageParticipant");
    expect(prompt?.Transitions.NextAction).toBe(prompt?.Identifier);
    expect(flow.StartAction).toBe(prompt?.Identifier);
  });

  it("jumps forwards, out of a branch, to a label placed later", () => {
    // Forward jumps are conditional by nature: an unconditional one would make everything between
    // it and the label dead code, which you would simply delete instead.
    const flow = recordFlow(() => {
      const done = label("done");
      flowIf({ op: "equals", left: attr("tier"), right: "gold" }, { ifTrue: () => goto(done) });
      play("standard only");
      done.here();
      play("both");
      disconnect();
    }, root);

    const compare = flow.Actions.find((a) => a.Type === "Compare");
    const gold = compare?.Transitions.Conditions?.[0];
    expect(textOf(flow, gold?.NextAction)).toBe("both");

    const standard = flow.Actions.find((a) => a.Parameters.Text === "standard only");
    expect(textOf(flow, standard?.Transitions.NextAction)).toBe("both");
  });

  it("stops execution at the jump, so nothing after it is recorded", () => {
    const flow = recordFlow(() => {
      const top = label("top").here();
      play("first");
      goto(top);
      // Unreachable: `goto` returns never, so TypeScript flags this under allowUnreachableCode.
      play("never recorded");
    }, root);

    const texts = flow.Actions.filter((a) => a.Type === "MessageParticipant").map(
      (a) => a.Parameters.Text,
    );
    expect(texts).toEqual(["first"]);
  });

  it("jumps out of a branch into the main flow", () => {
    const flow = recordFlow(() => {
      const done = label("done");
      getDigit({
        text: "Press 1 to skip ahead.",
        timeoutSeconds: 5,
        options: {
          "1": () => goto(done),
          "2": () => play("staying"),
        },
      });
      play("middle");
      done.here();
      disconnect();
    }, root);

    const menu = flow.Actions.find((a) => a.Type === "GetParticipantInput");
    const skip = menu?.Transitions.Conditions?.find((c) => c.Condition.Operands[0] === "1");
    const stay = menu?.Transitions.Conditions?.find((c) => c.Condition.Operands[0] === "2");

    // "1" leaves the branch entirely; "2" runs its own action and then rejoins the linear path.
    expect(typeOf(flow, skip?.NextAction)).toBe("DisconnectParticipant");
    expect(textOf(flow, stay?.NextAction)).toBe("staying");
  });

  it("reaches a block that nothing else reaches", () => {
    // The linear path ends at the first disconnect, so the tail below is dead code the pruner would
    // drop. The jump is the only thing keeping it alive, which is what this checks.
    const flow = recordFlow(() => {
      const apology = label("apology");
      getDigit({
        text: "Press 1 if this went wrong.",
        timeoutSeconds: 5,
        options: { "1": () => goto(apology) },
      });
      disconnect();

      apology.here();
      setAttributes({ apologised: "true" });
      disconnect();
    }, root);

    const attributes = flow.Actions.find((a) => a.Type === "UpdateContactAttributes");
    expect(attributes).toBeDefined();

    const menu = flow.Actions.find((a) => a.Type === "GetParticipantInput");
    const jump = menu?.Transitions.Conditions?.find((c) => c.Condition.Operands[0] === "1");
    expect(jump?.NextAction).toBe(attributes?.Identifier);
  });

  it("gives two uses of the same fragment two distinct labels", () => {
    // The reason labels are objects rather than names: this would be a collision otherwise.
    const retryOnce = (message: string) => {
      const again = label("again").here();
      play(message);
      goto(again);
    };

    const flow = recordFlow(() => {
      const skip = label("skip");
      getDigit({
        text: "Press 1 or 2.",
        timeoutSeconds: 5,
        options: { "1": () => retryOnce("first"), "2": () => retryOnce("second") },
      });
      skip.here();
      disconnect();
    }, root);

    // Each copy loops to its own prompt rather than to the other's.
    for (const text of ["first", "second"]) {
      const action = flow.Actions.find((a) => a.Parameters.Text === text);
      expect(action?.Transitions.NextAction).toBe(action?.Identifier);
    }
  });

  it("lets a real error through instead of treating it as a jump", () => {
    expect(() =>
      recordFlow(() => {
        play("hello");
        throw new Error("something actually went wrong");
      }, root),
    ).toThrow(/something actually went wrong/);
  });

  it("moves the label to the here(), rather than leaving the creation point as a second target", () => {
    const flow = recordFlow(() => {
      const retry = label("retry");
      play("first");
      retry.here();
      play("second");
      flowIf({ op: "equals", left: attr("again"), right: "true" }, { ifTrue: () => goto(retry) });
      disconnect();
    }, root);

    const compare = flow.Actions.find((a) => a.Type === "Compare");
    const again = compare?.Transitions.Conditions?.[0];
    expect(textOf(flow, again?.NextAction)).toBe("second");
  });

  it("places a label declared inside a branch at that point in the branch", () => {
    const flow = recordFlow(() => {
      getDigit({
        text: "Press 1 to hear the terms.",
        timeoutSeconds: 5,
        options: {
          "1": () => {
            const terms = label("terms");
            play("the terms");
            goto(terms);
          },
        },
      });
      disconnect();
    }, root);

    const terms = flow.Actions.find((a) => a.Parameters.Text === "the terms");
    expect(terms?.Transitions.NextAction).toBe(terms?.Identifier);
  });

  it("rejects a jump to a label that belongs to another recording", () => {
    let stray: Label | undefined;
    recordFlow(() => {
      stray = label("stray");
      play("hello");
    }, root);

    expect(() =>
      recordFlow(() => {
        play("hi");
        goto(stray as Label);
      }, root),
    ).toThrow(/never placed: stray/);
  });

  it("jumps the same way whether written as a method or as a call", () => {
    // `l.goto()` is the same throw as `goto(l)`, so the two forms have to emit identically.
    const build = (jump: (target: Label) => never) => () => {
      const done = label("done");
      flowIf({ op: "equals", left: attr("tier"), right: "gold" }, { ifTrue: () => jump(done) });
      play("standard only");
      done.here();
      play("both");
      disconnect();
    };

    const asMethod = recordFlow(
      build((target) => target.goto()),
      root,
    );
    const asCall = recordFlow(build(goto), root);

    // Identifiers are per-recording, so compare the shape rather than the raw JSON.
    const shape = (flow: ReturnType<typeof recordFlow>) => {
      const compare = flow.Actions.find((a) => a.Type === "Compare");
      const standard = flow.Actions.find((a) => a.Parameters.Text === "standard only");
      return {
        types: flow.Actions.map((a) => a.Type),
        gold: textOf(flow, compare?.Transitions.Conditions?.[0]?.NextAction),
        fallthrough: textOf(flow, standard?.Transitions.NextAction),
      };
    };

    expect(shape(asMethod)).toEqual(shape(asCall));
    expect(shape(asMethod).gold).toBe("both");
  });

  it("leaves no placeholder behind", () => {
    const flow = recordFlow(() => {
      const top = label().here();
      play("hello");
      goto(top);
    }, root);

    expect(JSON.stringify(flow)).not.toContain("__GOTO__");
  });
});
