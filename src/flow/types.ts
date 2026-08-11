/**
 * Wire types for the Amazon Connect flow language.
 *
 * These mirror the JSON that `CreateContactFlow` accepts, one-for-one. Nothing here is an
 * abstraction — the authoring API lives elsewhere and compiles down to these.
 *
 * @see https://docs.aws.amazon.com/connect/latest/devguide/flow-language-actions.html
 */

/** The only flow language version Amazon Connect currently supports. */
export const FLOW_VERSION = "2019-10-30";

/**
 * The generic "something failed" vertex. Most actions declare it, and it is what `onError` handles.
 */
export const NO_MATCHING_ERROR = "NoMatchingError";

/**
 * Raised when every condition on an action evaluated false. Despite living in the `Errors` array,
 * this is an expected outcome rather than a failure.
 */
export const NO_MATCHING_CONDITION = "NoMatchingCondition";

/** A single flow may have no more than 250 actions. */
export const MAX_ACTIONS_PER_FLOW = 250;

/** Identifiers are limited to 50 characters. */
export const MAX_IDENTIFIER_LENGTH = 50;

/**
 * Characters Connect rejects inside an `Identifier`: `% : ( \ / ) = $ , ; [ ] { }`.
 * Kept as a character class so {@link isValidIdentifier} and the id generator agree.
 */
export const IDENTIFIER_FORBIDDEN_CHARS = /[%:(\\/)=$,;[\]{}]/;

/**
 * Strings Connect rejects as an `Identifier`, because the flow engine stores actions in a plain
 * object and these would collide with `Object.prototype`.
 */
export const IDENTIFIER_RESERVED_WORDS: readonly string[] = [
  "__proto__",
  "constructor",
  "__defineGetter__",
  "__defineSetter__",
  "toString",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "valueOf",
];

export function isValidIdentifier(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= MAX_IDENTIFIER_LENGTH &&
    !IDENTIFIER_FORBIDDEN_CHARS.test(id) &&
    !IDENTIFIER_RESERVED_WORDS.includes(id)
  );
}

/**
 * The comparison operators available on a `Condition`.
 *
 * Every operator is unary: it compares the action's single result against one static operand.
 * There is no operator that compares two dynamic values.
 */
export type ConditionOperator =
  | "Equals"
  | "TextStartsWith"
  | "TextEndsWith"
  | "TextContains"
  | "NumberGreaterThan"
  | "NumberGreaterOrEqualTo"
  | "NumberLessThan"
  | "NumberLessOrEqualTo"
  /**
   * Tests key presence in an object-valued result. Absent from the reference's operator table but
   * accepted by the service.
   */
  | "KeyExists";

export interface Condition {
  Operator: ConditionOperator;
  /** Operands are always serialized as strings, even for the numeric operators. */
  Operands: string[];
}

export interface ConditionTransition {
  NextAction: string;
  Condition: Condition;
}

export interface ErrorTransition {
  NextAction: string;
  ErrorType: string;
}

export interface Transitions {
  NextAction?: string;
  Errors?: ErrorTransition[];
  Conditions?: ConditionTransition[];
}

/** Parameter objects differ per action type; each action module supplies its own shape. */
export type ActionParameters = Record<string, unknown>;

export interface FlowAction {
  Identifier: string;
  Type: string;
  Parameters: ActionParameters;
  /**
   * Terminal actions (`DisconnectParticipant`, `TransferToFlow`, ...) carry an empty object rather
   * than omitting the field.
   */
  Transitions: Transitions;
}

export interface Position {
  x: number;
  y: number;
}

/**
 * Console layout data.
 *
 * The AWS reference example capitalizes these keys, but every flow the console actually exports
 * uses `entryPointPosition` and `position` in lower camel case. The console is the consumer of this
 * data, so its casing is the one that matters — capitalized keys leave every block stacked at the
 * origin when the flow is opened in the designer.
 */
export interface FlowMetadata {
  entryPointPosition?: Position;
  ActionMetadata?: Record<string, ActionMetadataEntry>;
  [key: string]: unknown;
}

export interface ActionMetadataEntry {
  position: Position;
  /** Set by the console when the identifier doubles as the block's display name. */
  isFriendlyName?: boolean;
  [key: string]: unknown;
}

/**
 * The `Settings` block inside a module's *content*.
 *
 * Required on a flow module and absent from a flow — `CreateContactFlowModule` rejects content
 * without it (`JSON field is missing or null for field name: settings`), while `CreateContactFlow`
 * has no such field.
 *
 * Despite the names, this is not where a module's real contract lives: two console-built modules,
 * one with input, output and two custom branches and one with none of them, carry this block
 * byte-identically — empty parameter lists and a fixed `Success`/`Error` pair. The contract is a
 * `Settings` *string* on the resource instead. So this is boilerplate, and the emitter reproduces
 * exactly what the console writes.
 */
export interface FlowModuleContentSettings {
  InputParameters: unknown[];
  OutputParameters: unknown[];
  Transitions: FlowModuleContentTransition[];
}

export interface FlowModuleContentTransition {
  DisplayName: string;
  ReferenceName: string;
  Description: string;
}

export interface FlowJson {
  Version: typeof FLOW_VERSION;
  StartAction: string;
  Metadata?: FlowMetadata;
  Actions: FlowAction[];
  /** Present only on a flow module. */
  Settings?: FlowModuleContentSettings;
}

/**
 * What the console writes into every module's content, whatever contract the module actually has.
 */
export const MODULE_CONTENT_SETTINGS: FlowModuleContentSettings = {
  InputParameters: [],
  OutputParameters: [],
  Transitions: [
    { DisplayName: "Success", ReferenceName: "Success", Description: "" },
    { DisplayName: "Error", ReferenceName: "Error", Description: "" },
  ],
};
