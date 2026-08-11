/**
 * A small IVR, deployed with Pulumi.
 *
 * Greet, look the caller up with a Lambda, then route by tier. The interesting parts are that the
 * flow reads as ordinary TypeScript, that `authenticateCaller` comes from a different package, and
 * that nothing here wires the Lambda to Connect by hand.
 */

import { apologizeAndHangUp, authenticateCaller, greetByName } from "@example/connect-patterns";
import * as pulumi from "@pulumi/pulumi";
import {
  ContactFlow,
  type ContactFlowEvent,
  connectLambda,
  disconnect,
  existingView,
  flowIf,
  getDigit,
  onError,
  play,
  setAttributes,
  shape,
  system,
  transferToQueue,
  wait,
} from "pulumi-amazon-connect";

const config = new pulumi.Config();
const instanceId = config.require("instanceId");
const vipQueueArn = config.require("vipQueueArn");
const mainQueueArn = config.require("mainQueueArn");

/**
 * A view that already exists in the instance, declared with the types it accepts and submits.
 *
 * The declaration is what makes `show` check the data passed in, require a handler for every action,
 * and hand back references shaped like the view's output.
 */
const orderPicker = existingView({
  viewId: config.require("orderPickerViewId"),
  actions: ["OrderSelected", "Skip"],
  input: shape<{ customerTier: string }>(),
  output: shape<{ OrderTable: Array<{ order_id: string; status: string }> }>(),
});

/**
 * An ordinary Lambda. Pulumi serializes the closure and deploys it; this library only types the
 * call and wires up the association and invoke permission.
 */
const lookupCustomer = connectLambda("lookupCustomer", {
  timeoutSeconds: 5,
  handler: async (
    event: ContactFlowEvent<{ phone: string; account: string }>,
  ): Promise<{ tier: string; holdSeconds: string }> => {
    // The whole invocation: what the flow passed, and everything Connect sends about the contact.
    const { Parameters, ContactData } = event.Details;
    // Stands in for a real lookup against a CRM.
    const isVip = Parameters.account.startsWith("9") || ContactData.Attributes.knownVip === "true";
    return { tier: isVip ? "gold" : "standard", holdSeconds: isVip ? "10" : "180" };
  },
});

function inboundFlow(): void {
  greetByName();

  const account = authenticateCaller({ accountLength: 8 });

  // One handler covering the lookup and everything that depends on it.
  onError(() => {
    const customer = lookupCustomer({
      phone: system.customerEndpoint.address,
      account,
    });

    setAttributes({ tier: customer.tier });

    flowIf(
      { op: "equals", left: customer.tier, right: "gold" },
      {
        ifTrue: () => {
          play("Connecting you to your dedicated team.");

          // Chat only, so this branch assumes a chat contact. Each handler receives the submitted
          // data, typed by the view's declaration: OrderTable rows are indexed positionally,
          // which is how Connect reports the row the agent picked.
          orderPicker.show({
            data: { customerTier: customer.tier },
            on: {
              OrderSelected: (picked) => {
                setAttributes({ selectedOrder: picked.OrderTable.at(0).order_id });
              },
              Skip: () => play("No problem."),
            },
          });

          transferToQueue({ queue: vipQueueArn });
        },
        ifFalse: () => {
          getDigit({
            text: "Press 1 to hold, or 2 to request a call back.",
            timeoutSeconds: 5,
            options: {
              "1": () => {
                play("Please hold.");
                transferToQueue({ queue: mainQueueArn });
              },
              "2": () => {
                setAttributes({ callbackRequested: "true" });
                play("We'll call you back shortly.");
                disconnect();
              },
            },
            // Callers who do nothing get the default rather than a dead end.
            onTimeout: () => {
              wait(2);
              transferToQueue({ queue: mainQueueArn });
            },
          });
        },
      },
    );
  }, apologizeAndHangUp);
}

const inbound = new ContactFlow("inbound", {
  instanceId,
  description: "Main inbound IVR",
  flow: inboundFlow,
  // Covers anything the inner onError does not.
  onError: apologizeAndHangUp,
});

export const flowId = inbound.flowId;
export const flowArn = inbound.arn;
/** Useful for diffing against `aws connect describe-contact-flow`. */
export const content = inbound.content;
export const lookupCustomerArn = lookupCustomer.function.arn;
