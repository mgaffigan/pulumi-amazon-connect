/**
 * Deployment: a recorded flow becomes an `aws-native.connect.ContactFlowModule`, invocable from any flow.
 *
 * A module is a function: it takes an input object, returns an output object, and exits through one
 * of its declared branches. That contract does not live in the flow-language content — it is a JSON
 * Schema on the resource itself, which is why this reaches for `@pulumi/aws-native`. The classic
 * `aws` provider's `ContactFlowModule` has only `content`, so it cannot express a module that takes
 * parameters at all. Same reason `ConnectView` reaches for `aws-native`.
 *
 * The resource is invocable itself, which is the point: a module deployed here has no id until
 * Pulumi creates it, and `invoke` embeds a deferred token that the calling `ContactFlow` resolves.
 * Because both halves are declared in one program, the input a caller passes and the branches it
 * handles are checked against this declaration at compile time — Connect checks them again at
 * publish time, and rejects the flow if they disagree.
 */

import * as awsNative from "@pulumi/aws-native";
import * as pulumi from "@pulumi/pulumi";
import type { OutcomeHandler } from "../flow/actions/action.js";
import {
  endFlowModule,
  invokeFlowModule,
  type ModuleResultHandler,
  type ModuleValue,
} from "../flow/actions/modules.js";
import {
  type ModuleContract,
  type ModuleData,
  type ModuleInput,
  type ModuleSchema,
  moduleSettingsJson,
} from "../flow/moduleContract.js";
import type { FlowFragment } from "../flow/recorder.js";
import { type ModuleRefs, moduleInputRefs } from "../flow/refs.js";
import type { FlowJson } from "../flow/types.js";
import { associateLambdas, recordContent } from "./content.js";

/** An empty schema, so a module that declares no input requires no `data` at its call sites. */
export type NoFields = Record<string, never>;

/** Stands in when the caller gives no description, which Connect will not let us leave empty. */
const DEFAULT_DESCRIPTION = "No description set";

/**
 * What a module's body is handed: its input, and the typed way to return from it.
 *
 * `end` is preferred over the free `endFlowModule` inside a declared module, because it is the only
 * form that knows which branches exist and what the output schema is.
 */
export interface ModuleBody<In extends ModuleSchema, Out extends ModuleSchema, B extends string> {
  /** References into `$.Modules.Input`, shaped like the declared input. */
  input: ModuleRefs<ModuleData<In>>;
  /** Returns to the caller, optionally through a declared branch and with the declared output. */
  end(options?: { branch?: B; data?: ModuleInput<Out> }): void;
}

export interface ContactFlowModuleArgs<
  In extends ModuleSchema = NoFields,
  Out extends ModuleSchema = NoFields,
  B extends string = never,
> {
  /**
   * The Connect instance ARN.
   *
   * An ARN rather than the id, because that is what `AWS::Connect::ContactFlowModule` requires. The
   * id it also needs — for the Lambda associations — is read off the end of it.
   */
  instanceArn: pulumi.Input<string>;
  /** Defaults to the Pulumi resource name. */
  name?: pulumi.Input<string>;
  /**
   * Defaults to a placeholder, and an empty one is replaced by it.
   *
   * Connect reports a module with no description as `Description: ""`, which its own resource
   * schema rejects — and Cloud Control validates the whole model on every update, not just the
   * fields being changed. A module deployed without a description can therefore never be updated
   * again, so this never sends one that is empty.
   */
  description?: pulumi.Input<string>;
  tags?: pulumi.Input<Array<pulumi.Input<awsNative.types.input.TagArgs>>>;
  /**
   * The input the module accepts, as a field map: `{ phone: "string", attempts: "number" }`.
   *
   * Declared at runtime rather than as a type witness because Connect stores it as a JSON Schema,
   * and TypeScript types are erased. One declaration gives both.
   */
  input?: In;
  /** The output the module returns, in the same form. */
  output?: Out;
  /**
   * The branches the module can exit through, beyond the error vertex. At most eight.
   *
   * Write them `as const` — or inline — so they infer as a union rather than `string[]`.
   */
  branches?: readonly B[];
  /** The module itself: an ordinary function, handed its input and its return. */
  flow: (module: ModuleBody<In, Out, B>) => void;
  /**
   * Handles the error vertex of any action not covered by a nearer `onError`.
   *
   * Required for the same reason it is on a flow: most actions can fail and Connect needs every
   * declared error to name a destination. A module's handler usually ends by returning, handing
   * control back to the caller, which can then take its own no-match branch.
   */
  onError: FlowFragment;
  /**
   * Which version of the module a flow invokes. Defaults to `$LATEST`.
   *
   * `$LATEST` is what console-exported flows reference.
   */
  moduleVersion?: string | number;
}

/** Arguments to {@link ContactFlowModule.invoke}, with `data` required only when input is declared. */
export type InvokeArgs<In extends ModuleSchema, Out extends ModuleSchema, B extends string> = {
  /**
   * Handlers for the branches that should do something different.
   *
   * Partial, like a view's actions: a branch with no handler continues with whatever follows the
   * call, which is what keeps a sequence of module calls reading as a sequence of statements.
   */
  on?: Partial<Record<B, ModuleResultHandler<ModuleData<Out>>>>;
  /** Runs when the module returned through no branch the caller handles. */
  onNoMatch?: OutcomeHandler;
  onError?: OutcomeHandler;
} & (NoFields extends In ? { data?: ModuleInput<In> } : { data: ModuleInput<In> });

/**
 * A flow module authored in TypeScript.
 *
 * ```ts
 * const authenticate = new ContactFlowModule("authenticate", {
 *   instanceArn: instance.arn,
 *   input: { phone: "string" },
 *   output: { customerId: "string" },
 *   branches: ["authenticated", "unauthenticated"],
 *   flow: ({ input, end }) => {
 *     const customer = lookup({ phone: input.phone });
 *     end({ branch: "authenticated", data: { customerId: customer.id } });
 *   },
 *   onError: () => endFlowModule(),
 * });
 *
 * // inside a flow
 * const result = authenticate.invoke({
 *   data: { phone: system.customerEndpoint.address },
 *   on: { unauthenticated: () => play("We could not verify you.") },
 * });
 * setAttributes({ customerId: result.customerId });
 * ```
 */
export class ContactFlowModule<
  In extends ModuleSchema = NoFields,
  Out extends ModuleSchema = NoFields,
  B extends string = never,
> extends pulumi.ComponentResource {
  /** The generated flow-language JSON, resolved once Pulumi knows every referenced ARN. */
  readonly content: pulumi.Output<string>;
  readonly contactFlowModule: awsNative.connect.ContactFlowModule;
  readonly moduleId: pulumi.Output<string>;
  readonly arn: pulumi.Output<string>;
  /** The declared branches, in declaration order. */
  readonly branches: readonly B[];
  /** The emitted flow, for tests and tooling that want to inspect it without deploying. */
  readonly emitted: FlowJson;
  /** The contract as Connect stores it: a JSON string on the resource, not in the content. */
  readonly settings: string;

  private readonly moduleVersion: string | number;

  constructor(
    name: string,
    args: ContactFlowModuleArgs<In, Out, B>,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("pulumi-amazon-connect:index:ContactFlowModule", name, {}, opts);

    const contract: ModuleContract = {
      ...(args.input === undefined ? {} : { input: args.input }),
      ...(args.output === undefined ? {} : { output: args.output }),
      ...(args.branches === undefined ? {} : { branches: args.branches }),
    };
    this.settings = moduleSettingsJson(contract);
    this.branches = args.branches ?? [];

    const declared = new Set<string>(this.branches);
    const body: ModuleBody<In, Out, B> = {
      input: moduleInputRefs<ModuleData<In>>(),
      end: (options = {}) => {
        // Caught here rather than at deploy time, where the service reports it without naming the
        // module. The type already rejects an undeclared branch; this covers the untyped call.
        if (options.branch !== undefined && !declared.has(options.branch)) {
          throw new Error(
            `Flow module ${JSON.stringify(name)} has no branch ${JSON.stringify(options.branch)}. ` +
              (declared.size === 0
                ? "It declares none — add a `branches` list."
                : `Declared: ${[...declared].join(", ")}.`),
          );
        }
        endFlowModule({
          ...(options.branch === undefined ? {} : { branch: options.branch }),
          ...(options.data === undefined
            ? {}
            : { data: options.data as Record<string, ModuleValue> }),
        });
      },
    };

    // A branch with nothing after it returns to the caller. Neither `DisconnectParticipant` nor
    // `EndFlowExecution` is legal in a module, so this is the only terminal available.
    const recorded = recordContent(() => args.flow(body), args.onError, "EndFlowModuleExecution");

    this.emitted = recorded.emitted;
    this.content = recorded.content;
    this.moduleVersion = args.moduleVersion ?? "$LATEST";

    this.contactFlowModule = new awsNative.connect.ContactFlowModule(
      name,
      {
        instanceArn: args.instanceArn,
        name: args.name ?? name,
        content: this.content,
        // Omitted entirely when there is no contract: the console writes `{}`, and so does the
        // serializer, but a module that declares nothing reads better without the field.
        ...(this.settings === "{}" ? {} : { settings: this.settings }),
        // Never omitted and never empty — see `ContactFlowModuleArgs.description`.
        description: pulumi
          .output(args.description)
          .apply((text) => (text?.trim() ? text : DEFAULT_DESCRIPTION)),
        ...(args.tags === undefined ? {} : { tags: args.tags }),
      },
      { parent: this },
    );

    // A module's Lambdas are its own: the association is per instance, but declaring it here keeps
    // the module self-contained, so a flow that invokes it needs to know nothing about them.
    associateLambdas(this, name, instanceIdOf(args.instanceArn), recorded.lambdas);

    this.arn = this.contactFlowModule.contactFlowModuleArn;
    // The resource reports only its ARN, and `InvokeFlowModule` wants the bare id with a version
    // qualifier — which is what every console export carries.
    this.moduleId = this.arn.apply(lastSegment);

    this.registerOutputs({ content: this.content, moduleId: this.moduleId, arn: this.arn });
  }

  /**
   * Invokes the module from a flow, returning references to what it returned.
   *
   * The id is a Pulumi output, so this embeds a deferred token that `ContactFlow` substitutes once
   * Pulumi knows the real value — the version qualifier is appended to it, which is the form
   * `InvokeFlowModule` expects.
   */
  invoke(args: InvokeArgs<In, Out, B> = {} as InvokeArgs<In, Out, B>): ModuleRefs<ModuleData<Out>> {
    const { data, on } = args as InvokeArgs<In, Out, B> & {
      data?: ModuleInput<In>;
      on?: Partial<Record<B, ModuleResultHandler<ModuleData<Out>>>>;
    };

    const handlers: Record<string, ModuleResultHandler<ModuleData<Out>>> = {};
    for (const [branch, handler] of Object.entries(on ?? {})) {
      handlers[branch] = handler as ModuleResultHandler<ModuleData<Out>>;
    }

    return invokeFlowModule<ModuleData<Out>>(this.moduleId, {
      moduleVersion: this.moduleVersion,
      ...(data === undefined ? {} : { input: data as Record<string, ModuleValue> }),
      on: handlers,
      ...(args.onNoMatch === undefined ? {} : { onNoMatch: args.onNoMatch }),
      ...(args.onError === undefined ? {} : { onError: args.onError }),
    });
  }
}

/** `arn:…:instance/<id>` and `arn:…/flow-module/<id>` both put the id last. */
function lastSegment(arn: string): string {
  return arn.slice(arn.lastIndexOf("/") + 1);
}

/** The Lambda association takes an instance id, and only the ARN was supplied. */
function instanceIdOf(instanceArn: pulumi.Input<string>): pulumi.Output<string> {
  return pulumi.output(instanceArn).apply(lastSegment);
}
