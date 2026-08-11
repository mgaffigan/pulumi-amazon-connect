import type * as pulumi from "@pulumi/pulumi";
import { activeRecorder, currentRecorder, type ResultSlot, type Tenancy } from "./recorder.js";

/**
 * References to values that only exist while a contact is running.
 *
 * A `Ref<T>` is a build-time handle on a runtime JSONPath such as `$.Attributes.tier`. The type
 * parameter carries what the value will be at runtime, which is what lets {@link flowIf} narrow its
 * operator set and reject a text operator on a numeric ref.
 */

declare const refBrand: unique symbol;

/**
 * A reference to a value resolved at contact runtime.
 *
 * Refs interpolate into template literals (`Hello ${tier}`) because Connect substitutes `$.…` paths
 * inline inside string parameters.
 */
export interface Ref<T = string> {
  readonly [refBrand]: T;
  /** The JSONPath this ref resolves to, e.g. `$.Attributes.tier`. */
  readonly path: string;
  toString(): string;
}

/** A value usable where Connect accepts either a literal or a `$.…` path. */
export type Dynamic<T> = T | Ref<T>;

/**
 * The call-site view of a record whose values are known only at contact runtime.
 *
 * A handler or a view template is written against real values, but a flow has none — only references
 * to values that will exist later. Each field therefore accepts a literal or a matching `Ref`.
 */
export type DynamicInput<In> = { [K in keyof In]: In[K] | Ref<In[K]> };

export function makeRef<T = string>(path: string): Ref<T> {
  return {
    path,
    toString() {
      return path;
    },
  } as Ref<T>;
}

/**
 * A reference into a slot that a later action overwrites, valid only until that happens.
 *
 * The check sits on `path` and `toString` because between them they are every way a ref is read: a
 * parameter through {@link renderValue}, a comparison, or interpolation into a template literal. So
 * there is no way to spend a stale reference that does not go through it.
 */
export function volatileRef<T = string>(path: string, tenancy: Tenancy | undefined): Ref<T> {
  if (tenancy === undefined) return makeRef<T>(path);
  return {
    get path() {
      tenancy.assertCurrent();
      return path;
    },
    toString() {
      tenancy.assertCurrent();
      return path;
    },
  } as Ref<T>;
}

/** `$.External`, refilled by every synchronous Lambda invocation. */
export const LAMBDA_RESULT: ResultSlot = {
  root: "$.External",
  filledBy: "Lambda invocation",
};

/**
 * `$.Views.ViewResultData`, refilled by every view shown.
 *
 * Covers `$.Views.Action` as well: one `ShowView` fills both, so they change hands together and the
 * diagnostic names the data path for either.
 */
export const VIEW_RESULT: ResultSlot = {
  root: "$.Views.ViewResultData",
  filledBy: "view",
};

/** `$.StoredCustomerInput`, refilled by every `collectInput`. */
export const STORED_INPUT: ResultSlot = {
  root: "$.StoredCustomerInput",
  filledBy: "collectInput",
};

/** `$.Modules.ResultData`, refilled by every flow module invoked. */
export const MODULE_RESULT: ResultSlot = {
  root: "$.Modules.ResultData",
  filledBy: "flow module",
};

/**
 * The tenancy to stamp on a reference into `slot`, or `undefined` where there is nothing to check —
 * no flow is recording, or nothing has filled the slot yet.
 */
function currentTenancy(slot: ResultSlot): Tenancy | undefined {
  return activeRecorder()?.occupant(slot);
}

export function isRef(value: unknown): value is Ref<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { path?: unknown }).path === "string" &&
    (value as { path: string }).path.startsWith("$.")
  );
}

/**
 * Renders a value into the string form Connect expects in a parameter field.
 *
 * Refs become their path (which Connect resolves), everything else becomes its string form —
 * including numbers and booleans, since flow parameters are string-typed on the wire.
 */
export function renderValue(value: string | number | boolean | Ref<unknown>): string {
  return isRef(value) ? value.path : String(value);
}

/**
 * Attribute keys become part of a JSONPath, so a key containing `.` or `$` would silently produce a
 * path that reads a different value than intended.
 */
export function assertValidAttributeKey(key: string): void {
  if (key.length === 0) {
    throw new Error("Attribute key must not be empty.");
  }
  if (/[.$[\]]/.test(key)) {
    throw new Error(
      `Attribute key ${JSON.stringify(key)} contains a character that is not valid in a JSONPath ` +
        "segment (. $ [ ]).",
    );
  }
}

/** A contact attribute: survives transfers between flows. Reads `$.Attributes.<key>`. */
export function attr<T = string>(key: string): Ref<T> {
  assertValidAttributeKey(key);
  return makeRef<T>(`$.Attributes.${key}`);
}

/** A flow attribute: scoped to the current flow, not carried to subsequent flows. */
export function flowAttr<T = string>(key: string): Ref<T> {
  assertValidAttributeKey(key);
  return makeRef<T>(`$.FlowAttributes.${key}`);
}

/**
 * A value returned by the most recent Lambda invocation.
 *
 * Prefer the typed refs returned by calling a {@link connectLambda} handle — this is the untyped
 * escape hatch for reading `$.External` directly.
 *
 * It reads the invocation in effect where it is written, and so goes stale with that invocation's own
 * references when the next Lambda runs.
 */
export function external<T = string>(key: string): Ref<T> {
  assertValidAttributeKey(key);
  return volatileRef<T>(`$.External.${key}`, currentTenancy(LAMBDA_RESULT));
}

/** Root of what the participant submitted in the most recent view. */
export const VIEW_RESULT_ROOT = "$.Views.ViewResultData";

/** The action the participant raised on the most recent view. */
export const VIEW_ACTION_PATH = "$.Views.Action";

/**
 * The key a view's result exposes {@link VIEW_ACTION_PATH} under.
 *
 * `$`-prefixed on purpose: {@link assertValidAttributeKey} forbids `$` in a path segment, so no
 * component can be named `$action` and this can never shadow a field of the view's own output.
 */
const VIEW_ACTION_KEY = "$action";

/**
 * A table the view rendered.
 *
 * Views report the row the user chose positionally, so a cell is reached by index rather than by
 * key.
 */
export interface ViewTable<Row> {
  at(index: number): ViewRefs<Row>;
}

/**
 * References into a view's submitted data, shaped like the view's own output type.
 *
 * Array-valued fields become {@link ViewTable}s; everything else becomes a `Ref`. Nested objects
 * keep drilling, since the underlying JSONPath does.
 */
export type ViewRefs<T> = {
  readonly [K in keyof T]: T[K] extends readonly (infer Row)[]
    ? ViewTable<Row>
    : T[K] extends object
      ? ViewRefs<T[K]>
      : Ref<T[K]>;
};

/**
 * What a view hands back: its submitted data, plus the action the participant raised.
 *
 * `$action` reads `$.Views.Action`, which sits beside `$.Views.ViewResultData` rather than inside it,
 * so it is not part of the output shape and does not come from the view's own template. The action is
 * *also* a branch — that is what the handlers on `show` are — and this is for carrying the choice
 * onward as a value instead of branching on it.
 */
export type ViewResult<T, A extends string = string> = ViewRefs<T> & {
  /** The action the participant raised, e.g. `Next`. Reads `$.Views.Action`. */
  readonly [VIEW_ACTION_KEY]: Ref<A>;
};

/**
 * Builds the reference tree for a view's result.
 *
 * A proxy rather than a fixed object, because the view's output type exists only at compile time —
 * there is no runtime list of fields to walk.
 */
export function viewRefs<T, A extends string = string>(
  root: string = VIEW_RESULT_ROOT,
): ViewResult<T, A> {
  const tenancy = currentTenancy(VIEW_RESULT);
  // Stamped with the same tenancy as the data: one `ShowView` fills both paths, and the next one
  // replaces both.
  return viewNode(root, tenancy, {
    [VIEW_ACTION_KEY]: volatileRef<A>(VIEW_ACTION_PATH, tenancy),
  }) as ViewResult<T, A>;
}

/** Root of the input object a flow module was invoked with. Readable only inside the module. */
export const MODULE_INPUT_ROOT = "$.Modules.Input";

/** Root of what the most recently invoked flow module returned. */
export const MODULE_RESULT_ROOT = "$.Modules.ResultData";

/**
 * References into a flow module's data, shaped like the module's declared type.
 *
 * The same tree {@link ViewRefs} builds — a module's input and output are plain JSON objects
 * reached by the same dotted paths.
 */
export type ModuleRefs<T> = ViewRefs<T>;

/**
 * References into what a flow module returned, read by its caller.
 *
 * Volatile in the same way a view's result is: `$.Modules.ResultData` is overwritten by the next
 * module invoked, so reading one module's output after invoking another is an error rather than a
 * value that is quietly wrong.
 */
export function moduleResultRefs<T>(): ModuleRefs<T> {
  return viewNode(MODULE_RESULT_ROOT, currentTenancy(MODULE_RESULT)) as ModuleRefs<T>;
}

/**
 * References into the input a flow module was invoked with, read inside the module.
 *
 * Not volatile: `$.Modules.Input` is fixed for the whole of one module's run, so there is no tenancy
 * to check. A module that invokes another module is the exception the service already forbids
 * reading across.
 */
export function moduleInputRefs<T>(): ModuleRefs<T> {
  return viewNode(MODULE_INPUT_ROOT, undefined) as ModuleRefs<T>;
}

/**
 * @param extras References that live beside this node rather than under it, such as
 * `$.Views.Action`. Passed only at the root, so a nested field of the same name still resolves as
 * part of the data.
 */
function viewNode(
  path: string,
  tenancy: Tenancy | undefined,
  extras?: Record<string, unknown>,
): unknown {
  const read = () => {
    tenancy?.assertCurrent();
    return path;
  };
  return new Proxy(makeRef(path) as object, {
    get(_target, property) {
      // A `then` property would make this object a thenable, so awaiting a result would call the
      // handler with (resolve, reject) instead of returning it.
      if (property === "then") return undefined;
      if (property === "path") return read();
      if (property === "toString" || property === Symbol.toPrimitive) return read;
      if (typeof property === "string" && extras !== undefined && property in extras) {
        return extras[property];
      }
      if (property === "at") {
        return (index: number) => viewNode(`${path}.${assertIndex(index)}`, tenancy);
      }
      if (typeof property !== "string") return undefined;
      assertValidAttributeKey(property);
      return viewNode(`${path}.${property}`, tenancy);
    },
  });
}

function assertIndex(index: number): number {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Table row index must be a non-negative integer, received ${index}.`);
  }
  return index;
}

/**
 * A segment attribute: a system- or admin-defined key-value pair stored on the contact segment.
 *
 * The keys Connect defines are namespaced with a colon (`connect:Subtype`), which dot notation cannot
 * express, so these read with bracket notation. {@link system.segment} names the common ones.
 */
export function segmentAttr<T = string>(key: string): Ref<T> {
  if (key.length === 0) {
    throw new Error("Segment attribute key must not be empty.");
  }
  if (/['[\]\\]/.test(key)) {
    throw new Error(
      `Segment attribute key ${JSON.stringify(key)} contains a character that is not valid inside a ` +
        "quoted JSONPath segment (' [ ] \\).",
    );
  }
  return makeRef<T>(`$.SegmentAttributes['${key}']`);
}

/**
 * One field of the `connect:CustomerAuthentication` value map.
 *
 * The map is itself a bracketed segment attribute, so its fields chain a second bracket rather than a
 * dot — `$.SegmentAttributes['connect:CustomerAuthentication']['Status']`.
 */
function authField(field: string): Ref<string> {
  return makeRef(`$.SegmentAttributes['connect:CustomerAuthentication']['${field}']`);
}

/**
 * Values Connect populates on the contact, as opposed to values a block hands back.
 *
 * Each of these is a plain read of a documented `$.…` path. Most need no block to have run: the
 * contact identity, endpoints, queue, tags, references and telephony metadata are simply there. The
 * groups that depend on context — `agent`, `capabilities`, `lex`, `mediaStreams`, `wisdom` — say so
 * on their own doc comment, because reading one where it is not populated is empty at runtime rather
 * than an error at deploy.
 *
 * Values a block returns are deliberately absent: a view's result comes back from `showView`, a
 * Lambda's from calling its handle, and real-time metrics stay behind `makeRef` (see
 * `getMetricData`). The same goes for namespaces no action here populates yet — `$.Customer`
 * (Customer Profiles), `$.Case`, `$.DataTables`, `$.Email` and `$.Loop` — which are reachable with
 * `makeRef` once the block that fills them exists.
 *
 * @see https://docs.aws.amazon.com/connect/latest/adminguide/connect-attrib-list.html
 */
export const system = {
  contactId: makeRef("$.ContactId"),
  /** The contact of the first interaction with your contact center, stable across transfers. */
  initialContactId: makeRef("$.InitialContactId"),
  /** The contact as it was before the transfer that produced this one. */
  previousContactId: makeRef("$.PreviousContactId"),
  /**
   * `INBOUND`, `OUTBOUND`, `TRANSFER`, `CALLBACK`, `QUEUE_TRANSFER`, `EXTERNAL_OUTBOUND`, `MONITOR`,
   * `DISCONNECT`, `WEBRTC_API`, or `API`.
   */
  initiationMethod: makeRef("$.InitiationMethod"),
  /** `VOICE`, `CHAT`, `TASK`, or `EMAIL`. */
  channel: makeRef("$.Channel"),
  instanceArn: makeRef("$.InstanceARN"),
  /** The AWS region handling the contact, e.g. `us-east-1`. */
  awsRegion: makeRef("$.AwsRegion"),
  /** A `java.util.Locale` tag such as `en-US`. */
  languageCode: makeRef("$.LanguageCode"),
  /**
   * Your own identifier for the customer, if something set one.
   *
   * Voice ID reads this as the caller's `CustomerSpeakerId`.
   */
  customerId: makeRef("$.CustomerId"),
  /** The Amazon Polly voice used for text-to-speech, as set by `setVoice`. */
  textToSpeechVoiceId: makeRef("$.TextToSpeechVoiceId"),
  /** Populated by `GetParticipantInput` when `storeInput` is true. */
  storedCustomerInput: makeRef("$.StoredCustomerInput"),
  /** The contact's tags, as set by `tagContact`. Test membership with a `keyExists` comparison. */
  tags: makeRef<Record<string, string>>("$.Tags"),
  /** The customer's phone number, or their email address on the `EMAIL` channel. */
  customerEndpoint: {
    address: makeRef("$.CustomerEndpoint.Address"),
    /** `TELEPHONE_NUMBER` on a voice contact. */
    type: makeRef("$.CustomerEndpoint.Type"),
    /** The name on the email the customer sent. `EMAIL` channel only. */
    displayName: makeRef("$.CustomerEndpoint.DisplayName"),
  },
  /** The number the customer dialed, or the address they emailed. */
  systemEndpoint: {
    address: makeRef("$.SystemEndpoint.Address"),
    /** `TELEPHONE_NUMBER` on a voice contact. */
    type: makeRef("$.SystemEndpoint.Type"),
    displayName: makeRef("$.SystemEndpoint.DisplayName"),
  },
  /** The other recipients of an inbound email. `EMAIL` channel only. */
  additionalEmailRecipients: {
    ccList: makeRef("$.AdditionalEmailRecipients.CcList"),
    toList: makeRef("$.AdditionalEmailRecipients.ToList"),
  },
  queue: {
    name: makeRef("$.Queue.Name"),
    arn: makeRef("$.Queue.ARN"),
    /** The queue's own outbound caller ID — what to restore after setting a custom one. */
    outboundCallerId: {
      address: makeRef("$.Queue.OutboundCallerId.Address"),
      type: makeRef("$.Queue.OutboundCallerId.Type"),
    },
  },
  /** The task this contact represents, on the `TASK` channel. */
  task: {
    /** Stable across flows, the way `initialContactId` is for a call. */
    contactId: makeRef("$.Task.ContactId"),
    /** The task's name. Reads `$.Name` — a contact-level field, not one under `Task`. */
    name: makeRef("$.Name"),
    /** Reads `$.Description`, likewise contact-level. */
    description: makeRef("$.Description"),
  },
  /**
   * The agent handling the contact.
   *
   * Populated only in agent whisper, customer whisper, agent hold, customer hold, outbound whisper
   * and transfer-to-agent flows — and in a transfer, these describe the *target* agent rather than
   * the one who initiated it. Empty in inbound, customer queue and transfer-to-queue flows.
   */
  agent: {
    /** The name the agent signs in with. */
    userName: makeRef("$.Agent.UserName"),
    firstName: makeRef("$.Agent.FirstName"),
    lastName: makeRef("$.Agent.LastName"),
    arn: makeRef("$.Agent.ARN"),
  },
  /**
   * What each participant's client can do, for in-app, web and video contacts.
   *
   * @see https://docs.aws.amazon.com/connect/latest/adminguide/inapp-calling.html
   */
  capabilities: {
    agent: {
      screenShare: makeRef("$.Capabilities.Agent.ScreenShare"),
      video: makeRef("$.Capabilities.Agent.Video"),
    },
    customer: {
      screenShare: makeRef("$.Capabilities.Customer.ScreenShare"),
      video: makeRef("$.Capabilities.Customer.Video"),
    },
  },
  media: {
    /** The first message on a web chat or SMS contact, which the customer sent to open it. */
    initialMessage: makeRef("$.Media.InitialMessage"),
    /**
     * Metadata the telephony carrier attached to the call.
     *
     * Carriers differ in what they send, so any of these can arrive empty. Branch defensively.
     */
    sip: {
      /** The party responsible for the call's charges. */
      chargeInfo: makeRef("$.Media.Sip.Headers.P-Charge-Info"),
      /** The end user the request came from. */
      from: makeRef("$.Media.Sip.Headers.From"),
      /** The called party. */
      to: makeRef("$.Media.Sip.Headers.To"),
      /** Originating Line Indicator: PSTN, 800 service, wireless, payphone, ... */
      isupOli: makeRef("$.Media.Sip.Headers.ISUP-OLI"),
      /** Jurisdiction Indication Parameter: the caller's or switch's geography, e.g. `212555`. */
      jip: makeRef("$.Media.Sip.Headers.JIP"),
      hopCounter: makeRef("$.Media.Sip.Headers.Hop-Counter"),
      originatingSwitch: makeRef("$.Media.Sip.Headers.Originating-Switch"),
      originatingTrunk: makeRef("$.Media.Sip.Headers.Originating-Trunk"),
      /** The Diversion header, which distinguishes a domestic from an international origin. */
      callForwardingIndicator: makeRef("$.Media.Sip.Headers.Call-Forwarding-Indicator"),
      /** Calling party number, after an NPAC dip resolves the true line type. */
      callingPartyAddress: makeRef("$.Media.Sip.Headers.Calling-Party-Address"),
      calledPartyAddress: makeRef("$.Media.Sip.Headers.Called-Party-Address"),
      /** SIPREC metadata XML, when the contact arrived through a Contact Lens connector. */
      siprecMetadata: makeRef("$.Media.Sip.SiprecMetadata"),
    },
  },
  /**
   * Where the customer's audio sits in the Kinesis video stream.
   *
   * Populated once `startMediaStreaming` has run.
   */
  mediaStreams: {
    customer: {
      audio: {
        streamArn: makeRef("$.MediaStreams.Customer.Audio.StreamARN"),
        startTimestamp: makeRef("$.MediaStreams.Customer.Audio.StartTimestamp"),
        stopTimestamp: makeRef("$.MediaStreams.Customer.Audio.StopTimestamp"),
        startFragmentNumber: makeRef("$.MediaStreams.Customer.Audio.StartFragmentNumber"),
      },
    },
  },
  /**
   * What the most recent Lex bot reported beyond the intent itself.
   *
   * `connectToLexBot` branches on the intent, so these are for the detail around it — how confident
   * the bot was, which slots it filled, what the customer's sentiment looked like. Populated only
   * after a Lex block has run, and overwritten by the next one.
   */
  lex: {
    intentName: makeRef("$.Lex.IntentName"),
    intentConfidenceScore: makeRef<number>("$.Lex.IntentConfidence.Score"),
    /** `Fulfilled` when the bot returned an intent to the flow. */
    dialogState: makeRef("$.Lex.DialogState"),
    sentiment: {
      /** The sentiment Amazon Comprehend is most confident about. */
      label: makeRef("$.Lex.SentimentResponse.Label"),
      scores: {
        positive: makeRef<number>("$.Lex.SentimentResponse.Scores.Positive"),
        negative: makeRef<number>("$.Lex.SentimentResponse.Scores.Negative"),
        mixed: makeRef<number>("$.Lex.SentimentResponse.Scores.Mixed"),
        neutral: makeRef<number>("$.Lex.SentimentResponse.Scores.Neutral"),
      },
    },
    /** One slot the bot filled from what the customer said. */
    slot<T = string>(name: string): Ref<T> {
      assertValidAttributeKey(name);
      return makeRef<T>(`$.Lex.Slots.${name}`);
    },
    /** A session attribute, including any the `sessionAttributes` option sent in. */
    sessionAttribute<T = string>(key: string): Ref<T> {
      assertValidAttributeKey(key);
      return makeRef<T>(`$.Lex.SessionAttributes.${key}`);
    },
    /** An intent the bot considered but did not pick, keyed by its name. */
    alternativeIntent(name: string) {
      assertValidAttributeKey(name);
      const root = `$.Lex.AlternativeIntents.${name}`;
      return {
        intentName: makeRef(`${root}.IntentName`),
        confidenceScore: makeRef<number>(`${root}.IntentConfidence.Score`),
        slots: makeRef<Record<string, string>>(`${root}.Slots`),
      };
    },
  },
  /** Amazon Q in Connect, formerly Wisdom. Populated once `createWisdomSession` has run. */
  wisdom: {
    /** Pass this to a Lambda that calls the Q in Connect APIs against the session. */
    sessionArn: makeRef("$.Wisdom.SessionArn"),
  },
  /**
   * Segment attributes Connect defines itself.
   *
   * Reach for {@link segmentAttr} for a predefined attribute of your own.
   */
  segment: {
    /** The channel subtype: `connect:SMS`, `connect:WhatsApp`, `connect:Telephony`, ... */
    subtype: segmentAttr("connect:Subtype"),
    /** `INBOUND` or `OUTBOUND`. */
    direction: segmentAttr("connect:Direction"),
    /** The subject line of an email contact. */
    emailSubject: segmentAttr("connect:EmailSubject"),
    /** The 603+ Network Blocked redress header. */
    blockReasonHeader: segmentAttr("connect:BlockReasonHeader"),
    /** The ARN of the user who created a task. */
    createdByUser: segmentAttr("connect:CreatedByUser"),
    /** How a task was assigned; `SELF` is the only value so far. */
    assignmentType: segmentAttr("connect:AssignmentType"),
    /** Comma-separated categories of PII redacted through `DeleteContactData`. */
    redactedFields: segmentAttr("connect:RedactedFields"),
    /** Holds `ScreensharingActivated`, `TRUE` or `FALSE`. */
    screenSharingDetails: segmentAttr<Record<string, string>>("connect:ScreenSharingDetails"),
    /** `ExpiryDuration` and `ExpiryTimeStamp`, on task and email contacts. */
    contactExpiry: segmentAttr<Record<string, string>>("connect:ContactExpiry"),
    /** Amazon SES's spam verdict on an inbound email — check for `FAILED`. */
    sesSpamVerdict: segmentAttr("connect:X-SES-SPAM-VERDICT"),
    /** Amazon SES's virus verdict on an inbound email — check for `FAILED`. */
    sesVirusVerdict: segmentAttr("connect:X-SES-VIRUS-VERDICT"),
    /** How the chat contact authenticated, when customer authentication is configured. */
    customerAuthentication: {
      /** `AUTHENTICATED`, `FAILED`, or `TIMEOUT`. */
      status: authField("Status"),
      identityProvider: authField("IdentityProvider"),
      /** The Amazon Cognito app client id. */
      clientId: authField("ClientId"),
      /** A custom identifier or a Customer Profiles id. */
      associatedCustomerId: authField("AssociatedCustomerId"),
      /** `CONNECT` for a Connect-managed workflow, `CUSTOM` for your own. */
      method: authField("AuthenticationMethod"),
    },
    /** Set on simulated contacts only: `EXPERIENCE_VALIDATION`. */
    validationTestType: segmentAttr("connect:ValidationTestType"),
  },
  /** A reference attached to the contact, such as a URL the agent sees, keyed by its name. */
  reference(key: string) {
    assertValidAttributeKey(key);
    return {
      value: makeRef(`$.References.${key}.Value`),
      type: makeRef(`$.References.${key}.Type`),
    };
  },
} as const;

/**
 * Names another deployed resource: a queue, a flow, a view, a Lambda, a flow module.
 *
 * Accepts a literal, a contact-attribute `Ref`, or a Pulumi input — which is the point. A peer flow
 * created in the same program has no ARN until Pulumi creates it, so `transferToFlow(peer.arn)` would
 * otherwise be impossible to express; a resource can also be passed whole, since one with an `arn` is
 * unambiguous. A Pulumi value becomes a deferred token that `ContactFlow` substitutes at deploy time,
 * exactly as a Lambda's ARN already does.
 */
export type ResourceRef =
  | pulumi.Input<string>
  | Ref<string>
  | { readonly arn: pulumi.Input<string> };

/** Renders a {@link ResourceRef}, allocating a deferred token when the value is Pulumi's to resolve. */
export function renderResource(value: ResourceRef): string {
  if (typeof value === "string") return value;
  if (isRef(value)) return value.path;

  const source =
    typeof value === "object" && value !== null && "arn" in value ? value.arn : (value as unknown);
  // Registered with the recorder rather than resolved here: a flow is built before Pulumi knows any
  // of these values, and awaiting one would break `pulumi preview`.
  return currentRecorder().defer(source);
}
