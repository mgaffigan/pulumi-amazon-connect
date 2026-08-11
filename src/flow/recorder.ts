/**
 * The ambient recorder.
 *
 * A flow is authored as ordinary TypeScript. Running it under a recorder turns the calls it makes —
 * including calls made by imported fragments that know nothing about this library's internals — into
 * a block tree, which {@link emitFlow} then linearizes into flow-language actions.
 *
 * Recording is synchronous. A flow describes a graph rather than running one, so there is nothing to
 * wait for, and making it synchronous removes the failure this design would otherwise have: a
 * forgotten `await` on a branch would record its actions in the wrong order, producing a valid-looking
 * flow that is quietly wrong. A fragment that needs build-time work does it before the flow.
 *
 * The context lives in an `AsyncLocalStorage` rather than a module-level variable so that a stray
 * promise cannot write into whichever flow happens to be recording when it resumes. It resumes with
 * the context it was created under, where {@link Recorder.close} has already made a late append throw.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ActionParameters, Condition } from "./types.js";

/**
 * A reusable piece of a flow. Just a function; it needs no registration or wrapper type.
 *
 * Synchronous, because recording is: a flow describes a graph, it does not run one. A fragment that
 * needs build-time work — an AWS lookup, a file read — does it before the flow and closes over the
 * result, or passes a Pulumi output straight through as a deferred token. Returning a promise here is
 * rejected rather than ignored; see {@link Recorder.captureBlock}.
 */
export type FlowFragment = () => void;

/** An ordered list of nodes. Every sub-block converges on its parent node's continuation. */
export interface Block {
  nodes: Node[];
}

export type Node = ActionNode | LoopNode | ErrorScopeNode | LabelNode | GotoNode;

/** Marks where a label sits. Emits nothing: it names whatever action follows it. */
export interface LabelNode {
  kind: "label";
  label: Label;
}

/** A jump to a {@link Label}. Emits nothing; it redirects the edge that would have continued. */
export interface GotoNode {
  kind: "goto";
  label: Label;
}

/** Prefix for the placeholder a jump leaves behind until the emitter knows the label's target. */
export const LABEL_PLACEHOLDER = "__GOTO__";

let labelCount = 0;

/**
 * A point in a flow that can be jumped to.
 *
 * Identity is the label — there are no names to collide, so a fragment that uses one composes like
 * any other, and two copies of it are two distinct labels rather than a conflict.
 *
 * Creating a label places it, so the common case — jumping back to where the label was written —
 * needs nothing else. {@link Label.here} moves it, which is what a forward jump needs: declare the
 * label above the jump that names it, then place it where the jump should land.
 */
export class Label {
  /** Distinguishes this label's placeholder from every other's while the flow is being emitted. */
  readonly id = `label-${labelCount++}`;

  /** Where the label currently sits, so a later {@link here} can move it rather than duplicate it. */
  private placement: { block: Block; node: LabelNode } | undefined;

  constructor(readonly description?: string) {
    this.place();
  }

  /** Moves the label to this point in the flow. Returns the label, so it can be declared inline. */
  here(): Label {
    this.place();
    return this;
  }

  /**
   * Continues here instead of at the next statement — the method form of `goto(label)`.
   *
   * `menu.goto()` and `goto(menu)` are the same jump; the method reads better where the label is
   * already in hand, and the function where the jump is the statement's subject.
   */
  goto(): never {
    throw this;
  }

  /**
   * Records the marker, first removing any previous one.
   *
   * A stale marker would not be harmless: emission runs back-to-front, so the earlier of two markers
   * is processed last and would win, making a label appear to ignore the `here()` that moved it.
   */
  private place(): void {
    const recorder = currentRecorder();
    if (this.placement !== undefined) {
      const { block, node } = this.placement;
      const index = block.nodes.indexOf(node);
      if (index >= 0) block.nodes.splice(index, 1);
    }
    const block = recorder.currentBlock;
    this.placement = { block, node: recorder.append({ kind: "label", label: this }) };
  }

  toString(): string {
    return this.description ?? this.id;
  }
}

/** True when a thrown value is a jump rather than a genuine failure. */
function isLabel(value: unknown): value is Label {
  return value instanceof Label;
}

export interface ConditionBranch {
  condition: Condition;
  body: Block;
}

export interface ActionNode {
  kind: "action";
  /** The flow-language `Type`, e.g. `MessageParticipant`. */
  type: string;
  parameters: ActionParameters;
  /** Structural path used to derive a stable `Identifier`. */
  path: string;
  /** Nearest enclosing `withScope` name, for per-scope action attribution in diagnostics. */
  scope: string;
  /** Terminal actions end the flow and emit `Transitions: {}`. */
  terminal: boolean;
  /** Conditions declared by the action itself (DTMF options, view actions, ...). */
  conditions: ConditionBranch[];
  /**
   * Where to go when no condition matched. Present on `Compare` (the else branch); absent on
   * actions whose fallthrough is simply the next statement.
   */
  fallthrough?: Block;
  /** Expected named outcomes the author handled, keyed by flow-language error type. */
  outcomes: Map<string, Block>;
  /**
   * Error types this action must always declare a transition for, per the AWS reference. Any not
   * present in {@link outcomes} are wired to the enclosing error scope.
   */
  requiredErrors: string[];
  /** Nearest enclosing `onError`, resolved when the action was recorded. */
  errorScope: ErrorScopeNode | undefined;
  /**
   * True when this action is itself part of an error handler.
   *
   * An action inside the outermost handler has no handler above it, and routing it back to its own
   * handler would loop. Ending the flow is the only remaining destination, so the emitter uses that
   * instead of reporting the action as unprotected.
   */
  inErrorHandler: boolean;
}

export interface LoopNode {
  kind: "loop";
  path: string;
  scope: string;
  /** Static count, or a ref path. Connect requires it be fully static or fully dynamic. */
  count: string;
  /** Runs while the loop reports `ContinueLooping`; converges back to the loop action. */
  body: Block;
}

export interface ErrorScopeNode {
  kind: "errorScope";
  path: string;
  body: Block;
  /** Runs when an action inside {@link body} reaches its generic error vertex. */
  handler: Block;
}

/** A value the flow needs but that is only known after Pulumi resolves an output. */
export interface DeferredValue {
  token: string;
  /** The `Output`-like value; resolved by the Pulumi layer, kept opaque to the flow core. */
  source: unknown;
}

/**
 * A place in the contact's run data that holds one action's result at a time.
 *
 * Connect gives these no scoping: a second Lambda invocation replaces `$.External` wholesale, and the
 * references the first one handed back go on reading the same paths — now pointing at the second
 * one's values, or at nothing. Naming the slot is what lets the recorder catch that where it is
 * written rather than leaving it to be discovered on a live contact.
 */
export interface ResultSlot {
  /** The JSONPath the slot occupies, named in diagnostics. */
  readonly root: string;
  /** What fills it, as it reads in "read it before the next …", e.g. `"Lambda invocation"`. */
  readonly filledBy: string;
}

/**
 * One action's tenancy of a {@link ResultSlot}, stamped on every reference handed out for its result.
 *
 * Validity is identity: a tenancy is live exactly while it is the recorder's current occupant of the
 * slot. Restoring a previous occupant — which is what leaving a branch does — therefore makes that
 * occupant's references live again, with no bookkeeping on the references themselves.
 */
export class Tenancy {
  constructor(
    private readonly recorder: Recorder,
    readonly slot: ResultSlot,
    /** The action that filled the slot, as it appears in diagnostics, e.g. `Lambda "lookup"`. */
    readonly by: string,
  ) {}

  /** @throws if a later action has taken the slot over, making this result unreadable. */
  assertCurrent(): void {
    this.recorder.readSlot(this);
  }
}

/** A Lambda invoked by the flow, collected so the deployment can associate and permission it. */
export interface RecordedLambda {
  /** Stable name used for diagnostics and resource naming. */
  name: string;
  /** The `aws.lambda.Function`-like handle, kept opaque to the flow core. */
  resource: unknown;
}

export class Recorder {
  /** Set once recording ends, so a late append fails instead of disappearing. */
  private closed = false;

  /** Ends recording. Anything appended afterwards is a bug, and says so. */
  close(): void {
    this.closed = true;
  }

  /** Stack of blocks being appended to; the last entry is the current one. */
  private readonly blocks: Block[] = [{ nodes: [] }];
  private readonly scopes: string[] = [];
  private readonly errorScopes: ErrorScopeNode[] = [];
  /** Per-path occurrence counters, so repeating a fragment yields distinct stable paths. */
  private readonly counters = new Map<string, number>();
  private readonly deferred = new Map<string, DeferredValue>();
  private readonly lambdas = new Map<string, RecordedLambda>();
  /** Which action's result currently occupies each slot at this point in the recording. */
  private occupants = new Map<ResultSlot, Tenancy>();
  /**
   * Slots a captured block left holding something else, applied when the action it hangs off is
   * appended — which is the block depth the capture returned to, hence the recorded depth.
   */
  private disturbed: Array<{ slot: ResultSlot; tenancy: Tenancy; depth: number }> = [];
  /** Open read logs, one per enclosing loop body, so a body that reads what it replaces is caught. */
  private readonly readLogs: Array<Set<Tenancy>> = [];
  /** Nesting depth of error-handler capture, so actions can record whether they are inside one. */
  private handlerDepth = 0;
  /** What to synthesize when a branch has nowhere left to go. */
  endWith: TerminalAction = "DisconnectParticipant";

  get root(): Block {
    // The stack is never empty: the constructor seeds it and every push is paired with a pop.
    return this.blocks[0] as Block;
  }

  get currentBlock(): Block {
    return this.blocks[this.blocks.length - 1] as Block;
  }

  get currentScope(): string {
    return this.scopes.length > 0 ? this.scopes.join("-") : "";
  }

  get currentErrorScope(): ErrorScopeNode | undefined {
    return this.errorScopes[this.errorScopes.length - 1];
  }

  get insideErrorHandler(): boolean {
    return this.handlerDepth > 0;
  }

  get recordedLambdas(): RecordedLambda[] {
    return [...this.lambdas.values()];
  }

  get deferredValues(): DeferredValue[] {
    return [...this.deferred.values()];
  }

  /**
   * Allocates a structural path for a node.
   *
   * The path is derived from the enclosing scopes plus an occurrence counter, never from source
   * location, so the same imported fragment used twice produces two distinct but stable paths.
   */
  allocatePath(hint: string): string {
    const prefix = this.scopes.length > 0 ? `${this.scopes.join("-")}-` : "";
    const base = `${prefix}${hint}`;
    const seen = this.counters.get(base) ?? 0;
    this.counters.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen + 1}`;
  }

  /**
   * Hands `slot` to the action being recorded, invalidating the references the last one gave out.
   *
   * Called before the action itself is recorded, so that the action's own error handlers — which are
   * captured during recording — cannot read the previous occupant's result either. It failed; what
   * is in the slot at that point is nobody's.
   */
  fill(slot: ResultSlot, by: string): Tenancy {
    const tenancy = new Tenancy(this, slot, by);
    this.occupants.set(slot, tenancy);
    return tenancy;
  }

  /** The action whose result currently occupies `slot`, if the flow has run one that fills it. */
  occupant(slot: ResultSlot): Tenancy | undefined {
    return this.occupants.get(slot);
  }

  /**
   * Records a read of `tenancy`'s result.
   *
   * @throws if the slot has since changed hands, which is what makes reading a stale reference a
   * build-time error rather than a value that is quietly wrong at contact runtime.
   */
  readSlot(tenancy: Tenancy): void {
    const current = this.occupants.get(tenancy.slot);
    if (current !== tenancy) {
      throw new Error(
        `${tenancy.slot.root} no longer holds the result of ${tenancy.by}: ` +
          `${current?.by ?? "a later action"} replaced it. Read a result before the next ` +
          `${tenancy.slot.filledBy} runs, or copy what you need into a flow attribute with ` +
          "setFlowAttributes() first.",
      );
    }
    for (const log of this.readLogs) log.add(tenancy);
  }

  append<T extends Node>(node: T): T {
    if (this.closed) {
      // Reached when an async fragment's continuation runs after recording finished. The action
      // would otherwise be appended to a tree that has already been emitted, and simply vanish.
      throw new Error(
        "An action was recorded after the flow finished. Recording is synchronous, so an async " +
          "fragment resumes too late for its actions to appear in the flow. Do the asynchronous " +
          "work before the flow and close over the result.",
      );
    }
    // Everything this action's captured blocks left in a slot takes effect here, once they are all
    // recorded: whichever branch runs, the flow arrives at the next statement with a slot that may
    // hold that branch's result and may hold what was there before, so neither can be read. Matching
    // on depth is what keeps that to *this* action's blocks — the actions recorded inside a block
    // append while the block that will disturb them is still being captured.
    const depth = this.blocks.length;
    for (const entry of this.disturbed) {
      if (entry.depth !== depth) continue;
      const replaced = `${entry.tenancy.by} on a branch that may not run`;
      this.occupants.set(entry.slot, new Tenancy(this, entry.slot, replaced));
    }
    this.disturbed = this.disturbed.filter((entry) => entry.depth !== depth);

    this.currentBlock.nodes.push(node);
    return node;
  }

  /**
   * Records `fn`'s calls into a fresh block instead of the current one.
   *
   * Every captured block is conditional — a branch, an outcome handler, a loop body — so it starts
   * from the slots its enclosing action started with, and so does the next sibling captured after it.
   */
  captureBlock(fn: FlowFragment): Block {
    const { block, changed } = this.capture(fn);
    this.recordDisturbance(changed);
    return block;
  }

  /**
   * Records the flow's own body, which is not one branch among several.
   *
   * Nothing runs instead of it and nothing follows it, so what it leaves in a slot simply stays —
   * which is what lets a result still be read once recording is over. Anything the root error handler
   * disturbed is dropped for the same reason: it is reached only when the flow has already failed,
   * and the body does not continue from it.
   */
  captureRootBlock(fn: FlowFragment): Block {
    this.disturbed = [];
    const { block, changed } = this.capture(fn);
    for (const [slot, tenancy] of changed) this.occupants.set(slot, tenancy);
    return block;
  }

  /**
   * Records a loop body, which differs from any other block in that it can run again.
   *
   * A second iteration starts with whatever the first left behind, so a result the body both reads
   * and replaces is correct on the first pass and wrong on every one after it.
   */
  captureLoopBlock(fn: FlowFragment): Block {
    const entry = new Map(this.occupants);
    const reads = new Set<Tenancy>();
    this.readLogs.push(reads);
    let captured: { block: Block; changed: Map<ResultSlot, Tenancy> };
    try {
      captured = this.capture(fn);
    } finally {
      this.readLogs.pop();
    }

    for (const [slot, tenancy] of captured.changed) {
      const before = entry.get(slot);
      if (before === undefined || !reads.has(before)) continue;
      throw new Error(
        `${slot.root} holds the result of ${before.by}, which the loop body reads and ${tenancy.by} ` +
          "replaces, so it is only correct on the first iteration. Read it before the loop, or copy " +
          "what you need into a flow attribute with setFlowAttributes() first.",
      );
    }
    this.recordDisturbance(captured.changed);
    return captured.block;
  }

  /** Holds what a captured block left behind until the action it hangs off is appended. */
  private recordDisturbance(changed: Map<ResultSlot, Tenancy>): void {
    for (const [slot, tenancy] of changed) {
      this.disturbed.push({ slot, tenancy, depth: this.blocks.length });
    }
  }

  /** Runs `fn` into a fresh block, reporting which slots it left in other hands and restoring them. */
  private capture(fn: FlowFragment): { block: Block; changed: Map<ResultSlot, Tenancy> } {
    const block: Block = { nodes: [] };
    const entry = this.occupants;
    this.blocks.push(block);
    this.occupants = new Map(entry);
    try {
      assertSynchronous(fn());
    } catch (thrown) {
      // A `goto` throws its label, which is what makes execution genuinely cease at that point
      // rather than merely being documented to. Anything else is a real failure and propagates.
      if (!isLabel(thrown)) throw thrown;
      block.nodes.push({ kind: "goto", label: thrown });
    } finally {
      this.blocks.pop();
    }

    const changed = new Map<ResultSlot, Tenancy>();
    for (const [slot, tenancy] of this.occupants) {
      if (entry.get(slot) !== tenancy) changed.set(slot, tenancy);
    }
    this.occupants = entry;
    return { block, changed };
  }

  /** Records an error handler's body, marking everything inside it as handler code. */
  captureHandlerBlock(fn: FlowFragment): Block {
    this.handlerDepth++;
    try {
      return this.captureBlock(fn);
    } finally {
      this.handlerDepth--;
    }
  }

  withScopeName<T>(name: string, fn: () => T): T {
    this.scopes.push(name);
    try {
      return fn();
    } finally {
      this.scopes.pop();
    }
  }

  withErrorScope<T>(scope: ErrorScopeNode, fn: () => T): T {
    this.errorScopes.push(scope);
    try {
      return fn();
    } finally {
      this.errorScopes.pop();
    }
  }

  /**
   * Registers a value that is not known until Pulumi resolves it, returning a token to embed in the
   * flow JSON. The Pulumi layer substitutes tokens for real values inside an `apply`.
   */
  defer(source: unknown): string {
    const token = `__PULUMI_OUTPUT_${this.deferred.size}__`;
    this.deferred.set(token, { token, source });
    return token;
  }

  /** Label names defined so far, so a duplicate is caught where it is written. */
  readonly labels = new Set<string>();

  defineLabel(name: string): void {
    if (this.labels.has(name)) {
      // Two labels with one name have no single target. The usual cause is a fragment that defines
      // a label being used twice, which is a real limit of jumping by name.
      throw new Error(
        `Label ${JSON.stringify(name)} is already defined in this flow. Label names must be unique, ` +
          "so a fragment that defines one cannot be used twice in the same flow.",
      );
    }
    this.labels.add(name);
  }

  registerLambda(lambda: RecordedLambda): void {
    // Deduped by name: one association per distinct function, however many times it is invoked.
    if (!this.lambdas.has(lambda.name)) {
      this.lambdas.set(lambda.name, lambda);
    }
  }
}

const storage = new AsyncLocalStorage<Recorder>();

/** The recorder, if a flow is being recorded. For code that works either way; prefer the throwing form. */
export function activeRecorder(): Recorder | undefined {
  return storage.getStore();
}

/**
 * The recorder for the flow currently being built.
 *
 * @throws if called outside {@link runRecorder}, which is what happens when a flow action is called
 * from ordinary application code rather than from a flow.
 */
export function currentRecorder(): Recorder {
  const recorder = storage.getStore();
  if (recorder === undefined) {
    throw new Error(
      "No flow is being recorded. Flow actions may only be called from inside a flow definition " +
        "(a function passed to ContactFlow, recordFlow, or recordFragment).",
    );
  }
  return recorder;
}

/**
 * The action used to end a branch that runs off the end of the flow.
 *
 * Whisper and hold flows reject `DisconnectParticipant`, and `EndFlowExecution` is only valid in
 * whisper and queue flows, so the right terminal depends on the flow type. A flow module ends with
 * neither: it returns to whatever invoked it, via `EndFlowModuleExecution`.
 */
export type TerminalAction =
  | "DisconnectParticipant"
  | "EndFlowExecution"
  | "EndFlowModuleExecution";

export interface RunRecorderOptions {
  /**
   * Handles the generic error vertex of any action not covered by a nearer `onError`.
   *
   * A flow needs one, because most actions can fail and Connect requires every declared error to
   * name a destination. It is a parameter rather than a default so that "what happens when this
   * breaks" is a decision the author made, visible in their code.
   */
  onError?: FlowFragment;
  /** Defaults to `DisconnectParticipant`. */
  endWith?: TerminalAction;
}

/** Runs `fn` with a fresh recorder and returns the recorder holding the resulting block tree. */
export function runRecorder(fn: FlowFragment, options: RunRecorderOptions = {}): Recorder {
  const recorder = new Recorder();
  if (options.endWith !== undefined) {
    recorder.endWith = options.endWith;
  }
  try {
    storage.run(recorder, () => {
      if (options.onError === undefined) {
        // Captured rather than run directly, so a jump thrown at the top level is caught here too.
        for (const node of recorder.captureRootBlock(fn).nodes) recorder.append(node);
        return;
      }
      // Built here rather than by calling onError() so this module stays free of a dependency on
      // control.ts, which already depends on this one. The node is identical to any other error
      // scope, so the emitter needs no special case for the root.
      const scope: ErrorScopeNode = {
        kind: "errorScope",
        path: recorder.allocatePath("root-on-error"),
        handler: recorder.captureHandlerBlock(options.onError),
        body: { nodes: [] },
      };
      scope.body = recorder.withErrorScope(scope, () => recorder.captureRootBlock(fn));
      recorder.append(scope);
    });
  } finally {
    recorder.close();
  }
  return recorder;
}

/**
 * Names a subtree.
 *
 * Identifiers inside the scope are prefixed with `name`, which keeps them readable and keeps them
 * stable when unrelated actions are inserted above the scope. The fragment's return value passes
 * through, so a scoped fragment can still hand back the refs it produced.
 */
export function withScope<T>(name: string, fn: () => T): T {
  const recorder = currentRecorder();
  return recorder.withScopeName(name, fn);
}

/**
 * Rejects a fragment that returned a promise.
 *
 * Recording is synchronous, so the rest of a promise-returning fragment would run *after* everything
 * that follows it has already been recorded — the actions would come out in the wrong order, with no
 * error and nothing to see in the emitted JSON. Failing loudly is the only safe option.
 */
function assertSynchronous(result: unknown): void {
  if (typeof (result as { then?: unknown } | undefined)?.then !== "function") return;
  // The fragment keeps running and fails on its own when it resumes into a finished flow. That is
  // this same failure restated, and nothing is left holding the promise to catch it, so it is
  // swallowed here rather than surfacing as an unhandled rejection that outlives the build.
  if (typeof (result as { catch?: unknown }).catch === "function") {
    void (result as Promise<unknown>).catch(() => {});
  }
  throw new Error(
    "A flow fragment returned a promise. Recording is synchronous, so an async fragment would " +
      "record its actions out of order. Do the asynchronous work before the flow and close over " +
      "the result, or pass a Pulumi output through, which is resolved at deploy time.",
  );
}
