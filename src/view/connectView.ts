/**
 * Views with typed inputs and outputs.
 *
 * `connectLambda` gets its types from the handler you hand it. A view has no handler — the template
 * lives in Amazon Connect — so the types are declared instead, and everything downstream follows
 * from that declaration: the data you pass in is checked, the actions you handle are exhaustive, and
 * the values you read back are references shaped like the view's output.
 */

import type { OutcomeHandler } from "../flow/actions/action.js";
import { showView, type ViewDataValue } from "../flow/actions/misc.js";
import type { DynamicInput, Ref, ResourceRef, ViewResult } from "../flow/refs.js";
import type { DefinedView } from "./template.js";

/**
 * Data a view accepts.
 *
 * Any object type: scalars reach the view as strings, and a component fed structured data — a `Table`'s
 * items — takes an array, which Connect derives as an array input. What may be passed for each field is
 * checked against the declared type, not against this bound.
 */
export type ViewInput = object;

/**
 * Data a view submits back. Fields may be scalars, nested objects, or table rows.
 *
 * Any object type, like {@link ViewInput}: a declared `interface` has no index signature, and requiring
 * one would mean every view's output type had to be written as a `Record`.
 */
export type ViewOutput = object;

declare const shapeBrand: unique symbol;

/**
 * A stand-in for a type that has no runtime value.
 *
 * TypeScript cannot infer some type arguments and require others, so a view's input and output
 * types are carried by these witnesses rather than written as explicit type arguments. That keeps
 * the action list inferrable as a literal union at the same time.
 */
export interface Shape<T> {
  readonly [shapeBrand]: T;
}

/**
 * Declares a type for {@link connectView} to carry.
 *
 * The returned object is empty and carries nothing: the type is the point. It is an object rather than
 * `undefined` only so that *whether* a shape was declared is visible at runtime, which is what gates
 * the output cross-check in `defineView`.
 */
export function shape<T>(): Shape<T> {
  return Object.freeze({}) as unknown as Shape<T>;
}

export interface ExistingViewOptions<
  In extends ViewInput,
  Out extends ViewOutput,
  A extends string,
> {
  /** The view's id or ARN. May be a Pulumi output. */
  viewId: string | Ref<string>;
  /** `"$LATEST"`, `"$SAVED"`, or a published version number. */
  viewVersion?: string | number;
  /**
   * Every action this view can raise, matching the `Actions` list on the view resource.
   *
   * Declaring them is what lets `show` check the handler names. Omit it for a view that only
   * displays something.
   */
  actions?: readonly A[];
  /** The data the view expects. */
  input?: Shape<In>;
  /** The data the view submits back. */
  output?: Shape<Out>;
  /** Default time to wait for the participant. Overridable per call. */
  timeoutSeconds?: number;
}

/**
 * Handles one of a view's actions.
 *
 * The submitted data is passed in rather than read from `show`'s return value, because handlers are
 * recorded *during* the `show` call — a handler that closed over `const result = view.show(…)`
 * would run before that binding exists.
 */
export type ViewActionHandler<Out extends ViewOutput, A extends string = string> = (
  result: ViewResult<Out, A>,
) => void;

/** Arguments to {@link ShowableView.show}, with `data` required only when the view takes input. */
export type ShowArgs<In extends ViewInput, Out extends ViewOutput, A extends string> = {
  /**
   * Handlers for the actions that branch.
   *
   * Optional, and partial. An action with no handler continues with whatever follows the `show`
   * call, which is what makes a run of screens read as a run of statements rather than nesting one
   * inside the next. Give an action a handler when it should do something *different*.
   */
  on?: Partial<Record<A, ViewActionHandler<Out, A>>>;
  timeoutSeconds?: number;
  /** Runs when the participant did not respond in time. */
  onTimeout?: OutcomeHandler;
  /** Runs when the view raised something outside the declared actions. */
  onNoMatch?: OutcomeHandler;
  onError?: OutcomeHandler;
  /** Keeps the response out of the named destinations. */
  hideResponseOn?: Array<"TRANSCRIPT">;
} & (Record<string, never> extends In ? { data?: DynamicInput<In> } : { data: DynamicInput<In> });

/** A view that a flow can show. */
export interface ShowableView<In extends ViewInput, Out extends ViewOutput, A extends string> {
  /**
   * Shows the view and returns references to what the participant submitted, plus `$action`.
   *
   * The same references are passed to each action handler, which is where they are usually wanted.
   */
  show(args: ShowArgs<In, Out, A>): ViewResult<Out, A>;
  readonly actions: readonly A[];
}

/**
 * Shows a view authored with `defineView`.
 *
 * Preferred over redeclaring the types: `view` supplies the inputs, the outputs and the action list, so
 * the only thing left to say is where the deployed view lives.
 */
export interface ExistingViewFromDefinition<
  In extends ViewInput,
  Out extends ViewOutput,
  A extends string,
> {
  /** The deployed view's id or ARN. May be a Pulumi output. */
  viewId: string | Ref<string>;
  /** The view built by `defineView`. */
  view: DefinedView<In, Out, A>;
  /** `"$LATEST"`, `"$SAVED"`, or a published version number. */
  viewVersion?: string | number;
  /** Default time to wait for the participant. Overridable per call. */
  timeoutSeconds?: number;
}

/**
 * Declares a view with typed input, output, and actions.
 *
 * ```ts
 * const patientSearch = existingView({
 *   viewId: config.require("patientSearchViewId"),
 *   actions: ["Next", "Back"],
 *   input: shape<{ facilityName: string }>(),
 *   output: shape<{
 *     patient_name: string;
 *     PatientTable: Array<{ pat_id: string; mrn_no: string }>;
 *   }>(),
 * });
 *
 * // inside a flow
 * const result = patientSearch.show({
 *   data: { facilityName: attr("facility_name") },
 *   on: { Next: proceed, Back: goBack },
 * });
 *
 * setAttributes({
 *   name: result.patient_name,                  // Ref<string>
 *   id: result.PatientTable.at(0).pat_id,       // Ref<string>
 *   chose: result.$action,                      // Ref<"Next" | "Back">
 * });
 * ```
 *
 * Views are not yet authored in TypeScript, so this describes a view that already exists in the
 * instance. When they are, the same declaration will also create the resource — the shape of this
 * API is chosen so that change is additive.
 */
export function existingView<In extends ViewInput, Out extends ViewOutput, A extends string>(
  options: ExistingViewFromDefinition<In, Out, A>,
): ShowableView<In, Out, A>;
export function existingView<
  In extends ViewInput = Record<string, never>,
  Out extends ViewOutput = Record<string, never>,
  const A extends string = string,
>(options: ExistingViewOptions<In, Out, A>): ShowableView<In, Out, A>;
export function existingView<
  In extends ViewInput = Record<string, never>,
  Out extends ViewOutput = Record<string, never>,
  const A extends string = string,
>(
  declaration: ExistingViewOptions<In, Out, A> | ExistingViewFromDefinition<In, Out, A>,
): ShowableView<In, Out, A> {
  const options: ExistingViewOptions<In, Out, A> =
    "view" in declaration
      ? {
          viewId: declaration.viewId,
          actions: declaration.view.actions ?? [],
          ...(declaration.viewVersion === undefined
            ? {}
            : { viewVersion: declaration.viewVersion }),
          ...(declaration.timeoutSeconds === undefined
            ? {}
            : { timeoutSeconds: declaration.timeoutSeconds }),
        }
      : declaration;

  return showableView<In, Out, A>({
    label: String(options.viewId),
    resolveViewId: () => options.viewId,
    actions: options.actions ?? [],
    ...(options.viewVersion === undefined ? {} : { viewVersion: options.viewVersion }),
    ...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }),
  });
}

/** What {@link showableView} needs to record a `ShowView`. */
export interface ShowableViewConfig<A extends string> {
  /** Names the view in error messages. */
  label: string;
  /**
   * Produces the view id to embed, called while the flow is being recorded.
   *
   * Lazy because a view deployed by the same program has no id yet: the resource hands back a
   * deferred token, and allocating one requires the active recorder.
   */
  resolveViewId: () => ResourceRef;
  actions: readonly A[];
  viewVersion?: string | number;
  timeoutSeconds?: number;
}

/**
 * Builds the `show` half of a view, shared by {@link existingView} and the `ConnectView` resource.
 */
export function showableView<In extends ViewInput, Out extends ViewOutput, A extends string>(
  config: ShowableViewConfig<A>,
): ShowableView<In, Out, A> {
  const show = (args: ShowArgs<In, Out, A>): ViewResult<Out, A> => {
    const { data, on } = args as ShowArgs<In, Out, A> & {
      data?: DynamicInput<In>;
      on?: Partial<Record<A, ViewActionHandler<Out, A>>>;
    };

    const timeoutSeconds = args.timeoutSeconds ?? config.timeoutSeconds;
    // Every declared action gets a branch, so the view can raise it; an unhandled one records an
    // empty block, which the emitter collapses into the continuation. `showView` hands each handler
    // the submitted data, so there is nothing to bind here.
    const handlers: Record<string, ViewActionHandler<Out, A>> = {};
    for (const action of config.actions) {
      handlers[action] = on?.[action] ?? (() => {});
    }

    return showView<Out, A>({
      viewId: config.resolveViewId(),
      ...(config.viewVersion === undefined ? {} : { viewVersion: config.viewVersion }),
      ...(data === undefined ? {} : { data: data as Record<string, ViewDataValue> }),
      on: handlers,
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
      ...(args.onTimeout === undefined ? {} : { onTimeout: args.onTimeout }),
      ...(args.onNoMatch === undefined ? {} : { onNoMatch: args.onNoMatch }),
      ...(args.onError === undefined ? {} : { onError: args.onError }),
      ...(args.hideResponseOn === undefined ? {} : { hideResponseOn: args.hideResponseOn }),
    });
  };

  return { show, actions: config.actions };
}
