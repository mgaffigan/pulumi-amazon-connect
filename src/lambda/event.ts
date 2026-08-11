/**
 * The event Amazon Connect sends to an invoked Lambda.
 *
 * A flow does not call the handler with its parameters. It sends an envelope — `ContactFlowEvent` —
 * whose `Details.Parameters` holds what the flow passed and whose `Details.ContactData` holds a fixed
 * block of information about the contact, present on every invocation.
 *
 * These types come from two sources that disagree, and the live payload wins where they do. The
 * [reference](https://docs.aws.amazon.com/connect/latest/adminguide/connect-lambda-functions.html)
 * shows `CustomerEndpoint`, `SystemEndpoint`, `CustomerId` and `Queue` only ever populated; a real
 * chat contact sends them as `null`, so they are nullable here. A real payload also carries
 * `AwsRegion`, `RelatedContactId`, `SegmentAttributes`, `Tags`, `Description`, `LanguageCode` and a
 * contact-level `Name`, none of which the reference lists, and an `InitiationMethod` of `"API"`,
 * which is not among the four values it documents.
 */

/** A phone number or other address. */
export interface Endpoint {
  Address: string;
  Type: string;
}

/** The queue the contact is in, when it is in one. */
export interface QueueInfo {
  ARN: string;
  Name: string;
  OutboundCallerId?: Endpoint | null;
}

/** A Kinesis Video stream, present when media streaming is on. */
export interface MediaStream {
  StreamARN?: string;
  StartTimestamp?: string;
  StopTimestamp?: string;
  StartFragmentNumber?: string;
}

/** A reference attached to the contact, such as a URL shown to the agent. */
export interface ContactReference {
  Type: string;
  Value: string;
}

/** A segment attribute value. Only one of the fields is set; the rest arrive as `null`. */
export interface SegmentAttributeValue {
  ValueString?: string | null;
  ValueInteger?: number | null;
  ValueArn?: string | null;
  ValueList?: SegmentAttributeValue[] | null;
  ValueMap?: Record<string, SegmentAttributeValue> | null;
}

/**
 * How the contact reached the flow.
 *
 * The documented four are listed for completion; the union stays open because the service sends more
 * than it documents — a Guide contact arrives as `"API"`.
 */
export type InitiationMethod =
  | "INBOUND"
  | "OUTBOUND"
  | "TRANSFER"
  | "CALLBACK"
  | "API"
  | (string & {});

/** Everything Connect sends about the contact itself, on every invocation. */
export interface ContactData {
  /** Contact attributes set so far. Empty when none have been set. */
  Attributes: Record<string, string>;
  Channel: "VOICE" | "CHAT" | "TASK" | (string & {});
  ContactId: string;
  InitialContactId: string;
  PreviousContactId?: string | null;
  RelatedContactId?: string | null;
  InitiationMethod: InitiationMethod;
  InstanceARN: string;
  /** Absent on channels without one, and `null` on a contact created through the API. */
  CustomerEndpoint?: Endpoint | null;
  SystemEndpoint?: Endpoint | null;
  CustomerId?: string | null;
  Queue?: QueueInfo | null;
  AwsRegion?: string;
  Description?: string | null;
  /** The contact's name, for a task. Not the event name. */
  Name?: string | null;
  LanguageCode?: string | null;
  MediaStreams?: { Customer?: { Audio?: MediaStream } };
  References?: Record<string, ContactReference>;
  SegmentAttributes?: Record<string, SegmentAttributeValue>;
  Tags?: Record<string, string>;
}

/**
 * The whole event.
 *
 * `Parameters` is typed by the handler's own input type: the flow sends exactly the keys the call
 * site passes, and every value arrives as a string.
 */
export interface ContactFlowEvent<Params = Record<string, string>> {
  Details: {
    ContactData: ContactData;
    Parameters: Params;
  };
  Name: "ContactFlowEvent";
}
