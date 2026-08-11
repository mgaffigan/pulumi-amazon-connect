/**
 * Actions that change something about the contact itself: which flows handle its events, whether it
 * is recorded, how it is routed, and callbacks.
 */

import { type Ref, type ResourceRef, renderResource, renderValue } from "../refs.js";
import { NO_MATCHING_ERROR } from "../types.js";
import { compact, type OutcomeHandler, recordAction } from "./action.js";
import type { AttributeValue } from "./attributes.js";

/**
 * Contact events a flow can be attached to.
 *
 * @see https://docs.aws.amazon.com/connect/latest/devguide/contact-actions-updatecontacteventhooks.html
 */
export type ContactEvent =
  | "AgentHold"
  | "AgentWhisper"
  | "CustomerHold"
  | "CustomerQueue"
  | "CustomerRemaining"
  | "CustomerWhisper"
  | "DefaultAgentUI"
  | "DisconnectAgentUI"
  | "PauseContact"
  | "ResumeContact";

/**
 * Attaches a flow to one contact event — the hold flow, the customer queue flow, and so on.
 *
 * ```ts
 * setEventFlow("CustomerQueue", queueFlow.arn);
 * ```
 *
 * One event per call: Connect permits only a single entry in the `EventHooks` map, so setting several
 * means several calls (and several actions against the 250 budget).
 */
export function setEventFlow(
  event: ContactEvent,
  flowId: ResourceRef,
  options: { onError?: OutcomeHandler } = {},
): void {
  recordAction({
    type: "UpdateContactEventHooks",
    hint: `set-${event.toLowerCase()}-flow`,
    parameters: { EventHooks: { [event]: renderResource(flowId) } },
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

/** Who gets recorded. An empty list turns recording off. */
export type RecordedParticipant = "Agent" | "Customer";

/**
 * Contact Lens configuration as this action shapes it.
 *
 * Deliberately distinct from {@link AnalyticsOptions}: the same settings take a different wire shape
 * here — modes nested under `ChannelConfiguration` per channel — than they do on
 * `UpdateContactRecordingAndAnalyticsBehavior`.
 */
export interface RecordingAnalyticsOptions {
  /** e.g. `en-US`. */
  language: string;
  voiceModes?: VoiceAnalyticsMode[];
  chatModes?: ChatAnalyticsMode[];
  summaryModes?: Array<"PostContact" | "AutomatedInteraction">;
  sentiment?: boolean;
  /** Redacts sensitive data, keeping both the redacted and original transcripts. */
  redaction?: boolean;
}

export interface RecordingOptions {
  /** Pass an empty array to stop recording. */
  participants: RecordedParticipant[];
  /** Records the IVR portion of a voice contact, not just the agent conversation. */
  ivrRecording?: "Enabled" | "Disabled";
  /**
   * Contact Lens analytics, set by the same action.
   *
   * Production flows carry this on `UpdateContactRecordingBehavior`, which the reference documents as
   * taking only `RecordingBehavior`. {@link setRecordingAndAnalytics} is the newer action with a
   * different shape; this is the one the console's recording block emits.
   */
  analytics?: RecordingAnalyticsOptions;
}

/**
 * Turns call recording on or off, and optionally records the IVR portion too.
 *
 * ```ts
 * setRecordingBehavior({ participants: [] });                        // stop recording
 * setRecordingBehavior({ participants: ["Agent", "Customer"] });     // record both sides
 * ```
 *
 * Disabling around a step that collects card or health details is the usual reason to reach for this.
 */
export function setRecordingBehavior(options: RecordingOptions): void {
  recordAction({
    type: "UpdateContactRecordingBehavior",
    hint: "set-recording",
    parameters: compact({
      RecordingBehavior: compact({
        RecordedParticipants: options.participants,
        IVRRecordingBehavior: options.ivrRecording,
      }),
      AnalyticsBehavior:
        options.analytics === undefined
          ? undefined
          : compact({
              Enabled: "True",
              AnalyticsLanguage: options.analytics.language,
              AnalyticsRedactionBehavior: options.analytics.redaction ? "Enabled" : "Disabled",
              AnalyticsRedactionResults: options.analytics.redaction
                ? "RedactedAndOriginal"
                : undefined,
              ChannelConfiguration: compact({
                Voice:
                  options.analytics.voiceModes === undefined
                    ? undefined
                    : { AnalyticsModes: options.analytics.voiceModes },
                Chat:
                  options.analytics.chatModes === undefined
                    ? undefined
                    : { AnalyticsModes: options.analytics.chatModes },
              }),
              SummaryConfiguration:
                options.analytics.summaryModes === undefined
                  ? undefined
                  : { SummaryModes: options.analytics.summaryModes },
              SentimentConfiguration:
                options.analytics.sentiment === undefined
                  ? undefined
                  : { Enabled: options.analytics.sentiment ? "True" : "False" },
            }),
    }),
    // This action documents and emits no errors.
    requiredErrors: [],
  });
}

/** Contact Lens analytics modes, which differ per channel. */
export type VoiceAnalyticsMode = "RealTime" | "PostContact" | "AutomatedInteraction";
export type ChatAnalyticsMode = "ContactLens";

export interface AnalyticsOptions {
  /** e.g. `en-US`. */
  language: string;
  modes: VoiceAnalyticsMode[] | ChatAnalyticsMode[];
  /** Adds a post-contact or automated-interaction summary. */
  summaryModes?: Array<"PostContact" | "AutomatedInteraction">;
  sentiment?: boolean;
  /** Redacts sensitive data from transcripts. */
  redaction?: boolean;
}

export interface RecordingAndAnalyticsOptions {
  channel: "voice" | "chat";
  /** Voice only; chat has no recording, just analytics. */
  recording?: RecordingOptions;
  analytics?: AnalyticsOptions;
  onError?: OutcomeHandler;
}

/**
 * Sets recording and Contact Lens analytics together.
 *
 * Voice and chat take different shapes on the wire — `VoiceBehavior` versus `ChatBehavior`, and only
 * voice has a recording section — so the channel is an explicit parameter rather than inferred.
 *
 * For recording alone, {@link setRecordingBehavior} is the smaller action.
 */
export function setRecordingAndAnalytics(options: RecordingAndAnalyticsOptions): void {
  const analytics =
    options.analytics === undefined
      ? undefined
      : compact({
          Enabled: "True",
          AnalyticsLanguage: options.analytics.language,
          AnalyticsModes: options.analytics.modes,
          ConversationalAnalyticsRedactionConfiguration: {
            Enabled: options.analytics.redaction === true ? "True" : "False",
          },
          SentimentConfiguration:
            options.analytics.sentiment === undefined
              ? undefined
              : { Enabled: options.analytics.sentiment ? "True" : "False" },
          SummaryConfiguration:
            options.analytics.summaryModes === undefined
              ? undefined
              : { SummaryModes: options.analytics.summaryModes },
        });

  const behavior =
    options.channel === "voice"
      ? {
          VoiceBehavior: compact({
            VoiceRecordingBehavior:
              options.recording === undefined
                ? undefined
                : compact({
                    RecordedParticipants: options.recording.participants,
                    IVRRecordingBehavior: options.recording.ivrRecording,
                  }),
            VoiceAnalyticsBehavior: analytics,
          }),
        }
      : { ChatBehavior: compact({ ChatAnalyticsBehavior: analytics }) };

  recordAction({
    type: "UpdateContactRecordingAndAnalyticsBehavior",
    hint: `set-${options.channel}-recording-analytics`,
    parameters: behavior,
    requiredErrors: [
      NO_MATCHING_ERROR,
      "ChannelMismatch",
      // In-flight redaction exists only for chat, and Connect rejects the error on a voice action.
      ...(options.channel === "chat" ? ["InFlightRedactionConfigurationFailed"] : []),
    ],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

export interface RoutingBehaviorOptions {
  /** Lower numbers are served first. */
  queuePriority?: number | Ref<number>;
  /**
   * Shifts the contact's apparent time in queue, in seconds.
   *
   * A positive value makes it look like it has waited longer, so it is served sooner.
   */
  queueTimeAdjustmentSeconds?: number | Ref<number>;
}

/**
 * Changes where the contact sits in its queue.
 *
 * Exactly one of the two adjustments per call: Connect's own block sets one at a time, and the real
 * flows checked only ever carry one key.
 */
export function setRoutingBehavior(options: RoutingBehaviorOptions): void {
  const provided = [options.queuePriority, options.queueTimeAdjustmentSeconds].filter(
    (v) => v !== undefined,
  );
  if (provided.length !== 1) {
    throw new Error(
      "setRoutingBehavior requires exactly one of queuePriority or queueTimeAdjustmentSeconds.",
    );
  }

  recordAction({
    type: "UpdateContactRoutingBehavior",
    hint: "set-routing",
    parameters: compact({
      QueuePriority:
        options.queuePriority === undefined ? undefined : renderValue(options.queuePriority),
      QueueTimeAdjustmentSeconds:
        options.queueTimeAdjustmentSeconds === undefined
          ? undefined
          : renderValue(options.queueTimeAdjustmentSeconds),
    }),
    // No errors observed on this action in any real flow.
    requiredErrors: [],
  });
}

export interface CallbackNumberOptions {
  /** Runs when the number is not a valid phone number. */
  onInvalid?: OutcomeHandler;
  /** Runs when the number is valid but the instance cannot dial it. */
  onNotDialable?: OutcomeHandler;
}

/**
 * Sets the number a callback will dial.
 *
 * ```ts
 * const entered = collectInput({ text: "Number to call back?", timeoutSeconds: 10, phoneNumber: { format: "Local", countryCode: "US" } });
 * setCallbackNumber(entered);
 * ```
 *
 * Note this action declares no generic error vertex — only the two specific failures.
 */
export function setCallbackNumber(
  number: string | Ref<string>,
  options: CallbackNumberOptions = {},
): void {
  recordAction({
    type: "UpdateContactCallbackNumber",
    hint: "set-callback-number",
    parameters: { CallbackNumber: renderValue(number) },
    requiredErrors: ["InvalidCallbackNumber", "CallbackNumberNotDialable"],
    outcomes: {
      InvalidCallbackNumber: options.onInvalid,
      CallbackNumberNotDialable: options.onNotDialable,
    },
  });
}

export interface CallbackContactOptions {
  /** Wait before the first attempt. */
  initialDelaySeconds: number | Ref<number>;
  /** Wait between attempts. */
  retryDelaySeconds: number | Ref<number>;
  maximumAttempts: number | Ref<number>;
  onError?: OutcomeHandler;
}

/**
 * Queues a callback to the contact's callback number.
 *
 * Set the number first with {@link setCallbackNumber}; this action only schedules the attempt.
 */
export function createCallbackContact(options: CallbackContactOptions): void {
  recordAction({
    type: "CreateCallbackContact",
    hint: "create-callback",
    parameters: {
      InitialCallDelaySeconds: renderValue(options.initialDelaySeconds),
      RetryDelaySeconds: renderValue(options.retryDelaySeconds),
      MaximumConnectionAttempts: renderValue(options.maximumAttempts),
    },
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

/**
 * Puts the previous contact's agent or customer on hold, or takes them off it.
 *
 * Used in transfer flows to stop the transferring agent from overhearing what follows — securely
 * collecting a card number, for instance. Voice contacts only, and only in inbound and transfer
 * flows.
 */
export function setPreviousParticipantState(
  state: "AgentOnHold" | "CustomerOnHold" | "OffHold",
  options: { onError?: OutcomeHandler } = {},
): void {
  recordAction({
    type: "UpdatePreviousContactParticipantState",
    hint: "set-previous-participant-state",
    parameters: { PreviousContactParticipantState: state },
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

/**
 * Amazon Polly engines.
 *
 * The flow-language reference names the parameter but not its values; these are Polly's own engine
 * names, and Connect accepts them as-is.
 */
export type TextToSpeechEngine = "standard" | "neural" | "long-form" | "generative";

/** Polly speech styles. Not every voice or engine supports every style. */
export type TextToSpeechStyle = "None" | "Conversational" | "Newscaster";

export interface VoiceOptions {
  /** A Polly voice name, e.g. `Joanna`. Connect defaults to Joanna if this action never runs. */
  voice: string | Ref<string>;
  engine?: TextToSpeechEngine | Ref<string>;
  style?: TextToSpeechStyle | Ref<string>;
  onError?: OutcomeHandler;
}

/**
 * Sets the Polly voice used for text-to-speech and Lex bots for the rest of the contact.
 *
 * ```ts
 * setVoice({ voice: "Danielle", engine: "neural", style: "Conversational" });
 * ```
 *
 * An invalid voice, or a voice that does not support the chosen engine, breaks text-to-speech for the
 * whole contact rather than failing loudly, so it is worth confirming the combination in Polly first.
 */
export function setVoice(options: VoiceOptions): void {
  recordAction({
    type: "UpdateContactTextToSpeechVoice",
    hint: "set-voice",
    parameters: compact({
      TextToSpeechVoice: renderValue(options.voice),
      TextToSpeechEngine: options.engine === undefined ? undefined : renderValue(options.engine),
      TextToSpeechStyle: options.style === undefined ? undefined : renderValue(options.style),
    }),
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

/**
 * Adds user-defined tags to the contact, for reporting and access control.
 *
 * ```ts
 * tagContact({ campaign: "spring-2026", tier: attr("tier") });
 * ```
 *
 * Tags apply atomically — all or none. System tags (the `aws:` prefix) cannot be set.
 */
export function tagContact(
  tags: Record<string, AttributeValue>,
  options: { onError?: OutcomeHandler } = {},
): void {
  const entries = Object.entries(tags);
  if (entries.length === 0) {
    throw new Error("tagContact requires at least one tag.");
  }

  recordAction({
    type: "TagContact",
    hint: "tag-contact",
    parameters: {
      Tags: Object.fromEntries(entries.map(([k, v]) => [k, renderValue(v)])),
    },
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

/**
 * Removes user-defined tags from the contact.
 *
 * Keys must be literals: unlike {@link tagContact}, Connect does not resolve references here.
 * System tags cannot be removed.
 *
 * The action type is `UntagContact` with a lower-case `t`. Both the title and the body of the AWS
 * reference page spell it `UnTagContact`, which the service rejects as an unknown action type.
 */
export function untagContact(keys: string[], options: { onError?: OutcomeHandler } = {}): void {
  if (keys.length === 0) {
    throw new Error("untagContact requires at least one tag key.");
  }

  recordAction({
    type: "UntagContact",
    hint: "untag-contact",
    parameters: { TagKeys: keys },
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

/** Which side of the customer's audio to stream. */
export type MediaDirection = "From" | "To";

export interface MediaStreamingOptions {
  /** Defaults to both directions. */
  directions?: MediaDirection[];
  onError?: OutcomeHandler;
}

/**
 * Starts streaming the customer's audio to Kinesis Video Streams.
 *
 * Voice channel only, and the instance needs media streaming configured. Only the customer
 * participant and audio are supported, which is why neither is a parameter.
 */
export function startMediaStreaming(options: MediaStreamingOptions = {}): void {
  mediaStreaming("Enabled", options);
}

/** Stops streaming the customer's audio. */
export function stopMediaStreaming(options: MediaStreamingOptions = {}): void {
  mediaStreaming("Disabled", options);
}

function mediaStreaming(state: "Enabled" | "Disabled", options: MediaStreamingOptions): void {
  recordAction({
    type: "UpdateContactMediaStreamingBehavior",
    hint: state === "Enabled" ? "start-media-streaming" : "stop-media-streaming",
    parameters: {
      MediaStreamingState: state,
      Participants: [
        {
          ParticipantType: "Customer",
          MediaDirections: options.directions ?? ["From", "To"],
        },
      ],
      MediaStreamType: "Audio",
    },
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

/**
 * Associates an Amazon Q in Connect (formerly Wisdom) assistant with the contact, so the agent gets
 * real-time recommendations.
 *
 * Voice channel only.
 */
export function createWisdomSession(
  assistantArn: ResourceRef,
  options: { onError?: OutcomeHandler } = {},
): void {
  recordAction({
    type: "CreateWisdomSession",
    hint: "create-wisdom-session",
    parameters: { WisdomAssistantArn: renderResource(assistantArn) },
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

/** Resumes a contact that was paused, the counterpart to the `PauseContact` event hook. */
export function resumeContact(options: { onError?: OutcomeHandler } = {}): void {
  recordAction({
    type: "ResumeContact",
    hint: "resume-contact",
    parameters: {},
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

/**
 * Voice ID settings, which Connect accepts only as a complete set.
 *
 * Turning it on requires all three switches *and* all three thresholds; turning it off requires the
 * three switches and rejects the thresholds. Those are the two combinations the service accepts, so
 * they are the two this union offers.
 */
export type VoiceIdSettings =
  | { enabled: false }
  | {
      enabled: true;
      /** Confidence score a voice match must beat, 0-100. */
      authenticationThreshold: number | Ref<number>;
      /** Minimum seconds of caller speech before authenticating, 5-10. */
      authenticationResponseTime: number | Ref<number>;
      /** Risk score above which fraud is reported, 0-100. */
      fraudThreshold: number | Ref<number>;
      /** Watchlist to evaluate the session against. Validated against real watchlists. */
      watchlistId?: ResourceRef;
    };

export interface ContactDataOptions {
  /** Sets the contact's name, as it appears in the agent workspace and contact records. */
  name?: string | Ref<string>;
  description?: string | Ref<string>;
  /** e.g. `en-US`. */
  languageCode?: string | Ref<string>;
  customerId?: string | Ref<string>;
  /** Voice ID streaming, authentication and fraud detection for this contact. */
  voiceId?: VoiceIdSettings;
  /** An Amazon Q in Connect session ARN. Validated against real sessions. */
  wisdomSessionArn?: ResourceRef;
  /** `Current` writes the running contact; `Related` the one it came from. Defaults to `Current`. */
  target?: "Current" | "Related";
  onError?: OutcomeHandler;
}

/** Connect's own boolean spelling for this action: upper case, unlike other actions' True/False. */
function upperBoolean(value: boolean | undefined): string | undefined {
  return value === undefined ? undefined : value ? "TRUE" : "FALSE";
}

/**
 * Sets Connect's own contact fields — name, description, language, references — and the Voice ID
 * switches for the contact.
 *
 * ```ts
 * setContactData({
 *   name: "Refill request",
 *   languageCode: "en-US",
 *   voiceId: { enabled: true, authenticationThreshold: 90, authenticationResponseTime: 7, fraudThreshold: 50 },
 * });
 * ```
 *
 * Distinct from {@link setAttributes}: those are your own key-value pairs, these are fields Connect
 * itself understands. Note the booleans here are `TRUE`/`FALSE`, not the `True`/`False` every other
 * action uses.
 *
 * At least one field is required; the action cannot be a no-op.
 *
 * The reference documents a `References` parameter for external references. That spelling, the
 * `Reference` the service names in its own error text, and the undocumented `SegmentAttribute` are
 * all rejected as unknown properties, so none is offered here.
 */
export function setContactData(options: ContactDataOptions): void {
  const voiceId = options.voiceId;
  const on = voiceId?.enabled === true ? voiceId : undefined;
  const hasField =
    options.name !== undefined ||
    options.description !== undefined ||
    options.languageCode !== undefined ||
    options.customerId !== undefined ||
    voiceId !== undefined ||
    options.wisdomSessionArn !== undefined;
  if (!hasField) {
    // The service requires at least one of these; an empty action is rejected.
    throw new Error("setContactData requires at least one field to set.");
  }

  recordAction({
    type: "UpdateContactData",
    hint: "set-contact-data",
    parameters: compact({
      Name: options.name === undefined ? undefined : renderValue(options.name),
      Description: options.description === undefined ? undefined : renderValue(options.description),
      LanguageCode:
        options.languageCode === undefined ? undefined : renderValue(options.languageCode),
      CustomerId: options.customerId === undefined ? undefined : renderValue(options.customerId),
      // All three switches move together: the service requires each one whenever any is present.
      IsVoiceIdStreamingEnabled: upperBoolean(voiceId?.enabled),
      IsVoiceAuthenticationEnabled: upperBoolean(voiceId?.enabled),
      IsFraudDetectionEnabled: upperBoolean(voiceId?.enabled),
      // Required when enabled, and rejected as unknown properties when not.
      VoiceAuthenticationThreshold:
        on === undefined ? undefined : renderValue(on.authenticationThreshold),
      VoiceAuthenticationResponseTime:
        on === undefined ? undefined : renderValue(on.authenticationResponseTime),
      FraudDetectionThreshold: on === undefined ? undefined : renderValue(on.fraudThreshold),
      WatchlistId: on?.watchlistId === undefined ? undefined : renderResource(on.watchlistId),
      WisdomSessionArn:
        options.wisdomSessionArn === undefined
          ? undefined
          : renderResource(options.wisdomSessionArn),
      TargetContact: options.target ?? "Current",
    }),
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

export interface MediaProcessingOptions {
  /** ARN of the Lambda that will see in-flight chat messages. */
  lambdaArn: ResourceRef;
  /** Defaults to true; pass false to turn processing off while keeping the configuration. */
  enabled?: boolean;
  /**
   * Whether a message that fails processing is still delivered. Defaults to false.
   *
   * Always emitted: Connect requires the enclosing `ChatProcessorSettings` object even though the
   * reference presents it as just another field.
   */
  deliverUnprocessedMessages?: boolean;
  /** Runs when the contact's channel is not chat. */
  onChannelMismatch?: OutcomeHandler;
  onError?: OutcomeHandler;
}

/**
 * Routes in-flight chat messages through a Lambda of your own.
 *
 * Chat only — the action takes its `ChannelMismatch` branch on any other channel.
 */
export function setMediaProcessing(options: MediaProcessingOptions): void {
  recordAction({
    type: "UpdateContactMediaProcessing",
    hint: "set-media-processing",
    parameters: {
      ChatProcessor: compact({
        ProcessingEnabled: options.enabled === false ? "False" : "True",
        LambdaProcessorARN: renderResource(options.lambdaArn),
        ChatProcessorSettings: {
          DeliverUnprocessedMessages:
            options.deliverUnprocessedMessages === true ? "True" : "False",
        },
      }),
    },
    requiredErrors: [NO_MATCHING_ERROR, "ChannelMismatch"],
    outcomes: {
      [NO_MATCHING_ERROR]: options.onError,
      ChannelMismatch: options.onChannelMismatch,
    },
  });
}

/** Proficiency levels Connect accepts on a routing condition. */
export type ProficiencyLevel = 1 | 2 | 3 | 4 | 5;

/** One predefined-attribute requirement, e.g. "Spanish at level 4 or better". */
export interface AttributeRequirement {
  /** A predefined attribute name configured on the instance. */
  name: string;
  value: string;
  /** Agents must meet or exceed this level. */
  minimumLevel: ProficiencyLevel;
}

export interface RoutingStep {
  /**
   * Requirements an agent must meet. Several are AND-ed together.
   *
   * There is no OR: express alternatives as separate steps, which Connect tries in order.
   */
  require: AttributeRequirement[];
  /**
   * How long to look for an agent meeting this step before moving to the next.
   *
   * Omit on the last step to let it stand until the contact is answered.
   */
  expiresAfterSeconds?: number;
}

/**
 * Sets routing steps, so a contact looks for the best-matched agent first and relaxes over time.
 *
 * ```ts
 * setRoutingCriteria({
 *   steps: [
 *     { require: [{ name: "Language", value: "Spanish", minimumLevel: 4 }], expiresAfterSeconds: 30 },
 *     { require: [{ name: "Language", value: "Spanish", minimumLevel: 2 }] },
 *   ],
 * });
 * ```
 *
 * When every step is exhausted the contact is offered to any agent in the queue.
 */
export function setRoutingCriteria(options: {
  steps: RoutingStep[];
  onError?: OutcomeHandler;
}): void {
  if (options.steps.length === 0) {
    throw new Error("setRoutingCriteria requires at least one step.");
  }

  const steps = options.steps.map((step) => {
    if (step.require.length === 0) {
      throw new Error("Each routing step requires at least one attribute requirement.");
    }
    const conditions = step.require.map((requirement) => ({
      AttributeCondition: {
        Name: requirement.name,
        Value: requirement.value,
        // Connect takes the level as a float, and the only supported operator is this one.
        ProficiencyLevel: requirement.minimumLevel.toFixed(1),
        ComparisonOperator: "NumberGreaterOrEqualTo",
      },
    }));

    return compact({
      // A single requirement still goes through AndExpression, which keeps the shape uniform.
      Expression: { AndExpression: conditions },
      Expiry:
        step.expiresAfterSeconds === undefined
          ? undefined
          : { DurationInSeconds: String(step.expiresAfterSeconds) },
    });
  });

  recordAction({
    // `UpdateContactRoutingCriteria`. The reference page is titled `UpdateRoutingCriteria`, which the
    // service rejects as an unknown action type.
    type: "UpdateContactRoutingCriteria",
    hint: "set-routing-criteria",
    parameters: { RoutingCriteria: { Steps: steps } },
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

export interface CreateTaskOptions {
  name: string | Ref<string>;
  /** The flow that will handle the task once created. */
  flowId: ResourceRef;
  description?: string | Ref<string>;
  /** Contact attributes to set on the new task. */
  attributes?: Record<string, AttributeValue>;
  onError?: OutcomeHandler;
}

/**
 * Creates a task contact, which lands in an agent's queue as work to do.
 *
 * ```ts
 * createTask({
 *   name: "Investigate billing dispute",
 *   flowId: taskFlow.arn,
 *   attributes: { customerPhone: system.customerEndpoint.address },
 * });
 * ```
 */
export function createTask(options: CreateTaskOptions): void {
  recordAction({
    type: "CreateTask",
    hint: "create-task",
    parameters: compact({
      Name: renderValue(options.name),
      ContactFlowId: renderResource(options.flowId),
      Description: options.description === undefined ? undefined : renderValue(options.description),
      Attributes:
        options.attributes === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(options.attributes).map(([k, v]) => [k, renderValue(v)]),
            ),
    }),
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}
