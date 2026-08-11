/**
 * Remaining flow-control actions: waiting, logging, and showing a view.
 */

import type { ActionNode, Block, FlowFragment } from "../recorder.js";
import { currentRecorder } from "../recorder.js";
import {
  isRef,
  type Ref,
  type ResourceRef,
  renderResource,
  renderValue,
  VIEW_RESULT,
  type ViewResult,
  viewRefs,
} from "../refs.js";
import { NO_MATCHING_CONDITION, NO_MATCHING_ERROR } from "../types.js";
import { compact, type OutcomeHandler, recordAction } from "./action.js";

/** Events that can cut a {@link wait} short. */
export type WaitEvent = "CustomerReturned" | "BotParticipantDisconnected";

export interface WaitOptions {
  /** Up to 604800 (seven days). */
  seconds: number | Ref<number>;
  /** Handlers for events that interrupt the wait, keyed by event name. */
  on?: Partial<Record<WaitEvent, FlowFragment>>;
  onError?: OutcomeHandler;
}

/**
 * A wait that lets the flow proceed once a minimum has elapsed.
 *
 * Entirely undocumented: `ContinueExecution` appears nowhere in the flow-language reference. The
 * service requires `MinimumWaitTimeSeconds` alongside it and requires exactly a `Continue` and a
 * `WaitCompleted` branch — which is how the shape below was established.
 *
 * The structure is verified by publishing; the runtime semantics are not. The reading that fits is
 * "wait up to `seconds`, but allow continuing after `minimumSeconds`". Confirm on a real contact
 * before relying on it.
 */
export interface WaitWithContinueOptions {
  /** The maximum to wait. */
  seconds: number | Ref<number>;
  /** The minimum to wait before the `Continue` branch becomes available. */
  minimumSeconds: number | Ref<number>;
  /** Runs on the `Continue` branch. */
  onContinue?: FlowFragment;
  onError?: OutcomeHandler;
}

/**
 * Pauses the flow.
 *
 * Chat channel only. Connect requires a condition for `WaitCompleted` plus one for every event
 * listed, so the emitted conditions are derived from `on` rather than configured separately.
 */
export function wait(options: WaitOptions | WaitWithContinueOptions | number): void {
  if (typeof options === "object" && "minimumSeconds" in options) {
    waitWithContinue(options);
    return;
  }
  const resolved: WaitOptions = typeof options === "number" ? { seconds: options } : options;
  const recorder = currentRecorder();

  if (typeof resolved.seconds === "number") {
    if (!Number.isInteger(resolved.seconds) || resolved.seconds <= 0 || resolved.seconds > 604800) {
      throw new Error(
        `wait requires a positive integer of at most 604800 seconds, received ${resolved.seconds}.`,
      );
    }
  }

  const events = Object.entries(resolved.on ?? {}).filter(([, handler]) => handler !== undefined);

  const conditions: Array<{ condition: { Operator: "Equals"; Operands: string[] }; body: Block }> =
    [];
  for (const [event, handler] of events) {
    conditions.push({
      condition: { Operator: "Equals", Operands: [event] },
      body: recorder.captureBlock(handler as FlowFragment),
    });
  }
  // Connect requires WaitCompleted among the conditions. It continues with the rest of the flow, so
  // its body is empty and the emitter points it at the wait's continuation.
  conditions.push({
    condition: { Operator: "Equals", Operands: ["WaitCompleted"] },
    body: { nodes: [] },
  });

  const outcomes = new Map<string, Block>();
  if (resolved.onError !== undefined) {
    outcomes.set(NO_MATCHING_ERROR, recorder.captureBlock(resolved.onError));
  }

  const node: ActionNode = {
    kind: "action",
    type: "Wait",
    parameters: compact({
      // `TimeLimitSeconds`, despite the AWS reference calling it `TimeoutSeconds`. Connect rejects
      // the documented name outright.
      TimeLimitSeconds: renderValue(resolved.seconds),
      Events: events.length > 0 ? events.map(([event]) => event) : undefined,
    }),
    path: recorder.allocatePath("wait"),
    scope: recorder.currentScope,
    terminal: false,
    conditions,
    outcomes,
    requiredErrors: [
      NO_MATCHING_ERROR,
      ...(resolved.on?.BotParticipantDisconnected !== undefined ? ["ParticipantNotFound"] : []),
    ],
    errorScope: recorder.currentErrorScope,
    inErrorHandler: recorder.insideErrorHandler,
  };
  recorder.append(node);
}

/** The alternate mode: a minimum wait plus a Continue branch. */
function waitWithContinue(options: WaitWithContinueOptions): void {
  recordAction({
    type: "Wait",
    hint: "wait-continue",
    parameters: {
      TimeLimitSeconds: renderValue(options.seconds),
      MinimumWaitTimeSeconds: renderValue(options.minimumSeconds),
      ContinueExecution: "True",
    },
    // Connect requires exactly these two branches in this mode, and rejects any others.
    conditions: [
      {
        operands: ["Continue"],
        ...(options.onContinue === undefined ? {} : { handler: options.onContinue }),
      },
      { operands: ["WaitCompleted"] },
    ],
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

/**
 * Turns flow logging on or off for the rest of the contact.
 *
 * The setting is inherited by subsequent flows in the same contact, so disabling it around a step
 * that handles sensitive input keeps that input out of CloudWatch.
 */
export function setLogging(behavior: "Enabled" | "Disabled"): void {
  recordAction({
    type: "UpdateFlowLoggingBehavior",
    hint: "set-logging",
    parameters: { FlowLoggingBehavior: behavior },
    // This action documents no errors.
    requiredErrors: [],
  });
}

/**
 * A value a view accepts as input.
 *
 * Not just scalars: a `Table`'s rows are an array, and an AWS-managed view takes its whole content
 * this way — the Cards view's `Cards` is a list of objects with a nested `Detail`. A `Ref` anywhere in
 * the structure becomes its path.
 */
export type ViewDataValue =
  | string
  | number
  | boolean
  | Ref<unknown>
  | readonly ViewDataValue[]
  | { readonly [key: string]: ViewDataValue };

/**
 * Renders one `ViewData` entry.
 *
 * Scalars are stringified, the way every other flow parameter is — console exports quote even the
 * numeric ones. Structured data keeps its shape and its leaves' JSON types instead: the view's own
 * input schema types them (`Graphic: { Include: <boolean> }`), AWS's documented input examples are
 * written that way, and there is no console export of a structured `ViewData` to imitate.
 */
function renderViewData(value: ViewDataValue): unknown {
  if (isRef(value)) return value.path;
  if (typeof value !== "object") return renderValue(value);
  return renderStructure(value);
}

function renderStructure(value: ViewDataValue): unknown {
  if (isRef(value)) return value.path;
  if (Array.isArray(value)) return value.map(renderStructure);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, renderStructure(nested)]),
    );
  }
  return value;
}

/**
 * Handles one of a view's actions, with references to what the participant submitted.
 *
 * The result is passed in rather than read from `showView`'s return value, because handlers are
 * recorded *during* the call — a handler that closed over `const result = showView(…)` would run
 * before that binding exists.
 */
export type ViewResultHandler<Out extends object, A extends string = string> = (
  result: ViewResult<Out, A>,
) => void;

export interface ShowViewOptions<
  Out extends object = Record<string, string>,
  A extends string = string,
> {
  /**
   * The view's id or ARN. May be a Pulumi output.
   *
   * If it already carries a qualifier (`...:$LATEST`), that is left alone and `viewVersion` is
   * ignored.
   */
  viewId: ResourceRef;
  /**
   * The version qualifier to append: `"$LATEST"`, `"$SAVED"`, or a published version number.
   *
   * Console-exported flows carry the version as a qualifier on the ARN rather than as a separate
   * `Version` field, so that is what this emits.
   */
  viewVersion?: string | number;
  /** Data passed into the view, available to its components at runtime. */
  data?: Record<string, ViewDataValue>;
  /**
   * One handler per action the view can raise. These names must match the strings in the view's own
   * `Actions` list — once views are authored in TypeScript, this becomes a checked union.
   */
  on?: Record<string, ViewResultHandler<Out, A>>;
  /** How long to wait for the user to interact. Defaults to 400 seconds. */
  timeoutSeconds?: number;
  onTimeout?: OutcomeHandler;
  onNoMatch?: OutcomeHandler;
  onError?: OutcomeHandler;
  /** Keeps the user's response out of the named destinations. */
  hideResponseOn?: Array<"TRANSCRIPT">;
}

/**
 * Builds the `ViewResource.Id`, appending a version qualifier when one is wanted.
 *
 * The two forms a console export uses are a named qualifier (`:$LATEST`, `:$SAVED`) on a
 * customer-managed view and a bare published version number on an AWS-managed one
 * (`arn:aws:connect:us-east-1:aws:view/after-contact-work:1`). So a `$` is neither added nor removed:
 * `"$LATEST"` stays as it is and `1` becomes `:1`, not `:$1`.
 */
function qualifiedViewId(options: Pick<ShowViewOptions, "viewId" | "viewVersion">): string {
  const id = renderResource(options.viewId);
  // The qualifier sits on the resource part, after the last slash — the ARN's own colons come before it.
  const resource = id.slice(id.lastIndexOf("/") + 1);
  if (options.viewVersion === undefined || resource.includes(":")) return id;
  return `${id}:${options.viewVersion}`;
}

/**
 * Shows a view to the participant and branches on what they chose.
 *
 * Returns references to what they submitted, which is how a form's values or a selected table row
 * are read back:
 *
 * ```ts
 * const result = showView({
 *   viewId: myView.viewId,
 *   data: { customerName },
 *   on: { CardSelected: openCase, Skip: () => play("No problem.") },
 * });
 *
 * setAttributes({ patientName: result.patient_name, chose: result.$action });
 * ```
 *
 * The result defaults to a flat map of string fields. For a view whose output has tables or nested
 * objects — and for checked action names and input data — declare it with `connectView` instead of
 * calling this directly.
 *
 * References read `$.Views.ViewResultData` and `$.Views.Action`, which the next `showView`
 * overwrites, so reading one after another view has been shown is an error rather than a value that
 * is quietly wrong.
 *
 * Chat channel only.
 */
export function showView<Out extends object = Record<string, string>, A extends string = string>(
  options: ShowViewOptions<Out, A>,
): ViewResult<Out, A> {
  const recorder = currentRecorder();

  // Rendered before the slot changes hands, because Connect resolves the data and only then shows
  // the view: passing the previous view's result into this one is legitimate, not a stale read.
  const viewData = Object.fromEntries(
    Object.entries(options.data ?? {}).map(([k, v]) => [k, renderViewData(v)]),
  );

  // Claimed before anything is recorded, so the action handlers below — and the flow that follows —
  // see this view's result rather than the previous view's.
  recorder.fill(VIEW_RESULT, "a view");
  const result = viewRefs<Out, A>();

  // No actions at all is fine: a view can simply display something, and the flow carries on when
  // the participant submits or the wait ends.
  const entries = Object.entries(options.on ?? {});

  const conditions: Array<{ condition: { Operator: "Equals"; Operands: string[] }; body: Block }> =
    [];
  for (const [action, handler] of entries) {
    conditions.push({
      condition: { Operator: "Equals", Operands: [action] },
      body: recorder.captureBlock(() => handler(result)),
    });
  }

  const outcomes = new Map<string, Block>();
  if (options.onTimeout !== undefined) {
    outcomes.set("TimeLimitExceeded", recorder.captureBlock(options.onTimeout));
  }
  if (options.onNoMatch !== undefined) {
    outcomes.set(NO_MATCHING_CONDITION, recorder.captureBlock(options.onNoMatch));
  }
  if (options.onError !== undefined) {
    outcomes.set(NO_MATCHING_ERROR, recorder.captureBlock(options.onError));
  }

  const node: ActionNode = {
    kind: "action",
    type: "ShowView",
    parameters: compact({
      ViewResource: { Id: qualifiedViewId(options) },
      // Every scalar in a flow parameter is a string on the wire, including the numeric ones.
      InvocationTimeLimitSeconds: String(options.timeoutSeconds ?? 400),
      // Always present, empty when there is no data, matching what the console emits.
      ViewData: viewData,
      SensitiveDataConfiguration:
        options.hideResponseOn === undefined
          ? undefined
          : { HideResponseOn: options.hideResponseOn },
    }),
    path: recorder.allocatePath("show-view"),
    scope: recorder.currentScope,
    terminal: false,
    conditions,
    outcomes,
    requiredErrors: [NO_MATCHING_ERROR, NO_MATCHING_CONDITION, "TimeLimitExceeded"],
    errorScope: recorder.currentErrorScope,
    inErrorHandler: recorder.insideErrorHandler,
  };
  recorder.append(node);
  return result;
}
