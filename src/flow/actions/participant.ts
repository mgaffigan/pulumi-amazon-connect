/**
 * Participant actions: things the caller or chat user experiences.
 *
 * These only run when the flow has a participant, which is why they are unavailable in flow types
 * like "no participants remaining" disconnect flows.
 */

import type { ActionNode, Block } from "../recorder.js";
import { currentRecorder, type FlowFragment } from "../recorder.js";
import { type Ref, renderValue, STORED_INPUT, volatileRef } from "../refs.js";
import { NO_MATCHING_CONDITION, NO_MATCHING_ERROR } from "../types.js";
import { compact, type OutcomeHandler, recordAction, type Text } from "./action.js";

/** External audio, fetched from S3 rather than synthesized. */
export interface MediaSource {
  uri: Text;
  sourceType: "S3";
  mediaType: "Audio";
}

export interface PlayOptions {
  /** Plain text, spoken via text-to-speech on voice and sent as-is on other channels. */
  text?: Text;
  /** SSML markup. Voice channel only. Mutually exclusive with `text` and `promptId`. */
  ssml?: Text;
  /** A prompt ID or ARN from the instance's prompt library. Voice channel only. */
  promptId?: Text;
  media?: MediaSource;
  /**
   * When false, plays the prompt even if the caller has already typed ahead.
   *
   * Console exports always carry this; the flow-language reference does not mention it. Omitted by
   * default, which leaves Connect's own default in place.
   */
  skipWhenDtmfBuffered?: boolean;
  /** Handles this action's generic error vertex, overriding any enclosing `onError`. */
  onError?: OutcomeHandler;
}

function assertOneMessageSource(options: PlayOptions, action: string): void {
  const provided = (["text", "ssml", "promptId", "media"] as const).filter(
    (k) => options[k] !== undefined,
  );
  if (provided.length !== 1) {
    throw new Error(
      `${action} requires exactly one of text, ssml, promptId, or media; received ` +
        `${provided.length === 0 ? "none" : provided.join(" and ")}.`,
    );
  }
}

function messageParameters(options: PlayOptions): Record<string, unknown> {
  return {
    Text: options.text === undefined ? undefined : renderValue(options.text),
    SSML: options.ssml === undefined ? undefined : renderValue(options.ssml),
    PromptId: options.promptId === undefined ? undefined : renderValue(options.promptId),
    Media:
      options.media === undefined
        ? undefined
        : {
            Uri: renderValue(options.media.uri),
            SourceType: options.media.sourceType,
            MediaType: options.media.mediaType,
          },
  };
}

/**
 * Plays a prompt or sends a message.
 *
 * ```ts
 * play({ text: `Thanks for calling, ${customerName}.` });
 * play("Please hold.");
 * ```
 */
export function play(options: PlayOptions | string): void {
  const resolved: PlayOptions = typeof options === "string" ? { text: options } : options;
  assertOneMessageSource(resolved, "play");

  recordAction({
    type: "MessageParticipant",
    hint: "play",
    parameters: compact({
      ...messageParameters(resolved),
      SkipWhenDTMFBufferEnabled:
        resolved.skipWhenDtmfBuffered === undefined
          ? undefined
          : String(resolved.skipWhenDtmfBuffered),
    }),
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: resolved.onError },
  });
}

/** Ends the contact and stops the flow. Terminal. */
export function disconnect(): void {
  recordAction({
    type: "DisconnectParticipant",
    hint: "disconnect",
    parameters: {},
    terminal: true,
  });
}

/**
 * Ends the flow without disconnecting the participant.
 *
 * Only valid in whisper and customer queue flows; elsewhere Connect rejects it at publish time.
 */
export function endFlow(): void {
  recordAction({
    type: "EndFlowExecution",
    hint: "end-flow",
    parameters: {},
    terminal: true,
  });
}

/** One message in an iterative sequence. Exactly one source per entry. */
export type IterativeMessage =
  | { text: Text }
  | { ssml: Text }
  | { promptId: Text }
  | { media: MediaSource };

export interface PlayIterativelyOptions {
  /** Played in order, then repeated. */
  messages: IterativeMessage[];
  /** How often the sequence restarts. */
  interruptFrequencySeconds?: number | Ref<number>;
  /** Keeps talking through an interruption instead of stopping. */
  continueMessagingDuringInterrupt?: boolean;
  /** Runs when something interrupts the sequence — an agent answering, typically. */
  onInterrupted?: OutcomeHandler;
  onError?: OutcomeHandler;
}

/**
 * Plays a sequence of messages on a loop, the way hold and queue flows do.
 *
 * ```ts
 * playIteratively({
 *   messages: [{ ssml: '<speak>You are on hold <break time="30s"/></speak>' }],
 *   interruptFrequencySeconds: 60,
 * });
 * ```
 *
 * The looping is Connect's, not a `flowLoop` — one action repeats until the contact moves on, so it
 * costs one action rather than a loop's worth.
 */
export function playIteratively(options: PlayIterativelyOptions): void {
  if (options.messages.length === 0) {
    throw new Error("playIteratively requires at least one message.");
  }

  const messages = options.messages.map((message) => {
    const rendered = messageParameters(message as PlayOptions);
    return compact(rendered);
  });

  recordAction({
    type: "MessageParticipantIteratively",
    hint: "play-iteratively",
    parameters: compact({
      Messages: messages,
      InterruptFrequencySeconds:
        options.interruptFrequencySeconds === undefined
          ? undefined
          : renderValue(options.interruptFrequencySeconds),
      ContinueMessagingDuringInterrupt:
        options.continueMessagingDuringInterrupt === undefined
          ? undefined
          : String(options.continueMessagingDuringInterrupt),
    }),
    conditions: [
      {
        operands: ["MessagesInterrupted"],
        ...(options.onInterrupted === undefined ? {} : { handler: options.onInterrupted }),
      },
    ],
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

export interface LexBot {
  name: string | Ref<string>;
  /** The bot's AWS region, which need not match the instance's. */
  region: string;
  /** Bot alias, e.g. `$LATEST` or a published alias. */
  alias: string;
}

export interface LexOptions extends Omit<PlayOptions, "onError"> {
  bot: LexBot;
  /**
   * Session attributes handed to the bot, which its own logic can read.
   *
   * Accepted by the service but absent from the flow-language reference.
   */
  sessionAttributes?: Record<string, string | Ref<unknown>>;
  /**
   * One handler per intent the bot can return.
   *
   * The keys are intent names as configured in Lex; Connect matches them with `Equals` on the
   * action's result.
   */
  on: Record<string, FlowFragment>;
  /** Runs when the bot returned an intent none of the handlers cover. */
  onNoMatch?: OutcomeHandler;
  onError?: OutcomeHandler;
}

/**
 * Hands the participant to a Lex bot and branches on the intent it returns.
 *
 * ```ts
 * connectToLexBot({
 *   text: "How can I help?",
 *   bot: { name: "MainMenuBot", region: "us-east-1", alias: "$LATEST" },
 *   on: { Billing: toBilling, Pharmacy: toPharmacy, Disconnect: () => disconnect() },
 * });
 * ```
 */
export function connectToLexBot(options: LexOptions): void {
  assertOneMessageSource(options, "connectToLexBot");

  const intents = Object.entries(options.on);
  if (intents.length === 0) {
    throw new Error("connectToLexBot requires at least one intent handler in `on`.");
  }

  recordAction({
    type: "ConnectParticipantWithLexBot",
    hint: "lex-bot",
    parameters: compact({
      ...messageParameters(options),
      LexBot: {
        Name: renderValue(options.bot.name),
        Region: options.bot.region,
        Alias: options.bot.alias,
      },
      LexSessionAttributes:
        options.sessionAttributes === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(options.sessionAttributes).map(([k, v]) => [k, renderValue(v)]),
            ),
    }),
    conditions: intents.map(([intent, handler]) => ({ operands: [intent], handler })),
    requiredErrors: [NO_MATCHING_ERROR, NO_MATCHING_CONDITION],
    outcomes: {
      [NO_MATCHING_ERROR]: options.onError,
      [NO_MATCHING_CONDITION]: options.onNoMatch,
    },
  });
}

export interface DtmfOptions extends PlayOptions {
  /**
   * How long to wait for input. On voice this is the timeout until the *first* digit.
   * Must be a static positive integer.
   */
  timeoutSeconds: number;
  /**
   * One handler per accepted key. Connect only permits `Equals` against a single character here,
   * so keys are restricted to the digits, `*`, and `#`.
   */
  options: Partial<Record<DtmfKey, FlowFragment>>;
  /** Runs when the caller entered something that matched no key. */
  onNoMatch?: OutcomeHandler;
  /** Runs when nothing was entered in time. */
  onTimeout?: OutcomeHandler;
  dtmf?: DtmfConfiguration;
}

export type DtmfKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "*" | "#";

export interface DtmfConfiguration {
  /** Up to five digits that end input early. */
  inputTerminationSequence?: string;
  /** When true, `*` no longer cancels input. */
  disableCancelKey?: boolean;
  /** Seconds allowed between digits after the first. 1-20. */
  interdigitTimeoutSeconds?: number | Ref<number>;
}

function dtmfParameters(dtmf: DtmfConfiguration | undefined): Record<string, unknown> | undefined {
  if (dtmf === undefined) return undefined;
  return compact({
    InputTerminationSequence: dtmf.inputTerminationSequence,
    DisableCancelKey:
      dtmf.disableCancelKey === undefined ? undefined : String(dtmf.disableCancelKey),
    InterdigitTimeLimitSeconds:
      dtmf.interdigitTimeoutSeconds === undefined
        ? undefined
        : renderValue(dtmf.interdigitTimeoutSeconds),
  });
}

/**
 * Plays a prompt and branches on a single key press.
 *
 * ```ts
 * getDigit({
 *   text: "Press 1 for sales, 2 for support.",
 *   timeoutSeconds: 5,
 *   options: { "1": toSales, "2": toSupport },
 *   onTimeout: () => play("Sorry, I didn't get that."),
 * });
 * ```
 *
 * This is `GetParticipantInput` in its branch-on-input mode. To capture and keep what the caller
 * entered instead, use {@link collectInput}.
 */
export function getDigit(options: DtmfOptions): void {
  assertOneMessageSource(options, "getDigit");
  const recorder = currentRecorder();

  const conditions: Array<{ condition: { Operator: "Equals"; Operands: string[] }; body: Block }> =
    [];
  for (const [key, handler] of Object.entries(options.options)) {
    if (handler === undefined) continue;
    conditions.push({
      condition: { Operator: "Equals", Operands: [key] },
      body: recorder.captureBlock(handler),
    });
  }
  if (conditions.length === 0) {
    throw new Error("getDigit requires at least one entry in `options`.");
  }

  const outcomes = new Map<string, Block>();
  if (options.onTimeout !== undefined) {
    outcomes.set("InputTimeLimitExceeded", recorder.captureBlock(options.onTimeout));
  }
  if (options.onNoMatch !== undefined) {
    outcomes.set(NO_MATCHING_CONDITION, recorder.captureBlock(options.onNoMatch));
  }
  if (options.onError !== undefined) {
    outcomes.set(NO_MATCHING_ERROR, recorder.captureBlock(options.onError));
  }

  const node: ActionNode = {
    kind: "action",
    type: "GetParticipantInput",
    parameters: compact({
      ...messageParameters(options),
      InputTimeLimitSeconds: String(options.timeoutSeconds),
      StoreInput: "False",
      DTMFConfiguration: dtmfParameters(options.dtmf),
    }),
    path: recorder.allocatePath("get-digit"),
    scope: recorder.currentScope,
    terminal: false,
    conditions,
    outcomes,
    requiredErrors: [NO_MATCHING_ERROR, NO_MATCHING_CONDITION, "InputTimeLimitExceeded"],
    errorScope: recorder.currentErrorScope,
    inErrorHandler: recorder.insideErrorHandler,
  };
  recorder.append(node);
}

/**
 * Public key for encrypting what the participant entered, so a card or account number never reaches
 * a contact attribute in the clear.
 *
 * Connect permits this only alongside `maxLength` validation, not phone-number validation.
 */
export interface InputEncryption {
  /** Id of a key uploaded to the instance's encryption settings. */
  keyId: string | Ref<string>;
  /** The PEM-encoded public key, signed by the key identified above. */
  publicKey: string | Ref<string>;
}

export interface CollectInputOptions extends PlayOptions {
  timeoutSeconds: number;
  /** Caps the number of characters accepted. Mutually exclusive with `phoneNumber`. */
  maxLength?: number | Ref<number>;
  /**
   * Encrypts the entry with a public key.
   *
   * Requires `maxLength`: Connect rejects encryption combined with phone-number validation. Pair it
   * with `setRecordingBehavior({ participants: [] })` and `setLogging("Disabled")` around the step so
   * the digits stay out of recordings and logs too.
   */
  encryption?: InputEncryption;
  /** Validates the entry as a phone number. Mutually exclusive with `maxLength`. */
  phoneNumber?: { format: "E164" } | { format: "Local"; countryCode: string };
  /**
   * Only reachable when `phoneNumber` validation is in use.
   *
   * There is deliberately no `onTimeout` here. The AWS reference lists `InputTimeLimitExceeded` for
   * this action, but Connect rejects a store-mode `GetParticipantInput` that declares it — a timeout
   * while storing input goes to the error vertex like any other failure.
   */
  onInvalidPhoneNumber?: OutcomeHandler;
  dtmf?: DtmfConfiguration;
}

/**
 * Collects and stores what the participant entered, returning a ref to it.
 *
 * ```ts
 * const account = collectInput({ text: "Enter your account number.", timeoutSeconds: 10, maxLength: 8 });
 * ```
 *
 * This is `GetParticipantInput` in its store mode, which is mutually exclusive with the branching
 * mode of {@link getDigit}: Connect supports conditions in one and validation in the other, never
 * both on the same action.
 */
export function collectInput(options: CollectInputOptions): Ref<string> {
  assertOneMessageSource(options, "collectInput");
  if ((options.maxLength === undefined) === (options.phoneNumber === undefined)) {
    throw new Error("collectInput requires exactly one of maxLength or phoneNumber.");
  }
  if (options.encryption !== undefined && options.maxLength === undefined) {
    // Connect only accepts encryption alongside CustomValidation.
    throw new Error("collectInput encryption requires maxLength, not phoneNumber validation.");
  }

  const validation =
    options.phoneNumber !== undefined
      ? {
          PhoneNumberValidation: compact({
            NumberFormat: options.phoneNumber.format,
            CountryCode:
              options.phoneNumber.format === "Local" ? options.phoneNumber.countryCode : undefined,
          }),
        }
      : { CustomValidation: { MaximumLength: renderValue(options.maxLength ?? 0) } };

  // Rendered before the slot changes hands, so a prompt that reads back the last collection is the
  // ordinary "you entered X, try again" and not a stale read.
  const parameters = compact({
    ...messageParameters(options),
    InputTimeLimitSeconds: String(options.timeoutSeconds),
    StoreInput: "True",
    InputValidation: validation,
    InputEncryption:
      options.encryption === undefined
        ? undefined
        : {
            EncryptionKeyId: renderValue(options.encryption.keyId),
            Key: renderValue(options.encryption.publicKey),
          },
    DTMFConfiguration: dtmfParameters(options.dtmf),
  });

  // Claimed before the action is recorded, so its own error handler cannot read the last collection
  // either — the flow reached the handler because this one did not complete.
  const tenancy = currentRecorder().fill(STORED_INPUT, "collectInput");

  recordAction({
    type: "GetParticipantInput",
    hint: "collect-input",
    parameters,
    // Store mode declares no InputTimeLimitExceeded: Connect rejects the action if it does, despite
    // the reference listing it.
    requiredErrors: [
      NO_MATCHING_ERROR,
      ...(options.phoneNumber !== undefined ? ["InvalidPhoneNumber"] : []),
    ],
    outcomes: {
      [NO_MATCHING_ERROR]: options.onError,
      InvalidPhoneNumber: options.onInvalidPhoneNumber,
    },
  });

  // Connect overwrites this on each collection, so reading it after the next one is an error.
  return volatileRef<string>("$.StoredCustomerInput", tenancy);
}
