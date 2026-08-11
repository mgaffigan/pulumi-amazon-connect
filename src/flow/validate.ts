/**
 * Structural checks on emitted flow JSON.
 *
 * Everything here is something Connect would otherwise reject at `CreateContactFlow` time, or worse,
 * accept and then fail on during a live contact. Reporting it against the authoring code — with the
 * scope of the fragment responsible — is the whole point.
 */

import type { EmitResult } from "./emit.js";
import {
  type FlowJson,
  isValidIdentifier,
  MAX_ACTIONS_PER_FLOW,
  NO_MATCHING_ERROR,
} from "./types.js";

export class FlowValidationError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Flow is not valid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "FlowValidationError";
    this.problems = problems;
  }
}

/** Returns every problem found, so one build surfaces all of them rather than one at a time. */
export function findProblems(result: EmitResult): string[] {
  const { flow } = result;
  const problems: string[] = [];

  problems.push(...checkActionBudget(flow, result.actionsByScope));
  problems.push(...checkIdentifiers(flow));
  problems.push(...checkEmptyParameterValues(flow));
  problems.push(...checkEmptyOperands(flow));
  problems.push(...checkTransitionTargets(flow));
  problems.push(...checkReachability(flow));
  problems.push(...checkUnhandledErrors(result));

  return problems;
}

export function validateFlow(result: EmitResult): void {
  const problems = findProblems(result);
  if (problems.length > 0) {
    throw new FlowValidationError(problems);
  }
}

function checkActionBudget(flow: FlowJson, actionsByScope: Map<string, number>): string[] {
  if (flow.Actions.length <= MAX_ACTIONS_PER_FLOW) return [];

  // Attribute the overage, because inlined fragments are how a flow blows this budget and the
  // failure is otherwise reported nowhere near the code that caused it.
  const attribution = [...actionsByScope.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([scope, count]) => `${scope === "" ? "(top level)" : scope}: ${count}`)
    .join(", ");

  return [
    `Flow has ${flow.Actions.length} actions, exceeding the Amazon Connect limit of ` +
      `${MAX_ACTIONS_PER_FLOW}. Actions by scope: ${attribution}. Consider extracting a fragment ` +
      "into its own flow module.",
  ];
}

function checkIdentifiers(flow: FlowJson): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const action of flow.Actions) {
    if (!isValidIdentifier(action.Identifier)) {
      problems.push(
        `Action identifier ${JSON.stringify(action.Identifier)} is not valid for Amazon Connect.`,
      );
    }
    if (seen.has(action.Identifier)) {
      problems.push(`Duplicate action identifier ${JSON.stringify(action.Identifier)}.`);
    }
    seen.add(action.Identifier);
  }
  return problems;
}

/**
 * Connect rejects an empty string as a parameter value, anywhere in any action.
 *
 * Confirmed by publishing: `ShowView` with `ViewData: { a: "" }`, `UpdateContactAttributes` with an
 * empty attribute, and `MessageParticipant` with empty text are each rejected, in a flow and in a
 * module alike. A single space is accepted, so this is emptiness rather than falsiness.
 *
 * It is worth a build-time check because the service's own message names neither the action nor the
 * property — `Invalid Action property value. Path: 0.Parameter` is all a deploy failure gives you —
 * and because the value is usually a variable that happened to be empty rather than a literal.
 */
function checkEmptyParameterValues(flow: FlowJson): string[] {
  const problems: string[] = [];

  const walk = (value: unknown, path: string, action: string): void => {
    if (typeof value === "string") {
      if (value.length === 0) {
        problems.push(
          `Action ${JSON.stringify(action)} has an empty string at ${path}. Amazon Connect rejects ` +
            "an empty parameter value: omit the property, or pass a non-empty placeholder.",
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        walk(item, `${path}[${i}]`, action);
      });
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, nested] of Object.entries(value)) walk(nested, `${path}.${key}`, action);
    }
  };

  for (const action of flow.Actions) {
    for (const [key, value] of Object.entries(action.Parameters)) {
      walk(value, `Parameters.${key}`, action.Identifier);
    }
  }
  return problems;
}

/**
 * An operand is a parameter too, and Connect rejects an empty one — but reports it differently.
 *
 * Confirmed by publishing: a `Compare` against `""` is refused with `Invalid branch. Path:
 * 2.Evaluate`, which names the block's index and its console name and nothing else. Against `" "`
 * it is accepted, so this is the same emptiness rule the parameter check enforces, reached by a
 * different path — an operand lives in `Transitions`, not `Parameters`.
 *
 * The advice differs, which is why this is its own check. There is no comparison against blank in
 * the flow language, so an empty operand is never a value to fill in: whatever produces the
 * compared value has to return a sentinel to compare against instead.
 */
function checkEmptyOperands(flow: FlowJson): string[] {
  const problems: string[] = [];

  for (const action of flow.Actions) {
    for (const condition of action.Transitions.Conditions ?? []) {
      for (const operand of condition.Condition.Operands) {
        if (operand.length > 0) continue;
        problems.push(
          `Action ${JSON.stringify(action.Identifier)} compares with an empty operand ` +
            `(${condition.Condition.Operator}). Amazon Connect has no comparison against an empty ` +
            "value: return a non-empty sentinel from whatever produces the value — a Lambda, an " +
            "attribute — and compare against that.",
        );
      }
    }
  }
  return problems;
}

function checkTransitionTargets(flow: FlowJson): string[] {
  const problems: string[] = [];
  const known = new Set(flow.Actions.map((a) => a.Identifier));

  const check = (target: string, from: string, via: string): void => {
    if (!known.has(target)) {
      problems.push(
        `Action ${JSON.stringify(from)} transitions via ${via} to unknown action ${JSON.stringify(target)}.`,
      );
    }
  };

  if (!known.has(flow.StartAction)) {
    problems.push(
      `StartAction ${JSON.stringify(flow.StartAction)} is not one of the flow's actions.`,
    );
  }

  for (const action of flow.Actions) {
    const { NextAction, Errors, Conditions } = action.Transitions;
    if (NextAction !== undefined) check(NextAction, action.Identifier, "NextAction");
    for (const error of Errors ?? []) {
      check(error.NextAction, action.Identifier, `error ${error.ErrorType}`);
    }
    for (const condition of Conditions ?? []) {
      check(condition.NextAction, action.Identifier, `condition ${condition.Condition.Operator}`);
    }
  }
  return problems;
}

/**
 * An unreachable action is always a bug in this library's emitter rather than in the user's flow —
 * the authoring API gives no way to write one — so it is worth catching loudly.
 */
function checkReachability(flow: FlowJson): string[] {
  const byId = new Map(flow.Actions.map((a) => [a.Identifier, a]));
  const reached = new Set<string>();
  const queue = [flow.StartAction];

  while (queue.length > 0) {
    const id = queue.pop() as string;
    if (reached.has(id)) continue;
    reached.add(id);

    const action = byId.get(id);
    if (action === undefined) continue;
    const { NextAction, Errors, Conditions } = action.Transitions;
    if (NextAction !== undefined) queue.push(NextAction);
    for (const error of Errors ?? []) queue.push(error.NextAction);
    for (const condition of Conditions ?? []) queue.push(condition.NextAction);
  }

  const orphans = flow.Actions.filter((a) => !reached.has(a.Identifier)).map((a) => a.Identifier);
  return orphans.length === 0
    ? []
    : [`Unreachable actions: ${orphans.join(", ")}. This is a bug in the flow emitter.`];
}

function checkUnhandledErrors(result: EmitResult): string[] {
  if (result.unhandledErrorPaths.length === 0) return [];

  const paths = [...new Set(result.unhandledErrorPaths)].join(", ");
  return [
    `These actions can fail but have no error handler: ${paths}. Wrap them in onError(body, ` +
      `handler), or handle ${NO_MATCHING_ERROR} on the action itself. No default is applied, ` +
      "because a silent default would hide the failure until a live contact hits it.",
  ];
}
