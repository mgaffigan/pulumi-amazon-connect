/**
 * Voice ID: streaming the caller's audio for analysis, and branching on the result.
 *
 * Voice channel only — on chat or task these actions take the error branch. The instance needs a
 * Voice ID domain, and `setContactData` is where authentication and fraud detection get switched on
 * for a contact.
 */

import type { FlowFragment } from "../recorder.js";
import { NO_MATCHING_ERROR } from "../types.js";
import { type OutcomeHandler, type ResultBranch, recordAction } from "./action.js";

/**
 * Branches for `CheckVoiceIdOption: "enrollmentStatus"`.
 *
 * Checking enrollment is not billed, unlike the other two options.
 */
export interface EnrollmentStatusOptions {
  check: "enrollmentStatus";
  onEnrolled?: FlowFragment;
  onNotEnrolled?: FlowFragment;
  onOptedOut?: FlowFragment;
  onError?: OutcomeHandler;
}

/** Branches for `CheckVoiceIdOption: "voiceAuthentication"`. */
export interface VoiceAuthenticationOptions {
  check: "voiceAuthentication";
  onAuthenticated?: FlowFragment;
  onNotAuthenticated?: FlowFragment;
  /** Voice ID could not analyze the speech, usually for want of ten seconds of audio. */
  onInconclusive?: FlowFragment;
  onNotEnrolled?: FlowFragment;
  onOptedOut?: FlowFragment;
  onError?: OutcomeHandler;
}

/** Branches for `CheckVoiceIdOption: "fraudDetection"`. */
export interface FraudDetectionOptions {
  check: "fraudDetection";
  onHighRisk?: FlowFragment;
  onLowRisk?: FlowFragment;
  onInconclusive?: FlowFragment;
  onError?: OutcomeHandler;
}

/**
 * Each check reports a different set of results, so each gets its own handler names — asking for
 * `onHighRisk` on an enrollment check is a compile error.
 */
export type CheckVoiceIdOptions =
  | EnrollmentStatusOptions
  | VoiceAuthenticationOptions
  | FraudDetectionOptions;

/**
 * Result strings Connect matches with `Equals`.
 *
 * The reference spells these as display labels — "Not enrolled", "High risk" — which the service
 * rejects. The wire values have no spaces.
 */
const VOICE_ID_RESULTS = {
  enrolled: "Enrolled",
  notEnrolled: "NotEnrolled",
  optedOut: "OptedOut",
  authenticated: "Authenticated",
  notAuthenticated: "NotAuthenticated",
  inconclusive: "Inconclusive",
  highRisk: "HighRisk",
  lowRisk: "LowRisk",
} as const;

function branch(operand: string, handler: FlowFragment | undefined): ResultBranch {
  return { operands: [operand], ...(handler === undefined ? {} : { handler }) };
}

/**
 * Branches on what Voice ID concluded about the caller.
 *
 * ```ts
 * checkVoiceId({
 *   check: "voiceAuthentication",
 *   onAuthenticated: () => transferToQueue(),
 *   onNotAuthenticated: escalateToAgent,
 *   onInconclusive: () => play("I couldn't verify that. Let me get someone."),
 * });
 * ```
 *
 * Streaming has to be running first — see {@link startVoiceIdStream} or the VoiceID flags on
 * `setContactData`.
 */
export function checkVoiceId(options: CheckVoiceIdOptions): void {
  const r = VOICE_ID_RESULTS;
  const conditions: ResultBranch[] =
    options.check === "enrollmentStatus"
      ? [
          branch(r.enrolled, options.onEnrolled),
          branch(r.notEnrolled, options.onNotEnrolled),
          branch(r.optedOut, options.onOptedOut),
        ]
      : options.check === "voiceAuthentication"
        ? [
            branch(r.authenticated, options.onAuthenticated),
            branch(r.notAuthenticated, options.onNotAuthenticated),
            branch(r.inconclusive, options.onInconclusive),
            branch(r.notEnrolled, options.onNotEnrolled),
            branch(r.optedOut, options.onOptedOut),
          ]
        : [
            branch(r.highRisk, options.onHighRisk),
            branch(r.lowRisk, options.onLowRisk),
            branch(r.inconclusive, options.onInconclusive),
          ];

  recordAction({
    type: "CheckVoiceId",
    hint: `check-${options.check}`,
    parameters: { CheckVoiceIdOption: options.check },
    conditions,
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

/**
 * Starts sending the caller's audio to Voice ID.
 *
 * Takes no parameters: what to do with the audio comes from the contact's Voice ID settings.
 */
export function startVoiceIdStream(options: { onError?: OutcomeHandler } = {}): void {
  recordAction({
    type: "StartVoiceIdStream",
    hint: "start-voiceid-stream",
    parameters: {},
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}
