/**
 * Control flow.
 *
 * Branching is an explicit call rather than a native `if`, because the flow is recorded by running
 * it: a recorder can see a thunk it was handed, but not a branch the JavaScript engine already took.
 *
 * The shapes here are constrained by the flow language itself. Every Connect comparison is unary —
 * one dynamic value against one *static* operand — and there is no arithmetic anywhere in the
 * language. So {@link flowIf} types its right-hand side as a plain literal, never a {@link Ref},
 * which turns "compare two attributes" from a deploy-time failure into a compile error.
 */

import {
  type ActionNode,
  type Block,
  currentRecorder,
  type ErrorScopeNode,
  type FlowFragment,
  Label,
  type LoopNode,
} from "./recorder.js";
import { type Ref, renderValue } from "./refs.js";
import { type Condition, type ConditionOperator, NO_MATCHING_CONDITION } from "./types.js";

/** Comparisons valid on any value. */
export type EqualityOp = "equals";

/** Comparisons that read the value as text. */
export type TextOp = "startsWith" | "endsWith" | "contains";

/** Comparisons that read the value as a number. */
export type NumberOp = "lessThan" | "lessOrEqual" | "greaterThan" | "greaterOrEqual";

/**
 * Tests whether a named key is present in an object-valued reference — a Lambda's JSON response,
 * typically.
 *
 * The console offers a companion `Exists` operator behind a feature flag, but Connect rejects it, so
 * it is not exposed here.
 */
export type KeyOp = "keyExists";

/**
 * The operators available for a given value type.
 *
 * A `Ref<number>` gets the numeric comparisons, a `Ref<string>` the text ones, and an object-valued
 * ref gets `keyExists`. Asking for `startsWith` on a numeric ref is a compile error rather than a
 * condition that silently never matches.
 */
export type OperatorFor<T> = [T] extends [number]
  ? EqualityOp | NumberOp
  : [T] extends [string]
    ? EqualityOp | TextOp
    : [T] extends [object]
      ? EqualityOp | KeyOp
      : EqualityOp;

const OPERATORS: Record<EqualityOp | TextOp | NumberOp | KeyOp, ConditionOperator> = {
  equals: "Equals",
  startsWith: "TextStartsWith",
  endsWith: "TextEndsWith",
  contains: "TextContains",
  lessThan: "NumberLessThan",
  lessOrEqual: "NumberLessOrEqualTo",
  greaterThan: "NumberGreaterThan",
  greaterOrEqual: "NumberGreaterOrEqualTo",
  keyExists: "KeyExists",
};

/** A value comparison: one runtime value against one literal. */
export interface ValueComparison<T> {
  op: Exclude<OperatorFor<T>, KeyOp>;
  /** The value to test. Connect allows exactly one dynamic operand per comparison. */
  left: Ref<T>;
  /**
   * The value to test against, which must be a literal.
   *
   * This is not an oversight: the flow language has no operator that compares two runtime values.
   * To compare two attributes, pass both to a Lambda and branch on what it returns.
   */
  right: T & (string | number | boolean);
}

/**
 * A key-presence check, available only where {@link OperatorFor} allows `keyExists`.
 *
 * `right` is the key to look for rather than a value to match.
 */
export type KeyComparison<T> =
  KeyOp extends OperatorFor<T> ? { op: KeyOp; left: Ref<T>; right: string } : never;

export type Comparison<T> = ValueComparison<T> | KeyComparison<T>;

export interface Branches {
  ifTrue?: FlowFragment;
  ifFalse?: FlowFragment;
}

function toCondition(op: string, right: string | number | boolean): Condition {
  const operator = OPERATORS[op as EqualityOp | TextOp | NumberOp | KeyOp];
  return { Operator: operator, Operands: [String(right)] };
}

/**
 * Creates the `Compare` action shared by {@link flowIf} and {@link flowSwitch}.
 *
 * The else branch is wired to both `NextAction` and the `NoMatchingCondition` error, since Connect
 * reports an exhausted condition list as that error rather than simply falling through.
 */
function compare(
  value: Ref<unknown>,
  branches: Array<{ condition: Condition; body: FlowFragment | undefined }>,
  otherwise: FlowFragment | undefined,
  hint: string,
): void {
  const recorder = currentRecorder();

  const conditions = [];
  for (const branch of branches) {
    conditions.push({
      condition: branch.condition,
      body:
        branch.body === undefined ? ({ nodes: [] } as Block) : recorder.captureBlock(branch.body),
    });
  }

  const fallthrough = otherwise === undefined ? undefined : recorder.captureBlock(otherwise);

  const node: ActionNode = {
    kind: "action",
    type: "Compare",
    parameters: { ComparisonValue: renderValue(value) },
    path: recorder.allocatePath(hint),
    scope: recorder.currentScope,
    terminal: false,
    conditions,
    outcomes: new Map(),
    // Connect reports an exhausted condition list as this error, so the else branch is reached
    // through it. The emitter points it at the same identifier as NextAction — the block is not
    // emitted twice.
    requiredErrors: [NO_MATCHING_CONDITION],
    errorScope: recorder.currentErrorScope,
    inErrorHandler: recorder.insideErrorHandler,
  };
  if (fallthrough !== undefined) {
    node.fallthrough = fallthrough;
  }

  recorder.append(node);
}

/**
 * Branches on a comparison.
 *
 * ```ts
 * flowIf(
 *   { op: "lessThan", left: holdSeconds, right: 6 },
 *   { ifTrue: () => play("Almost there."), ifFalse: offerCallback },
 * );
 * ```
 *
 * Both branches converge on whatever follows, so the code after the branch is emitted once.
 */
export function flowIf<T>(comparison: Comparison<T>, branches: Branches): void {
  const { op, left, right } = comparison as { op: string; left: Ref<unknown>; right: string };
  compare(
    left,
    [{ condition: toCondition(op, right), body: branches.ifTrue }],
    branches.ifFalse,
    `if-${describeRef(left)}`,
  );
}

export interface SwitchOptions<T extends string | number> {
  /**
   * Tested in order; the first match wins, exactly as Connect evaluates conditions.
   *
   * The handler is named `run` rather than `then` because an object with a `then` property is a
   * thenable: returning one from an async function would make the runtime call the handler with
   * `(resolve, reject)` instead of recording it.
   */
  cases: Array<{ value: T; run: FlowFragment }>;
  /** Runs when nothing matched. */
  otherwise?: FlowFragment;
}

/**
 * Tests one value against several literals using a single `Compare` action.
 *
 * Prefer this to nested {@link flowIf}s: N cases cost one action here versus N, which matters
 * against the 250-action budget.
 */
export function flowSwitch<T extends string | number>(
  value: Ref<T>,
  options: SwitchOptions<T>,
): void {
  compare(
    value as Ref<unknown>,
    options.cases.map((c) => ({
      condition: { Operator: "Equals" as const, Operands: [String(c.value)] },
      body: c.run,
    })),
    options.otherwise,
    `switch-${describeRef(value)}`,
  );
}

/**
 * Repeats `body` a fixed number of times.
 *
 * Connect's `Loop` counts invocations of a single action, so the count must be either fully static
 * or a single reference — it cannot be computed.
 */
export function flowLoop(count: number | Ref<number>, body: FlowFragment): void {
  const recorder = currentRecorder();

  if (typeof count === "number" && (!Number.isInteger(count) || count < 0 || count > 100)) {
    throw new Error(`Loop count must be an integer between 0 and 100, received ${count}.`);
  }

  const node: LoopNode = {
    kind: "loop",
    path: recorder.allocatePath("loop"),
    scope: recorder.currentScope,
    count: renderValue(count),
    body: recorder.captureLoopBlock(body),
  };
  recorder.append(node);
}

/**
 * Handles the generic error vertex for every action in `body`.
 *
 * ```ts
 * onError(() => {
 *   const customer = lookupCustomer({ phone: system.customerEndpoint.address });
 *   setAttributes({ tier: customer.tier });
 * }, apologizeAndTransfer);
 * ```
 *
 * This is `try`/`catch` in the shape a recorder can see. Scopes nest, and the innermost one wins.
 * The handler is emitted once and shared by every action under it; afterwards, both paths continue
 * with whatever follows the block.
 */
export function onError(body: FlowFragment, handler: FlowFragment): void {
  const recorder = currentRecorder();

  const node: ErrorScopeNode = {
    kind: "errorScope",
    path: recorder.allocatePath("on-error"),
    // Recorded outside the scope, so a failure inside the handler is not routed back to itself.
    handler: recorder.captureHandlerBlock(handler),
    body: { nodes: [] },
  };

  node.body = recorder.withErrorScope(node, () => recorder.captureBlock(body));
  recorder.append(node);
}

/** Derives a short, readable path segment from a ref, e.g. `$.Attributes.tier` becomes `tier`. */
function describeRef(ref: Ref<unknown>): string {
  const segments = ref.path.split(".");
  return (segments[segments.length - 1] ?? "value").replace(/[^A-Za-z0-9_-]/g, "");
}

/**
 * Declares a point a {@link goto} can jump to.
 *
 * The label marks where it is written, so a backward jump needs nothing more than the declaration:
 *
 * ```ts
 * const menu = label("menu");
 * getDigit({ text: "Press 1 for sales.", timeoutSeconds: 5, options: { "1": toSales } });
 * play("I did not get that.");
 * goto(menu);
 * ```
 *
 * A forward jump names a label that has to exist before the jump, so declare it above and place it
 * with `here()` where the jump should land:
 *
 * ```ts
 * const done = label("done");
 * flowIf(cond, { ifTrue: () => goto(done) });
 * play("Only for the other branch.");
 * done.here();
 * ```
 *
 * `here()` moves the label rather than adding a second target, and returns it, so it can still be
 * written inline as `label("menu").here()`.
 *
 * A label also carries the jump as a method — `menu.goto()` is `goto(menu)` — which reads better
 * where the label is already in hand.
 *
 * The label is an object, not a name, so there is nothing to collide: a fragment that uses one
 * composes like any other, and two copies of that fragment hold two distinct labels. The description
 * is only ever used in error messages.
 *
 * A label emits no action and costs nothing against the 250-action budget — it names whatever action
 * follows it.
 */
export function label(description?: string): Label {
  return new Label(description);
}

/**
 * Continues at `target` instead of at the next statement.
 *
 * Implemented as `throw target`, which is not a trick: execution really does cease here, the recorder
 * catches the label as the end of the block, and TypeScript sees a `never` and reports anything below
 * as unreachable. The alternative — recording a marker and returning — would leave the statements
 * after it running and silently contributing nothing.
 *
 * This is the one construct that breaks the rule that a flow reads top to bottom, and it exists
 * because the flow language is a graph: retry loops that re-enter a menu, a handler that resumes
 * mid-flow, a state machine. Reach for `flowIf`, `flowSwitch` and `flowLoop` first.
 *
 * `target.goto()` is the same jump written as a method.
 */
export function goto(target: Label): never {
  throw target;
}
