/**
 * Test helpers.
 *
 * Fragment authors need to assert on what their fragment emits without standing up a whole flow or
 * a Pulumi program, so both entry points here run a recording and return plain JSON.
 */

import { type EmitResult, emitFlow } from "../flow/emit.js";
import { type FlowFragment, type RunRecorderOptions, runRecorder } from "../flow/recorder.js";
import type { FlowJson } from "../flow/types.js";
import { findProblems, validateFlow } from "../flow/validate.js";

export interface RecordOptions extends RunRecorderOptions {
  /** Set false to inspect the JSON of a flow that is deliberately invalid. */
  validate?: boolean;
}

/** Records a flow and returns its emitted JSON. */
export function recordFlow(flow: FlowFragment, options: RecordOptions = {}): FlowJson {
  const result = recordFlowResult(flow, options);
  if (options.validate !== false) {
    validateFlow(result);
  }
  return result.flow;
}

/** Records a flow and returns the full emit result, including scope attribution. */
export function recordFlowResult(flow: FlowFragment, options: RunRecorderOptions = {}): EmitResult {
  return emitFlow(runRecorder(flow, options));
}

/**
 * Records a fragment on its own.
 *
 * A fragment usually relies on its caller for an enclosing `onError`, so validation is off by
 * default here — an unhandled error vertex is expected in isolation, not a defect.
 */
export function recordFragment(fragment: FlowFragment): FlowJson {
  return recordFlowResult(fragment).flow;
}

/** Returns validation problems instead of throwing, for asserting on rejection messages. */
export function problemsFor(flow: FlowFragment, options: RunRecorderOptions = {}): string[] {
  return findProblems(recordFlowResult(flow, options));
}

/** Convenience for assertions: the action of a given type, or all of them. */
export function actionsOfType(flow: FlowJson, type: string) {
  return flow.Actions.filter((a) => a.Type === type);
}
