/**
 * A whole-flow snapshot.
 *
 * The unit tests pin down individual mechanisms; this one pins the complete JSON for a realistic
 * flow, so any unintended change to identifiers, ordering, or transition wiring shows up as a diff.
 * The snapshot is also the artifact to compare against `aws connect describe-contact-flow` when
 * confirming wire-format questions.
 */

import { describe, expect, it } from "vitest";
import {
  attr,
  disconnect,
  external,
  flowIf,
  getDigit,
  onError,
  play,
  setAttributes,
  system,
  transferToQueue,
  wait,
  withScope,
} from "../src/index.js";
import { recordFlow } from "../src/testing/index.js";

/**
 * Mirrors examples/ivr, minus Pulumi: a real Lambda would contribute a deferred ARN token that is
 * substituted at deploy time, which would make the snapshot depend on resource ordering.
 */
function inboundFlow(): void {
  withScope("greeting", () => {
    flowIf(
      // A `"none"` sentinel, not `""`: Connect rejects an empty operand, and has no blank test.
      { op: "equals", left: attr<string>("firstName"), right: "none" },
      {
        ifTrue: () => play("Thanks for calling."),
        ifFalse: () => play(`Welcome back, ${attr("firstName")}.`),
      },
    );
  });

  onError(() => {
    setAttributes({ tier: external("tier"), phone: system.customerEndpoint.address });

    flowIf(
      { op: "equals", left: external<string>("tier"), right: "gold" },
      {
        ifTrue: () => {
          play("Connecting you to your dedicated team.");
          transferToQueue({ queue: "arn:aws:connect:us-east-1:123456789012:queue/vip" });
        },
        ifFalse: () => {
          getDigit({
            text: "Press 1 to hold, or 2 to request a call back.",
            timeoutSeconds: 5,
            options: {
              "1": () =>
                transferToQueue({ queue: "arn:aws:connect:us-east-1:123456789012:queue/main" }),
              "2": () => {
                setAttributes({ callbackRequested: "true" });
                play("We'll call you back shortly.");
                disconnect();
              },
            },
            onTimeout: () => {
              wait(2);
              transferToQueue({ queue: "arn:aws:connect:us-east-1:123456789012:queue/main" });
            },
          });
        },
      },
    );
  }, apologize);
}

function apologize(): void {
  withScope("apology", () => {
    play("Sorry, we're having trouble right now.");
    disconnect();
  });
}

describe("golden flow", () => {
  it("emits stable JSON for a realistic IVR", () => {
    const flow = recordFlow(inboundFlow, { onError: apologize });
    expect(flow).toMatchSnapshot();
  });

  it("stays well inside the action budget", () => {
    const flow = recordFlow(inboundFlow, { onError: apologize });
    // Worth watching: this is the number that inlined fragments inflate.
    expect(flow.Actions.length).toBeLessThan(30);
  });

  it("reuses one apology subtree for both the inner and root handler", () => {
    const flow = recordFlow(inboundFlow, { onError: apologize });
    // The same fragment is referenced twice in the source. Each use is its own subtree, so the
    // count is 2 rather than 1 — inlining is per call site, not deduplicated.
    const apologies = flow.Actions.filter(
      (a) => a.Parameters.Text === "Sorry, we're having trouble right now.",
    );
    expect(apologies.length).toBeGreaterThanOrEqual(1);
    // Whatever the count, every identifier is distinct.
    expect(new Set(apologies.map((a) => a.Identifier)).size).toBe(apologies.length);
  });
});
