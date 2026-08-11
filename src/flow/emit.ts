/**
 * Linearizes a recorded block tree into flow-language actions.
 *
 * The central idea is the **continuation**: every block is emitted with the identifier of whatever
 * runs after it. Branches converge by being handed the *same* continuation rather than by having
 * their tails copied, which is what keeps a flow with nested branches from multiplying its way past
 * the 250-action limit.
 */

import {
  type ActionNode,
  type Block,
  type ErrorScopeNode,
  LABEL_PLACEHOLDER,
  type Label,
  type LoopNode,
  type Node,
  type Recorder,
} from "./recorder.js";
import {
  type ActionMetadataEntry,
  FLOW_VERSION,
  type FlowAction,
  type FlowJson,
  IDENTIFIER_FORBIDDEN_CHARS,
  IDENTIFIER_RESERVED_WORDS,
  MAX_IDENTIFIER_LENGTH,
  MODULE_CONTENT_SETTINGS,
  NO_MATCHING_CONDITION,
  NO_MATCHING_ERROR,
  type Transitions,
} from "./types.js";

/** Identifier of the synthesized action that ends a branch running off the end of the flow. */
const FLOW_END_PATH = "flow-end";

export interface EmitResult {
  flow: FlowJson;
  /** Per-scope action counts, so an over-budget flow can name the fragment responsible. */
  actionsByScope: Map<string, number>;
  /** Structural paths of actions that reached their error vertex with no enclosing `onError`. */
  unhandledErrorPaths: string[];
}

const IDENTIFIER_FORBIDDEN_CHARS_GLOBAL = new RegExp(IDENTIFIER_FORBIDDEN_CHARS.source, "g");

function shortDigest(value: string): string {
  // FNV-1a: stable across builds and runtimes. It only needs to separate the handful of over-long
  // paths within a single flow, not resist attack.
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Derives a legal, stable `Identifier` from a structural path.
 *
 * Paths outgrow the 50-character limit once fragments nest, so an over-long path is truncated and
 * given a short digest of the *full* path. The digest depends only on the path, so identifiers stay
 * byte-identical across builds.
 */
export function toIdentifier(path: string, taken: Set<string>): string {
  let id = path.replace(IDENTIFIER_FORBIDDEN_CHARS_GLOBAL, "-");
  if (IDENTIFIER_RESERVED_WORDS.includes(id)) {
    id = `${id}-node`;
  }
  if (id.length > MAX_IDENTIFIER_LENGTH) {
    const digest = shortDigest(path);
    id = `${id.slice(0, MAX_IDENTIFIER_LENGTH - digest.length - 1)}-${digest}`;
  }
  if (!taken.has(id)) {
    taken.add(id);
    return id;
  }
  // Distinct paths collide only after truncation or character replacement; disambiguate.
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${id.slice(0, MAX_IDENTIFIER_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

interface EmitContext {
  actions: FlowAction[];
  taken: Set<string>;
  actionsByScope: Map<string, number>;
  unhandledErrorPaths: string[];
  /** Entry identifier of each error scope's handler: emitted once, shared by every action in it. */
  handlerEntries: Map<ErrorScopeNode, string | undefined>;
  /** Nesting depth per identifier, used only for console layout. */
  depths: Map<string, number>;
  /** Scope per identifier, so budget attribution can be recomputed after pruning. */
  scopeById: Map<string, string>;
  /** The synthesized end-of-flow action, created on first use and reused thereafter. */
  flowEnd: string | undefined;
  /** Which action type to synthesize, since not every flow type accepts a disconnect. */
  terminalType: string;
  /** Identifier each label names, filled as emission passes each one. */
  labelTargets: Map<string, string>;
  /** Every label a jump asked for, so one that was never placed is reported rather than dangling. */
  gotoLabels: Map<string, Label>;
}

function countScope(ctx: EmitContext, id: string, scope: string): void {
  ctx.scopeById.set(id, scope);
}

function push(ctx: EmitContext, action: FlowAction, depth: number): string {
  ctx.actions.push(action);
  ctx.depths.set(action.Identifier, depth);
  return action.Identifier;
}

/**
 * A branch can run off the end of the flow with nothing following it, but Connect still needs a real
 * transition target. Emit one shared terminal action and point every such branch at it.
 */
function flowEnd(ctx: EmitContext, depth: number): string {
  if (ctx.flowEnd !== undefined) return ctx.flowEnd;
  const id = toIdentifier(FLOW_END_PATH, ctx.taken);
  ctx.flowEnd = id;
  return push(
    ctx,
    { Identifier: id, Type: ctx.terminalType, Parameters: {}, Transitions: {} },
    depth,
  );
}

/**
 * Emits `block` and returns the identifier of its first action.
 *
 * A block that recorded nothing returns its continuation unchanged, so an empty branch collapses
 * into whatever follows instead of emitting a no-op action.
 */
function emitBlock(
  ctx: EmitContext,
  block: Block,
  continuation: string | undefined,
  depth: number,
): string | undefined {
  let next = continuation;
  // Back-to-front, so each node already knows the identifier of whatever follows it.
  for (let i = block.nodes.length - 1; i >= 0; i--) {
    next = emitNode(ctx, block.nodes[i] as Node, next, depth);
  }
  return next;
}

function emitNode(
  ctx: EmitContext,
  node: Node,
  continuation: string | undefined,
  depth: number,
): string | undefined {
  switch (node.kind) {
    case "errorScope":
      return emitErrorScope(ctx, node, continuation, depth);
    case "loop":
      return emitLoop(ctx, node, continuation, depth);
    case "action":
      return emitAction(ctx, node, continuation, depth);
    case "label":
      // Emits nothing. Because emission runs back-to-front, whatever follows the label has already
      // been emitted, so its identifier is exactly what a jump to this name should target. A label
      // with nothing after it targets the flow's end.
      ctx.labelTargets.set(node.label.id, continuation ?? flowEnd(ctx, depth));
      return continuation;
    case "goto":
      // Also emits nothing: it replaces the continuation handed to everything before it. The target
      // may not be known yet, so a placeholder stands in until the whole flow is emitted.
      ctx.gotoLabels.set(node.label.id, node.label);
      return `${LABEL_PLACEHOLDER}${node.label.id}`;
  }
}

function emitAction(
  ctx: EmitContext,
  node: ActionNode,
  continuation: string | undefined,
  depth: number,
): string {
  // Reserve the identifier before emitting sub-blocks so nested actions cannot claim it.
  const id = toIdentifier(node.path, ctx.taken);
  countScope(ctx, id, node.scope);

  let transitions: Transitions = {};
  if (!node.terminal) {
    // A non-terminal action must transition somewhere, so resolve the continuation up front and
    // hand the identical target to every sub-block. That shared target is what makes branches
    // converge instead of duplicating their tails.
    const after = continuation ?? flowEnd(ctx, depth + 1);

    const conditions = node.conditions.map((branch) => ({
      NextAction: emitBlock(ctx, branch.body, after, depth + 1) ?? after,
      Condition: branch.condition,
    }));

    // Emitted once. `NoMatchingCondition` is wired to this same identifier rather than re-emitting
    // the block, since Connect reports an exhausted condition list as that error.
    const fallthrough =
      node.fallthrough === undefined
        ? after
        : (emitBlock(ctx, node.fallthrough, after, depth + 1) ?? after);

    const errors = emitErrorTransitions(ctx, node, after, fallthrough, depth);

    transitions = { NextAction: fallthrough };
    if (conditions.length > 0) transitions.Conditions = conditions;
    if (errors.length > 0) transitions.Errors = errors;
  }

  return push(
    ctx,
    { Identifier: id, Type: node.type, Parameters: node.parameters, Transitions: transitions },
    depth,
  );
}

function emitErrorTransitions(
  ctx: EmitContext,
  node: ActionNode,
  after: string,
  fallthrough: string,
  depth: number,
): Array<{ NextAction: string; ErrorType: string }> {
  const errors: Array<{ NextAction: string; ErrorType: string }> = [];
  // Everything the action must declare, plus anything the author handled explicitly.
  const errorTypes = new Set([...node.requiredErrors, ...node.outcomes.keys()]);

  for (const errorType of errorTypes) {
    const handled = node.outcomes.get(errorType);
    if (handled !== undefined) {
      errors.push({
        NextAction: emitBlock(ctx, handled, after, depth + 1) ?? after,
        ErrorType: errorType,
      });
      continue;
    }

    // "No condition matched" is not a failure, so it goes where the action's own fallthrough goes
    // rather than to the error handler. For an action with no explicit else, that is simply `after`.
    if (errorType === NO_MATCHING_CONDITION) {
      errors.push({ NextAction: fallthrough, ErrorType: errorType });
      continue;
    }

    // Otherwise fall through to the nearest enclosing onError scope.
    const scopeEntry =
      node.errorScope === undefined ? undefined : ctx.handlerEntries.get(node.errorScope);
    if (scopeEntry !== undefined) {
      errors.push({ NextAction: scopeEntry, ErrorType: errorType });
    } else if (errorType === NO_MATCHING_ERROR && node.inErrorHandler) {
      // Inside the outermost error handler there is no handler above, and routing back to its own
      // handler would loop. Ending the flow is the only remaining destination, so this is not a
      // policy choice being made on the author's behalf.
      errors.push({ NextAction: flowEnd(ctx, depth + 1), ErrorType: errorType });
    } else if (errorType === NO_MATCHING_ERROR) {
      // Reported rather than silently defaulted. Inventing a default here would be exactly the kind
      // of invisible call-time behavior this library exists to prevent.
      ctx.unhandledErrorPaths.push(node.path);
    } else {
      // A named outcome the author did not handle, with no error scope above it: continue with the
      // rest of the flow, which is the least surprising reading of "not handled here".
      errors.push({ NextAction: after, ErrorType: errorType });
    }
  }
  return errors;
}

/**
 * Emits the handler once, then the body with every action inside it pointing at that handler.
 *
 * Body and handler converge on the scope's own continuation, which is `try`/`catch` semantics:
 * whichever path runs, execution resumes after the block.
 */
function emitErrorScope(
  ctx: EmitContext,
  node: ErrorScopeNode,
  continuation: string | undefined,
  depth: number,
): string | undefined {
  // The handler must exist before the body is emitted, since body actions reference its entry.
  ctx.handlerEntries.set(node, emitBlock(ctx, node.handler, continuation, depth + 1));
  return emitBlock(ctx, node.body, continuation, depth);
}

/**
 * Emits a `Loop` whose body transitions back to the loop action itself.
 *
 * Connect's `Loop` counts invocations of a single identifier, so that back-edge is what makes it a
 * loop: the action reports `ContinueLooping` until the count is reached, then `DoneLooping` once.
 */
function emitLoop(
  ctx: EmitContext,
  node: LoopNode,
  continuation: string | undefined,
  depth: number,
): string {
  const id = toIdentifier(node.path, ctx.taken);
  countScope(ctx, id, node.scope);

  // The body's continuation is the loop action itself, so its last action transitions back.
  const bodyEntry = emitBlock(ctx, node.body, id, depth + 1) ?? id;
  const done = continuation ?? flowEnd(ctx, depth + 1);

  return push(
    ctx,
    {
      Identifier: id,
      Type: "Loop",
      Parameters: { LoopCount: node.count },
      Transitions: {
        // Required even though the conditions already cover both outcomes: Connect rejects any
        // non-terminal action without a NextAction.
        NextAction: done,
        // Connect requires exactly these two conditions on a Loop, and no others.
        Conditions: [
          {
            NextAction: bodyEntry,
            Condition: { Operator: "Equals", Operands: ["ContinueLooping"] },
          },
          { NextAction: done, Condition: { Operator: "Equals", Operands: ["DoneLooping"] } },
        ],
      },
    },
    depth,
  );
}

/**
 * Drops actions nothing can reach from the start.
 *
 * An `onError` handler is emitted before its body is known, so a body made entirely of terminal
 * actions leaves the handler with no referrer. That is legitimate authoring, not a mistake, but the
 * dead handler would still count against the 250-action limit — so it is pruned rather than reported.
 */
function reachableFrom(actions: FlowAction[], start: string): Set<string> {
  const byId = new Map(actions.map((a) => [a.Identifier, a]));
  const reached = new Set<string>();
  const queue = [start];

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
  return reached;
}

/** Turns a completed recording into flow-language JSON. */
/**
 * Replaces every `goto` placeholder with the identifier its label named.
 *
 * Runs after the whole flow is emitted, which is what lets a jump target a label defined later.
 */
function resolveLabels(ctx: EmitContext, start: string): string {
  const unplaced = [...ctx.gotoLabels.values()].filter((l) => !ctx.labelTargets.has(l.id));
  if (unplaced.length > 0) {
    // A label places itself where it is created, so the only way to reach this is a label that
    // belongs to some other recording — one created in a different flow, or in a fragment recorded
    // on its own — whose marker is not in this flow's tree at all.
    throw new Error(
      `goto targets a label that this flow never placed: ${unplaced.map(String).join(", ")}. ` +
        "A label marks the point it was created, so it can only be jumped to from within the flow " +
        "that created it. Declare the label in this flow, and call here() if the jump should land " +
        "somewhere other than where it was declared.",
    );
  }

  const resolve = (id: string | undefined): string | undefined =>
    id?.startsWith(LABEL_PLACEHOLDER)
      ? ctx.labelTargets.get(id.slice(LABEL_PLACEHOLDER.length))
      : id;

  for (const action of ctx.actions) {
    const t = action.Transitions;
    const next = resolve(t.NextAction);
    if (next === undefined) {
      delete t.NextAction;
    } else {
      t.NextAction = next;
    }
    for (const error of t.Errors ?? []) error.NextAction = resolve(error.NextAction) as string;
    for (const condition of t.Conditions ?? []) {
      condition.NextAction = resolve(condition.NextAction) as string;
    }
  }

  return resolve(start) as string;
}

export function emitFlow(recorder: Recorder): EmitResult {
  const ctx: EmitContext = {
    actions: [],
    taken: new Set(),
    actionsByScope: new Map(),
    unhandledErrorPaths: [],
    handlerEntries: new Map(),
    depths: new Map(),
    scopeById: new Map(),
    flowEnd: undefined,
    terminalType: recorder.endWith,
    labelTargets: new Map(),
    gotoLabels: new Map(),
  };

  const start = emitBlock(ctx, recorder.root, undefined, 0);
  if (start === undefined) {
    throw new Error("The flow recorded no actions. A flow must perform at least one action.");
  }

  const resolvedStart = resolveLabels(ctx, start);

  // Emission runs back-to-front; reverse into execution order so the console lays out top-to-bottom.
  // Labels are resolved first, since a block reached only by a jump is reachable.
  const reached = reachableFrom(ctx.actions, resolvedStart);
  const actions = [...ctx.actions].reverse().filter((a) => reached.has(a.Identifier));

  const actionsByScope = new Map<string, number>();
  const positions: Record<string, ActionMetadataEntry> = {};
  actions.forEach((action, index) => {
    const scope = ctx.scopeById.get(action.Identifier) ?? "";
    actionsByScope.set(scope, (actionsByScope.get(scope) ?? 0) + 1);
    positions[action.Identifier] = {
      position: {
        x: index * 250 + 150 /* for the start node */,
        y: (ctx.depths.get(action.Identifier) ?? 0) * 350 + 0,
      },
      // Identifiers here are readable by construction, so the console shows them as block names.
      isFriendlyName: true,
    };
  });

  // A module carries its caller contract alongside its actions, and Connect rejects content that
  // omits it. The terminal is what distinguishes the two resources, here as everywhere else.
  const isModule = ctx.terminalType === "EndFlowModuleExecution";

  return {
    flow: {
      Version: FLOW_VERSION,
      StartAction: resolvedStart,
      Metadata: { entryPointPosition: { x: 20, y: 20 }, ActionMetadata: positions },
      Actions: actions,
      ...(isModule ? { Settings: MODULE_CONTENT_SETTINGS } : {}),
    },
    actionsByScope,
    unhandledErrorPaths: ctx.unhandledErrorPaths,
  };
}
