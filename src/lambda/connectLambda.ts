/**
 * Lambdas that behave like lambdas.
 *
 * `connectLambda` wraps a normal handler function so it can be called from inside a flow. Calling it
 * there records an `InvokeLambdaFunction` action and hands back typed references to what the handler
 * will return; the handler itself is deployed by Pulumi's own closure serialization, which this
 * library does not reimplement.
 */

import * as aws from "@pulumi/aws";
import type * as pulumi from "@pulumi/pulumi";
import { type OutcomeHandler, recordAction } from "../flow/actions/action.js";
import { currentRecorder, type Tenancy } from "../flow/recorder.js";
import { LAMBDA_RESULT, type Ref, renderValue, volatileRef } from "../flow/refs.js";
import { NO_MATCHING_ERROR } from "../flow/types.js";
import type { ContactFlowEvent } from "./event.js";

/** What a handler may accept. Everything arrives at the handler as a string over the wire. */
export type InvocationInput = Record<string, string | number | boolean>;

/**
 * The call-site view of a handler's input.
 *
 * The handler is written against real values, but a flow has none — only references to values that
 * will exist at contact runtime. Each field therefore accepts a literal or a matching `Ref`.
 */
export type DynamicInput<In> = { [K in keyof In]: In[K] | Ref<In[K]> };

/**
 * A flat map of strings, which is all Connect's `STRING_MAP` response type permits.
 *
 * Returning anything nested under `STRING_MAP` fails at runtime, so the type rejects it up front.
 *
 * `undefined` is allowed because a handler that has nothing for a key should not have to invent a
 * placeholder: Lambda serializes the result with `JSON.stringify`, which drops those keys entirely,
 * and Connect treats a key that is not in the response the same as one that never existed.
 */
export type StringMap = Record<string, string | undefined>;

/**
 * References to a Lambda's results, mirroring the handler's return type.
 *
 * Each property resolves to `$.External.<key>` at contact runtime.
 *
 * `undefined` is stripped from each property's type: Connect has no such value, and a key the
 * response omitted reads as the empty string rather than being absent. A ref to an optional field is
 * therefore a `Ref<string>` that may resolve to `""`, which is what the flow can actually test for.
 */
export type ExternalRefs<T> = { readonly [K in keyof T]: Ref<NonNullable<T[K]>> };

/**
 * A Lambda handler invoked by a flow.
 *
 * It receives what Connect actually sends — the whole {@link ContactFlowEvent} — rather than a
 * convenience view of it. The parameters the flow passed are `event.Details.Parameters`, typed by
 * `In`; everything else Connect includes about the contact sits beside them under
 * `event.Details.ContactData`, and none of it is hidden.
 *
 * ```ts
 * handler: async (event: ContactFlowEvent<{ phone: string }>) => ({
 *   tier: event.Details.ContactData.Attributes.vip === "true" ? "gold" : "standard",
 * })
 * ```
 */
export type ConnectHandler<In, Out> = (
  event: ContactFlowEvent<In>,
  context: aws.lambda.Context,
) => Promise<Out>;

/** Connect permits 1-8 seconds for a synchronous invocation. */
export type InvocationTimeout = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

interface CommonOptions {
  /** Seconds to wait for the function. Connect's hard ceiling is 8. */
  timeoutSeconds?: InvocationTimeout;
  /** Passed through to `aws.lambda.CallbackFunction`. */
  functionOptions?: Partial<aws.lambda.CallbackFunctionArgs<unknown, unknown>>;
}

export interface StringMapLambdaOptions<In, Out extends StringMap> extends CommonOptions {
  /** Flat string map. Read results as `$.External.<key>`. */
  responseType?: "STRING_MAP";
  handler: ConnectHandler<In, Out>;
}

export interface JsonLambdaOptions<In, Out> extends CommonOptions {
  /** Arbitrary JSON, including nested objects. */
  responseType: "JSON";
  handler: ConnectHandler<In, Out>;
}

export interface AsyncLambdaOptions<In> extends CommonOptions {
  /**
   * Fire and forget: the flow moves on without waiting.
   *
   * Nothing lands in `$.External`, so the call returns no references — that is why this is a separate
   * option shape rather than a flag.
   */
  invocationType: "ASYNCHRONOUS";
  handler: ConnectHandler<In, unknown>;
}

/** A Lambda invoked without waiting. Returns nothing, because nothing comes back. */
export interface AsyncConnectLambda<In> {
  (input: DynamicInput<In>, options?: InvokeOptions): Promise<void>;
  readonly function: aws.lambda.CallbackFunction<unknown, unknown>;
  readonly name: string;
}

export interface InvokeOptions {
  /** Handles this invocation's error vertex, overriding any enclosing `onError`. */
  onError?: OutcomeHandler;
}

/**
 * A deployed Lambda, callable from inside a flow.
 *
 * The call signature is the handler's own, with the return type replaced by references — a flow
 * cannot see the values, only point at where they will be.
 */
export interface ConnectLambda<In, Out> {
  (input: DynamicInput<In>, options?: InvokeOptions): ExternalRefs<Out>;
  /** The underlying function, for granting it access to other resources. */
  readonly function: aws.lambda.CallbackFunction<unknown, unknown>;
  readonly name: string;
}

/**
 * Defines a Lambda and returns a handle a flow can call.
 *
 * ```ts
 * const lookupCustomer = connectLambda("lookupCustomer", {
 *   handler: async (input: { phone: string }): Promise<{ tier: string }> => {
 *     return { tier: lookUpTier(input.phone) };
 *   },
 * });
 *
 * // inside a flow
 * const customer = lookupCustomer({ phone: system.customerEndpoint.address });
 * setAttributes({ tier: customer.tier });   // customer.tier is Ref<string>
 * ```
 *
 * The association with the Connect instance and the invoke permission are created by
 * {@link ContactFlow} for whichever Lambdas the flow actually calls, so there is nothing to wire up
 * by hand.
 */
export function connectLambda<In extends InvocationInput, Out extends StringMap>(
  name: string,
  options: StringMapLambdaOptions<In, Out>,
): ConnectLambda<In, Out>;
export function connectLambda<In extends InvocationInput, Out>(
  name: string,
  options: JsonLambdaOptions<In, Out>,
): ConnectLambda<In, Out>;
export function connectLambda<In extends InvocationInput>(
  name: string,
  options: AsyncLambdaOptions<In>,
): AsyncConnectLambda<In>;
export function connectLambda<In extends InvocationInput, Out>(
  name: string,
  options:
    | StringMapLambdaOptions<In, Out & StringMap>
    | JsonLambdaOptions<In, Out>
    | AsyncLambdaOptions<In>,
): ConnectLambda<In, Out> | AsyncConnectLambda<In> {
  const asynchronous = "invocationType" in options && options.invocationType === "ASYNCHRONOUS";
  const responseType =
    ("responseType" in options ? options.responseType : undefined) ?? "STRING_MAP";
  const timeoutSeconds = options.timeoutSeconds ?? 8;
  const handler = options.handler as ConnectHandler<unknown, unknown>;

  const fn = new aws.lambda.CallbackFunction<unknown, unknown>(name, {
    // Give the function room to finish even though Connect stops waiting at 8 seconds, so a slow
    // invocation still completes its side effects instead of being killed mid-write.
    timeout: 30,
    // Pulumi bundles the project's dependencies alongside the serialized closure, and these four are
    // deploy-time only — they build the flow, they never run inside it. Left in, the archive exceeds
    // Lambda's 70MB CreateFunction limit on a hello-world handler, because `@pulumi/aws-native` and
    // `@pulumi/aws` are ~80MB each. Anything the handler genuinely imports is still included.
    codePathOptions: {
      extraExcludePackages: [
        "pulumi-amazon-connect",
        "@pulumi/aws-native",
        "@pulumi/aws",
        "@pulumi/pulumi",
      ],
    },
    ...options.functionOptions,
    // Passed through untouched: the handler is the Lambda handler, and Connect's event reaches it
    // exactly as sent. Bound to a local so Pulumi's closure serializer captures the function rather
    // than the whole options object.
    callback: handler as aws.lambda.Callback<unknown, unknown>,
  });

  const invoke = (input: DynamicInput<In>, invokeOptions: InvokeOptions = {}) => {
    const recorder = currentRecorder();
    recorder.registerLambda({ name, resource: fn });

    // Rendered before the slot changes hands, because Connect resolves the parameters and only then
    // invokes: passing the previous Lambda's result straight into this one is the chained call, not
    // a stale read.
    const attributes = Object.fromEntries(
      Object.entries(input).map(([key, value]) => [key, renderValue(value)]),
    );

    // Connect replaces `$.External` wholesale on every invocation, so the references an earlier one
    // handed back stop meaning what they said the moment this one is recorded. Claimed before the
    // action, which puts the invocation's own error handler on the far side of that too: it runs
    // because this call failed, so nothing in the slot is readable there either.
    const tenancy = asynchronous
      ? undefined
      : recorder.fill(LAMBDA_RESULT, `Lambda ${JSON.stringify(name)}`);

    recordAction({
      type: "InvokeLambdaFunction",
      hint: `invoke-${name}`,
      parameters: {
        // The ARN is not known until Pulumi resolves it, so a token stands in until ContactFlow
        // substitutes the real value inside an apply().
        LambdaFunctionARN: recorder.defer(fn.arn),
        InvocationTimeLimitSeconds: String(timeoutSeconds),
        // Console exports always carry this. The flow waits for the result either way, but matching
        // what the console emits keeps hand-edited and generated flows comparable.
        InvocationType: asynchronous ? "ASYNCHRONOUS" : "SYNCHRONOUS",
        LambdaInvocationAttributes: attributes,
        ResponseValidation: { ResponseType: responseType },
      },
      requiredErrors: [NO_MATCHING_ERROR],
      outcomes: { [NO_MATCHING_ERROR]: invokeOptions.onError },
    });

    // An asynchronous invocation populates nothing, so there is nothing to hand back.
    return tenancy === undefined ? undefined : externalRefs<Out>(tenancy);
  };

  // defineProperties, not Object.assign: a function's own `name` is non-writable, so assigning to
  // it throws in strict mode.
  return Object.defineProperties(invoke, {
    function: { value: fn, enumerable: true },
    name: { value: name, enumerable: true },
  }) as ConnectLambda<In, Out> & AsyncConnectLambda<In>;
}

/**
 * Every property read becomes a reference to `$.External.<key>`, tied to this invocation.
 *
 * A proxy rather than a fixed object because the handler's return type exists only at compile time —
 * there is no runtime list of keys to enumerate.
 */
function externalRefs<Out>(tenancy: Tenancy): ExternalRefs<Out> {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        return volatileRef(`$.External.${property}`, tenancy);
      },
    },
  ) as ExternalRefs<Out>;
}

/** The ARN of the Connect instance a Lambda must be associated with before a flow may call it. */
export type InstanceArn = pulumi.Input<string>;
