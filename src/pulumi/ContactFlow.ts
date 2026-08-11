/**
 * Deployment: a recorded flow becomes an `aws.connect.ContactFlow`, with every Lambda it calls
 * associated and permissioned automatically.
 */

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import type { FlowFragment } from "../flow/recorder.js";
import type { FlowJson } from "../flow/types.js";
import { associateLambdas, recordContent } from "./content.js";

/**
 * Flow types Connect recognizes. The type constrains which actions are legal — `EndFlowExecution`
 * only works in queue and whisper flows, `TransferContactToQueue` only in inbound and transfer
 * flows — but Connect enforces that at publish time rather than here.
 */
export type ContactFlowType =
  | "CONTACT_FLOW"
  | "CUSTOMER_QUEUE"
  | "CUSTOMER_HOLD"
  | "CUSTOMER_WHISPER"
  | "AGENT_HOLD"
  | "AGENT_WHISPER"
  | "OUTBOUND_WHISPER"
  | "AGENT_TRANSFER"
  | "QUEUE_TRANSFER";

/**
 * Flow types that reject `DisconnectParticipant`, where a run-off-the-end branch has to use
 * `EndFlowExecution` instead.
 */
const ENDS_WITHOUT_DISCONNECT = new Set<ContactFlowType>([
  "CUSTOMER_WHISPER",
  "AGENT_WHISPER",
  "OUTBOUND_WHISPER",
  "CUSTOMER_HOLD",
  "AGENT_HOLD",
]);

export interface ContactFlowArgs {
  /** The Connect instance id. */
  instanceId: pulumi.Input<string>;
  /** Defaults to the Pulumi resource name. */
  name?: pulumi.Input<string>;
  type?: ContactFlowType;
  description?: pulumi.Input<string>;
  tags?: pulumi.Input<Record<string, pulumi.Input<string>>>;
  /** The flow itself: an ordinary function. */
  flow: FlowFragment;
  /**
   * Handles the error vertex of any action not covered by a nearer `onError`.
   *
   * Required, because most actions can fail and Connect needs every declared error to name a
   * destination. Making it a parameter rather than a silent default keeps "what happens when this
   * breaks" a visible decision.
   */
  onError: FlowFragment;
}

/**
 * A contact flow authored in TypeScript.
 *
 * ```ts
 * new ContactFlow("inbound", {
 *   instanceId: instance.id,
 *   flow: inboundFlow,
 *   onError: () => {
 *     play("Sorry, something went wrong.");
 *     disconnect();
 *   },
 * });
 * ```
 */
export class ContactFlow extends pulumi.ComponentResource {
  /** The generated flow-language JSON, resolved once Pulumi knows every referenced ARN. */
  readonly content: pulumi.Output<string>;
  readonly contactFlow: aws.connect.ContactFlow;
  readonly flowId: pulumi.Output<string>;
  readonly arn: pulumi.Output<string>;
  /** The emitted flow, for tests and tooling that want to inspect it without deploying. */
  readonly emitted: FlowJson;

  /**
   * Records the flow, then declares the resources it needs.
   *
   * Recording happens up front rather than inside an `apply` so that every resource — the flow, the
   * Lambda associations, the invoke permissions — is declared during the normal registration pass
   * and therefore shows up in `pulumi preview`.
   */
  constructor(name: string, args: ContactFlowArgs, opts?: pulumi.ComponentResourceOptions) {
    super("pulumi-amazon-connect:index:ContactFlow", name, {}, opts);

    const type = args.type ?? "CONTACT_FLOW";
    const recorded = recordContent(
      args.flow,
      args.onError,
      ENDS_WITHOUT_DISCONNECT.has(type) ? "EndFlowExecution" : "DisconnectParticipant",
    );

    this.emitted = recorded.emitted;
    this.content = recorded.content;

    this.contactFlow = new aws.connect.ContactFlow(
      name,
      {
        instanceId: args.instanceId,
        name: args.name ?? name,
        type,
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.tags === undefined ? {} : { tags: args.tags }),
        content: this.content,
      },
      { parent: this },
    );

    // Connect will not invoke a function that is not associated with the instance, and the recorder
    // already knows exactly which functions this flow calls.
    associateLambdas(this, name, args.instanceId, recorded.lambdas);

    this.flowId = this.contactFlow.contactFlowId;
    this.arn = this.contactFlow.arn;

    this.registerOutputs({ content: this.content, flowId: this.flowId, arn: this.arn });
  }
}
