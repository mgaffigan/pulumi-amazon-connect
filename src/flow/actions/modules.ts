/**
 * Flow modules: reusable subgraphs Connect stores as their own resource.
 *
 * A module has its own 250-action budget, which is the escape hatch when inlined fragments outgrow a
 * single flow. These actions call and end a module; `ContactFlowModule` authors and deploys one.
 *
 * A module can also declare a contract — an input object, an output object, and named exit branches
 * — which is what turns it from a subroutine into a function. That contract lives on the resource
 * rather than in this content, so these actions carry only the values: `Input` going in, `Result` and
 * `ResultData` coming back.
 */

import { currentRecorder } from "../recorder.js";
import {
  isRef,
  MODULE_RESULT,
  type ModuleRefs,
  moduleResultRefs,
  type Ref,
  type ResourceRef,
  renderResource,
} from "../refs.js";
import { NO_MATCHING_CONDITION, NO_MATCHING_ERROR } from "../types.js";
import { type OutcomeHandler, recordAction } from "./action.js";

/**
 * A value passed to or returned from a module.
 *
 * Scalars keep their JSON type rather than being stringified, which is the one place a flow
 * parameter is not a string: the service validates them against the declared JSON Schema, so a
 * `number` field rejects `"7"`. A `Ref` renders as its path and is therefore only legal where the
 * declared type is `string`.
 */
export type ModuleValue =
  | string
  | number
  | boolean
  | Ref<unknown>
  | { [key: string]: ModuleValue }
  | ModuleValue[];

function renderModuleValue(value: ModuleValue): unknown {
  if (isRef(value)) return value.path;
  if (Array.isArray(value)) return value.map(renderModuleValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderModuleValue(v)]));
  }
  return value;
}

/** Handles one of a module's declared branches, with references to what it returned. */
export type ModuleResultHandler<Out extends object> = (result: ModuleRefs<Out>) => void;

export interface InvokeFlowModuleOptions<Out extends object = Record<string, string>> {
  /**
   * The version qualifier to append: `"$LATEST"` or a published version number.
   *
   * Omitted, the id is used exactly as given — which is what a module id that already carries its
   * own qualifier needs.
   */
  moduleVersion?: string | number;
  /**
   * The input object, checked against the module's declared input schema when the flow is published.
   *
   * A key the module did not declare is rejected by `CreateContactFlow`, so this is a cross-resource
   * check rather than a local one.
   */
  input?: Record<string, ModuleValue>;
  /**
   * One handler per branch the module can return through. Names must match the module's declared
   * branches — `CreateContactFlow` rejects a condition on one that does not exist.
   */
  on?: Record<string, ModuleResultHandler<Out>>;
  /** Runs when the module finished without matching a condition the caller expected. */
  onNoMatch?: OutcomeHandler;
  onError?: OutcomeHandler;
}

/**
 * Appends the version qualifier, unless the id already carries one.
 *
 * Mirrors how a view's version is rendered: the qualifier sits on the resource part, after the last
 * slash, so an ARN's own colons do not count as one.
 */
function qualifiedModuleId(moduleId: ResourceRef, version: string | number | undefined): string {
  const id = renderResource(moduleId);
  const resource = id.slice(id.lastIndexOf("/") + 1);
  if (version === undefined || resource.includes(":")) return id;
  return `${id}:${version}`;
}

/**
 * Runs a flow module, branches on how it returned, and continues afterwards.
 *
 * ```ts
 * invokeFlowModule("a51ac753-bfd4-4be1-9a87-f3cf367c9f4c:$LATEST");
 * ```
 *
 * Real flows pass the module id with a version qualifier. A bare id is left as given, unless
 * `moduleVersion` says which one to append. A module authored here is invoked through
 * `ContactFlowModule.invoke`, which supplies both and checks the input and branch names against the
 * module's own declaration.
 *
 * Returns references to what the module returned. They read `$.Modules.ResultData`, which the next
 * module invoked overwrites, so reading one after invoking another is an error rather than a value
 * that is quietly wrong.
 */
export function invokeFlowModule<Out extends object = Record<string, string>>(
  moduleId: ResourceRef,
  options: InvokeFlowModuleOptions<Out> = {},
): ModuleRefs<Out> {
  const recorder = currentRecorder();

  // Rendered before the slot changes hands: passing the previous module's output into this one is
  // legitimate, since Connect resolves the input and only then runs the module.
  const input =
    options.input === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(options.input).map(([k, v]) => [k, renderModuleValue(v)]),
        );

  // Claimed before anything is recorded, so the branch handlers below — and the flow that follows —
  // see this module's output rather than the previous module's.
  recorder.fill(MODULE_RESULT, "a flow module");
  const result = moduleResultRefs<Out>();

  recordAction({
    type: "InvokeFlowModule",
    hint: "invoke-module",
    parameters: {
      FlowModuleId: qualifiedModuleId(moduleId, options.moduleVersion),
      ...(input === undefined ? {} : { Input: input }),
    },
    requiredErrors: [NO_MATCHING_ERROR, NO_MATCHING_CONDITION],
    conditions: Object.entries(options.on ?? {}).map(([branch, handler]) => ({
      operands: [branch],
      handler: () => handler(result),
    })),
    outcomes: {
      [NO_MATCHING_ERROR]: options.onError,
      [NO_MATCHING_CONDITION]: options.onNoMatch,
    },
  });

  return result;
}

export interface EndFlowModuleOptions {
  /**
   * Which declared branch to return through.
   *
   * Optional even on a module that declares branches; omitted, the caller takes its fall-through.
   * Naming a branch the module did not declare is rejected by `CreateContactFlowModule`.
   */
  branch?: string;
  /**
   * The output object, checked against the module's declared output schema when it is published.
   *
   * Rejected outright if the module declares no output schema, and a key outside that schema is
   * rejected too.
   */
  data?: Record<string, ModuleValue>;
}

/**
 * Ends a flow module and returns to whatever invoked it. Terminal within the module.
 *
 * ```ts
 * endFlowModule({ branch: "authenticated", data: { customerId: external("id") } });
 * ```
 *
 * Only meaningful inside a module; a flow that ends this way should use `endFlow` or `disconnect`.
 */
export function endFlowModule(options: EndFlowModuleOptions = {}): void {
  recordAction({
    type: "EndFlowModuleExecution",
    hint: "end-module",
    parameters: {
      ...(options.branch === undefined ? {} : { Result: options.branch }),
      ...(options.data === undefined
        ? {}
        : {
            ResultData: Object.fromEntries(
              Object.entries(options.data).map(([k, v]) => [k, renderModuleValue(v)]),
            ),
          }),
    },
    terminal: true,
  });
}
