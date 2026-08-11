/**
 * Routing: where the contact goes next.
 */

import { type Ref, type ResourceRef, renderResource, renderValue } from "../refs.js";
import { NO_MATCHING_ERROR } from "../types.js";
import { compact, type OutcomeHandler, recordAction } from "./action.js";

/** A queue id or ARN, an agent id or ARN, or a reference resolving to one. */
export type QueueTarget = { queue: ResourceRef } | { agent: ResourceRef };

export interface SetQueueOptions {
  onError?: OutcomeHandler;
}

/**
 * Sets the contact's target queue without transferring to it.
 *
 * Every action that implicitly checks "the queue" — queue metrics, hours of operation — reads what
 * this sets.
 */
export function setQueue(target: QueueTarget, options: SetQueueOptions = {}): void {
  recordAction({
    type: "UpdateContactTargetQueue",
    hint: "set-queue",
    parameters: compact({
      QueueId: "queue" in target ? renderResource(target.queue) : undefined,
      AgentId: "agent" in target ? renderResource(target.agent) : undefined,
    }),
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

export interface TransferToQueueOptions {
  /** Runs when the destination queue is full and the contact cannot be enqueued. */
  onQueueAtCapacity?: OutcomeHandler;
  onError?: OutcomeHandler;
}

/**
 * Places the contact into its target queue.
 *
 * Passing a target is a convenience that emits `UpdateContactTargetQueue` *and*
 * `TransferContactToQueue` — two actions against the 250 budget, not one. Omit it when the queue is
 * already set.
 *
 * ```ts
 * transferToQueue({ queue: salesQueueArn }, { onQueueAtCapacity: offerCallback });
 * ```
 */
export function transferToQueue(target?: QueueTarget, options: TransferToQueueOptions = {}): void {
  if (target !== undefined) {
    setQueue(target, options.onError === undefined ? {} : { onError: options.onError });
  }

  recordAction({
    type: "TransferContactToQueue",
    hint: "transfer-to-queue",
    // The queue comes from the contact's target queue; this action takes no parameters.
    parameters: {},
    requiredErrors: [NO_MATCHING_ERROR, "QueueAtCapacity"],
    outcomes: {
      [NO_MATCHING_ERROR]: options.onError,
      QueueAtCapacity: options.onQueueAtCapacity,
    },
  });
}

/**
 * Places a queued contact into a different queue.
 *
 * Unlike {@link transferToQueue}, this works on a contact that is already in a queue — it dequeues
 * first. The destination is explicit rather than taken from the target queue.
 */
export function dequeueAndTransferToQueue(
  target: { queue: ResourceRef },
  options: TransferToQueueOptions = {},
): void {
  recordAction({
    type: "DequeueContactAndTransferToQueue",
    hint: "dequeue-to-queue",
    parameters: { QueueId: renderResource(target.queue) },
    requiredErrors: [NO_MATCHING_ERROR, "QueueAtCapacity"],
    outcomes: {
      [NO_MATCHING_ERROR]: options.onError,
      QueueAtCapacity: options.onQueueAtCapacity,
    },
  });
}

/**
 * Connects the contact straight to an agent, bypassing queue routing. Terminal.
 *
 * Real flows emit this with empty transitions, so nothing after it runs.
 */
export function transferToAgent(): void {
  recordAction({
    type: "TransferContactToAgent",
    hint: "transfer-to-agent",
    parameters: {},
    terminal: true,
  });
}

interface ThirdPartyCommon {
  /** E.164 number to dial. */
  phoneNumber: string | Ref<string>;
  /**
   * How long to wait for the third party to answer.
   *
   * Required: the AWS reference marks it optional, but Connect rejects the action without it.
   */
  connectionTimeoutSeconds: number | Ref<number>;
  /** Digits to send once connected, for navigating an IVR on the other end. */
  dtmfDigits?: string | Ref<string>;
  onError?: OutcomeHandler;
}

/**
 * Options for dialling a third party.
 *
 * `continueFlowExecution` is required, and it decides which outcomes exist. Handing the call over
 * (`false`) ends this flow's involvement, so there is no branch left to take when the dial fails —
 * Connect rejects `CallFailed` and `ConnectionTimeLimitExceeded` on such an action. Keeping control
 * (`true`) is what makes those outcomes available, so they appear on the type only in that case.
 */
export type ThirdPartyOptions =
  | (ThirdPartyCommon & { continueFlowExecution: false })
  | (ThirdPartyCommon & {
      continueFlowExecution: true;
      /** Runs when the call could not be placed. */
      onCallFailed?: OutcomeHandler;
      /** Runs when the third party did not answer within the connection time limit. */
      onTimeout?: OutcomeHandler;
    });

/**
 * Dials a third party and bridges them onto the contact.
 *
 * ```ts
 * // hands the call over and stops
 * transferToThirdParty({ phoneNumber: "+15555550123", continueFlowExecution: false });
 *
 * // keeps control, so failures can be handled
 * transferToThirdParty({
 *   phoneNumber: "+15555550123",
 *   connectionTimeoutSeconds: 30,
 *   continueFlowExecution: true,
 *   onTimeout: () => play("They didn't pick up."),
 * });
 * ```
 */
export function transferToThirdParty(options: ThirdPartyOptions): void {
  const continues = options.continueFlowExecution;
  const handlers = continues
    ? (options as Extract<ThirdPartyOptions, { continueFlowExecution: true }>)
    : undefined;

  recordAction({
    type: "TransferParticipantToThirdParty",
    hint: "transfer-third-party",
    parameters: compact({
      ThirdPartyPhoneNumber: renderValue(options.phoneNumber),
      ThirdPartyConnectionTimeLimitSeconds: renderValue(options.connectionTimeoutSeconds),
      // Required by the service, despite reading as optional in the reference.
      ContinueFlowExecution: continues ? "True" : "False",
      ThirdPartyDTMFDigits:
        options.dtmfDigits === undefined ? undefined : renderValue(options.dtmfDigits),
    }),
    requiredErrors: [
      NO_MATCHING_ERROR,
      ...(continues ? ["CallFailed", "ConnectionTimeLimitExceeded"] : []),
    ],
    outcomes: {
      [NO_MATCHING_ERROR]: options.onError,
      CallFailed: handlers?.onCallFailed,
      ConnectionTimeLimitExceeded: handlers?.onTimeout,
    },
  });
}

/**
 * Jumps to another flow, which starts running from its own beginning.
 *
 * Control does not come back, so any action recorded after this one is unreachable at runtime. The
 * action is still emitted as non-terminal, because the transfer itself can fail and that error needs
 * somewhere to go.
 *
 * The id may be a Pulumi output, so one flow can reference another declared in the same program.
 */
export function transferToFlow(
  flowId: ResourceRef,
  options: { onError?: OutcomeHandler } = {},
): void {
  recordAction({
    type: "TransferToFlow",
    hint: "transfer-to-flow",
    parameters: { ContactFlowId: renderResource(flowId) },
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}
