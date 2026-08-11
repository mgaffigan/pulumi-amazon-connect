/**
 * Shared plumbing for action modules.
 *
 * Every action is a free function that records one node. Keeping the recording mechanics here means
 * an action module is just its parameter type, its documented error set, and the mapping to the
 * flow-language `Parameters` object.
 */

import {
  type ActionNode,
  type Block,
  type ConditionBranch,
  currentRecorder,
  type FlowFragment,
} from "../recorder.js";
import type { Ref } from "../refs.js";
import type { ActionParameters, ConditionOperator } from "../types.js";

/** A handler for one of an action's expected outcomes. */
export type OutcomeHandler = FlowFragment;

/**
 * One branch on an action's own result.
 *
 * Several actions produce a result their conditions test — `CheckHoursOfOperation` reports
 * `True`/`False`, `Loop` reports `ContinueLooping`, a Lex bot reports the matched intent. The result
 * is not a value the flow can read, only something conditions can compare against.
 */
export interface ResultBranch {
  /** Defaults to `Equals`, which is what every result-matching action uses. */
  operator?: ConditionOperator;
  operands: string[];
  handler?: FlowFragment;
}

export interface RecordActionOptions {
  /** Flow-language `Type`. */
  type: string;
  /** Path segment used to build the action's identifier. */
  hint: string;
  parameters: ActionParameters;
  /** Terminal actions end the flow and emit `Transitions: {}`. */
  terminal?: boolean;
  /** Error types the AWS reference says this action must always declare. */
  requiredErrors?: string[];
  /** Author-supplied handlers, keyed by flow-language error type. */
  outcomes?: Record<string, OutcomeHandler | undefined>;
  /** Branches on the action's own result, evaluated in order. */
  conditions?: ResultBranch[];
  /** Where to go when no condition matched. Defaults to whatever follows the action. */
  fallthrough?: FlowFragment;
}

/** Records one action into the flow currently being built. */
export function recordAction(options: RecordActionOptions): void {
  const recorder = currentRecorder();

  const outcomes = new Map<string, Block>();
  for (const [errorType, handler] of Object.entries(options.outcomes ?? {})) {
    if (handler === undefined) continue;
    outcomes.set(errorType, recorder.captureBlock(handler));
  }

  const conditions: ConditionBranch[] = [];
  for (const branch of options.conditions ?? []) {
    conditions.push({
      condition: { Operator: branch.operator ?? "Equals", Operands: branch.operands },
      body: branch.handler === undefined ? { nodes: [] } : recorder.captureBlock(branch.handler),
    });
  }

  const node: ActionNode = {
    kind: "action",
    type: options.type,
    parameters: options.parameters,
    path: recorder.allocatePath(options.hint),
    scope: recorder.currentScope,
    terminal: options.terminal ?? false,
    conditions,
    outcomes,
    requiredErrors: options.requiredErrors ?? [],
    errorScope: recorder.currentErrorScope,
    inErrorHandler: recorder.insideErrorHandler,
  };
  if (options.fallthrough !== undefined) {
    node.fallthrough = recorder.captureBlock(options.fallthrough);
  }
  recorder.append(node);
}

/**
 * Drops keys whose value is `undefined`.
 *
 * Connect rejects some parameters when present-but-empty, so an omitted option must be absent from
 * the JSON rather than serialized as null.
 */
export function compact(parameters: Record<string, unknown>): ActionParameters {
  return Object.fromEntries(Object.entries(parameters).filter(([, v]) => v !== undefined));
}

/** Text that may mix literals and refs, e.g. `` `Hello ${customerName}` ``. */
export type Text = string | Ref<string>;
