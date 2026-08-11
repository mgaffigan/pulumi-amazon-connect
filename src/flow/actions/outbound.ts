/**
 * Outbound contacts: placing the call, reading what answered it, and starting an SMS chat.
 *
 * These run in flows attached to outbound contacts and campaigns, not inbound ones.
 */

import type { FlowFragment } from "../recorder.js";
import { type Ref, type ResourceRef, renderResource, renderValue } from "../refs.js";
import { NO_MATCHING_ERROR } from "../types.js";
import { compact, type OutcomeHandler, type ResultBranch, recordAction } from "./action.js";

export interface VoiceConnector {
  /** Only Chime voice connectors are supported. */
  type: "ChimeConnector";
  arn: ResourceRef;
  fromUser: string | Ref<string>;
  toUser: string | Ref<string>;
  /** SIP user-to-user information. */
  userToUserInformation?: string | Ref<string>;
}

export interface CompleteOutboundCallOptions {
  /** Overrides the caller ID presented. Ignored when using a voice connector. */
  callerIdNumber?: string | Ref<string>;
  voiceConnector?: VoiceConnector;
  /** Voice connector only. 1-600 seconds to wait for an answer. */
  connectionTimeoutSeconds?: number | Ref<number>;
}

/**
 * Places the outbound call.
 *
 * Only valid while a contact is mid-way through dialling out but has not yet called the number. Skip
 * it and the first participant action places the call implicitly — this action exists to set a caller
 * ID or route through a voice connector first.
 */
export function completeOutboundCall(options: CompleteOutboundCallOptions = {}): void {
  recordAction({
    type: "CompleteOutboundCall",
    hint: "complete-outbound-call",
    parameters: compact({
      CallerId:
        options.callerIdNumber === undefined
          ? undefined
          : { Number: renderValue(options.callerIdNumber) },
      VoiceConnector:
        options.voiceConnector === undefined
          ? undefined
          : compact({
              VoiceConnectorType: options.voiceConnector.type,
              VoiceConnectorArn: renderResource(options.voiceConnector.arn),
              FromUser: renderValue(options.voiceConnector.fromUser),
              ToUser: renderValue(options.voiceConnector.toUser),
              UserToUserInformation:
                options.voiceConnector.userToUserInformation === undefined
                  ? undefined
                  : renderValue(options.voiceConnector.userToUserInformation),
            }),
      ConnectionTimeLimitSeconds:
        options.connectionTimeoutSeconds === undefined
          ? undefined
          : renderValue(options.connectionTimeoutSeconds),
    }),
    // This action documents no errors.
    requiredErrors: [],
  });
}

export interface OutboundCallStatusOptions {
  /** A person picked up. */
  onAnswered?: FlowFragment;
  /** Voicemail, and a beep was detected — safe to leave a message. */
  onVoicemailBeep?: FlowFragment;
  /** Voicemail, but no beep was detected or it could not be identified. */
  onVoicemailNoBeep?: FlowFragment;
  /** Neither could be determined: long silence or heavy background noise. */
  onNotDetected?: FlowFragment;
  onError?: OutcomeHandler;
}

/**
 * Branches on what answered an outbound call.
 *
 * ```ts
 * checkOutboundCallStatus({
 *   onAnswered: () => transferToQueue(),
 *   onVoicemailBeep: leaveMessage,
 *   onVoicemailNoBeep: () => disconnect(),
 * });
 * ```
 *
 * Outbound campaigns only.
 */
export function checkOutboundCallStatus(options: OutboundCallStatusOptions = {}): void {
  const branch = (operand: string, handler: FlowFragment | undefined): ResultBranch => ({
    operands: [operand],
    ...(handler === undefined ? {} : { handler }),
  });

  recordAction({
    type: "CheckOutboundCallStatus",
    hint: "check-call-progress",
    parameters: {},
    conditions: [
      branch("CallAnswered", options.onAnswered),
      branch("VoicemailBeep", options.onVoicemailBeep),
      branch("VoicemailNoBeep", options.onVoicemailNoBeep),
      branch("NotDetected", options.onNotDetected),
    ],
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

export interface OutboundChatOptions {
  /** The Connect phone number to send from, as an ARN. */
  fromPhoneNumberArn: string | Ref<string>;
  /** The customer's number in E.164. */
  toPhoneNumber: string | Ref<string>;
  /** The flow that will handle the new chat contact. */
  flowArn: string | Ref<string>;
  /** First message to send. */
  initialMessage?: string | Ref<string>;
  /** Links the new contact to the current one. */
  relateToCurrentContact?: boolean;
  onError?: OutcomeHandler;
}

/**
 * Starts an outbound SMS conversation.
 *
 * ```ts
 * startOutboundChat({
 *   fromPhoneNumberArn: smsNumberArn,
 *   toPhoneNumber: system.customerEndpoint.address,
 *   flowArn: smsFlow.arn,
 *   initialMessage: "Here's the link you asked for.",
 * });
 * ```
 *
 * SMS is the only supported subtype, and the endpoint types are fixed, so neither is a parameter.
 */
export function startOutboundChat(options: OutboundChatOptions): void {
  recordAction({
    type: "StartOutboundChatContact",
    hint: "start-outbound-chat",
    parameters: compact({
      SourceEndpoint: {
        Address: renderValue(options.fromPhoneNumberArn),
        Type: "CONNECT_PHONENUMBER_ARN",
      },
      DestinationEndpoint: {
        Address: renderValue(options.toPhoneNumber),
        Type: "TELEPHONE_NUMBER",
      },
      ContactFlowArn: renderValue(options.flowArn),
      ContactSubtype: "connect:SMS",
      InitialSystemMessage:
        options.initialMessage === undefined
          ? undefined
          : { Content: renderValue(options.initialMessage) },
      RelatedContact: options.relateToCurrentContact === true ? "CURRENT" : undefined,
    }),
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}
