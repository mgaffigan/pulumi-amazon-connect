/**
 * Deployment plumbing shared by the resources that carry flow-language JSON.
 *
 * A contact flow and a flow module differ in the resource they become and in how a branch that runs
 * off the end is terminated; recording, emitting, validating and resolving deferred ARNs are the
 * same job in both, and live here so they cannot drift apart.
 */

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { type EmitResult, emitFlow } from "../flow/emit.js";
import {
  type FlowFragment,
  type RecordedLambda,
  type Recorder,
  runRecorder,
  type TerminalAction,
} from "../flow/recorder.js";
import type { FlowJson } from "../flow/types.js";
import { validateFlow } from "../flow/validate.js";

export interface RecordedContent {
  /** The emitted flow, for tests and tooling that want to inspect it without deploying. */
  emitted: FlowJson;
  /** The JSON, resolved once Pulumi knows every referenced ARN. */
  content: pulumi.Output<string>;
  /** Every Lambda the recording invokes, to be associated with the instance. */
  lambdas: RecordedLambda[];
}

/**
 * Records a flow, validates it, and resolves the ARNs it embedded as deferred tokens.
 *
 * Recording happens up front rather than inside an `apply` so that every resource the recording
 * implies is declared during the normal registration pass and therefore shows up in `pulumi preview`.
 */
export function recordContent(
  flow: FlowFragment,
  onError: FlowFragment,
  endWith: TerminalAction,
): RecordedContent {
  const recorder: Recorder = runRecorder(flow, { onError, endWith });
  const result: EmitResult = emitFlow(recorder);
  validateFlow(result);

  // A Lambda ARN is unknown while the flow is being recorded, so the recorder embedded a token in
  // its place. Resolving those outputs and substituting the real values happens here, inside the
  // apply, which is the only point at which they are known.
  const deferred = recorder.deferredValues;
  const content = pulumi
    .all(deferred.map((d) => d.source as pulumi.Input<string>))
    .apply((values) => {
      const substitutions = new Map(deferred.map((d, i) => [d.token, values[i] as string]));
      return JSON.stringify(substituteTokens(result.flow, substitutions));
    });

  return { emitted: result.flow, content, lambdas: recorder.recordedLambdas };
}

/**
 * Declares the association that lets Connect invoke each Lambda the recording calls.
 *
 * Associating is sufficient: `AssociateLambdaFunction` adds its own `lambda:InvokeFunction`
 * statement to the function's resource policy, scoped to the instance ARN. Verified against a live
 * instance — a second explicit `aws.lambda.Permission` here only duplicated it.
 */
export function associateLambdas(
  parent: pulumi.ComponentResource,
  name: string,
  instanceId: pulumi.Input<string>,
  lambdas: RecordedLambda[],
): void {
  for (const lambda of lambdas) {
    const fn = lambda.resource as aws.lambda.Function;

    new aws.connect.LambdaFunctionAssociation(
      `${name}-${lambda.name}-association`,
      { instanceId, functionArn: fn.arn },
      { parent },
    );
  }
}

/**
 * Replaces deferred tokens wherever they appear in the emitted JSON.
 *
 * Tokens are matched as substrings rather than whole values, since a parameter may embed one inside
 * a larger string.
 */
function substituteTokens(flow: FlowJson, substitutions: Map<string, string>): FlowJson {
  if (substitutions.size === 0) return flow;

  const replace = (value: unknown): unknown => {
    if (typeof value === "string") {
      let out = value;
      for (const [token, actual] of substitutions) {
        out = out.split(token).join(actual);
      }
      return out;
    }
    if (Array.isArray(value)) return value.map(replace);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
    }
    return value;
  };

  return replace(flow) as FlowJson;
}
