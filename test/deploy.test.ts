/**
 * Exercises the deployment path under Pulumi's mock runtime.
 *
 * The rest of the suite never constructs a real resource, so `connectLambda` and `ContactFlow` were
 * only ever type-checked — which is how a `Object.assign` onto a function's read-only `name` reached
 * a live deploy. These tests run that code for real, without touching AWS.
 */

import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";
import type { ContactFlowEvent } from "../src/index.js";

pulumi.runtime.setMocks(
  {
    newResource(args: pulumi.runtime.MockResourceArgs) {
      return {
        id: `${args.name}-id`,
        state: {
          ...args.inputs,
          arn: `arn:aws:mock:us-east-1:123456789012:${args.type}/${args.name}`,
          name: args.inputs.name ?? args.name,
          // `AWS::Connect::View` returns these; the flow embeds the ARN.
          viewId: `${args.name}-view-id`,
          viewArn: `arn:aws:connect:us-east-1:123456789012:instance/i-1/view/${args.name}`,
          // `AWS::Connect::ContactFlowModule` reports only an ARN; the id is its last segment, and
          // that is what `InvokeFlowModule` embeds.
          contactFlowModuleArn: `arn:aws:connect:us-east-1:123456789012:instance/i-1/flow-module/${args.name}`,
        },
      };
    },
    call(args: pulumi.runtime.MockCallArgs) {
      return args.inputs;
    },
  },
  "project",
  "stack",
);

/** Resolves an Output without a live engine. */
function read<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => {
    output.apply((value) => {
      resolve(value);
      return value;
    });
  });
}

const INSTANCE_ID = "instance-1";
const INSTANCE_ARN = `arn:aws:connect:us-east-1:123456789012:instance/${INSTANCE_ID}`;

describe("connectLambda", () => {
  it("constructs without throwing and exposes its function and name", async () => {
    const { connectLambda } = await import("../src/index.js");

    const classify = connectLambda("classifyCaller", {
      timeoutSeconds: 5,
      handler: async (event: ContactFlowEvent<{ phone: string }>) => ({
        tier: event.Details.Parameters.phone,
      }),
    });

    // `name` is a read-only own property of every function; setting it needs defineProperty.
    expect(classify.name).toBe("classifyCaller");
    expect(classify.function).toBeDefined();
    expect(typeof classify).toBe("function");
  });
});

describe("ContactFlow", () => {
  let content: string;
  let lambdaArn: string;

  beforeAll(async () => {
    const { ContactFlow, connectLambda, disconnect, play, setAttributes, system } = await import(
      "../src/index.js"
    );

    const classify = connectLambda("classifyForFlow", {
      handler: async (event: ContactFlowEvent<{ phone: string }>) => ({
        tier: event.Details.Parameters.phone,
      }),
    });
    lambdaArn = await read(classify.function.arn);

    const built = new ContactFlow("inbound", {
      instanceId: INSTANCE_ID,
      flow: () => {
        play("hello");
        const customer = classify({ phone: system.customerEndpoint.address });
        setAttributes({ tier: customer.tier });
        disconnect();
      },
      onError: () => disconnect(),
    });

    content = await read(built.content);
  });

  it("substitutes the Lambda ARN for its placeholder token", () => {
    // While recording, the ARN is an unresolved Output, so the recorder embeds a token. This is the
    // one place that token has to become a real value.
    expect(content).not.toMatch(/__PULUMI_OUTPUT_/);
    expect(content).toContain(lambdaArn);

    const flow = JSON.parse(content) as {
      Actions: Array<{ Type: string; Parameters: Record<string, unknown> }>;
    };
    const invoke = flow.Actions.find((a) => a.Type === "InvokeLambdaFunction");
    expect(invoke?.Parameters.LambdaFunctionARN).toBe(lambdaArn);
    expect(invoke?.Parameters.InvocationType).toBe("SYNCHRONOUS");
  });

  it("passes flow values to the Lambda as invocation attributes", () => {
    const flow = JSON.parse(content) as {
      Actions: Array<{ Type: string; Parameters: Record<string, unknown> }>;
    };
    const invoke = flow.Actions.find((a) => a.Type === "InvokeLambdaFunction");
    expect(invoke?.Parameters.LambdaInvocationAttributes).toEqual({
      phone: "$.CustomerEndpoint.Address",
    });
  });

  it("emits valid flow JSON", () => {
    const flow = JSON.parse(content) as {
      Version: string;
      StartAction: string;
      Actions: unknown[];
    };
    expect(flow.Version).toBe("2019-10-30");
    expect(flow.Actions.length).toBeGreaterThan(0);
    expect(flow.StartAction).toBeTruthy();
  });
});

describe("ConnectView", () => {
  it("deploys the view and substitutes its ARN into the flow that shows it", async () => {
    const {
      ContactFlow,
      ConnectView,
      Container,
      FormInput,
      SubmitButton,
      Form,
      defineView,
      disconnect,
      setAttributes,
      shape,
    } = await import("../src/index.js");

    const nicknamePrompt = defineView({
      title: "Nickname",
      actions: ["Submit"],
      outputs: shape<{ nickname: string }>(),
      body: ({ actions, fields }) =>
        Container({}, [
          Form({}, [
            FormInput({ name: fields.nickname, label: "What should we call you?" }),
            SubmitButton({ label: "Continue", action: actions.Submit }),
          ]),
        ]),
    });

    const view = new ConnectView("nickname", {
      instanceArn: `arn:aws:connect:us-east-1:123456789012:instance/${INSTANCE_ID}`,
      view: nicknamePrompt,
    });

    const flow = new ContactFlow("chat", {
      instanceId: INSTANCE_ID,
      flow: () => {
        view.show({
          on: {
            Submit: (result) => setAttributes({ nickname: result.nickname }),
          },
        });
        disconnect();
      },
      onError: () => disconnect(),
    });

    // Recording cannot know the ARN, so the emitted JSON holds a token until Pulumi resolves it.
    const emitted = flow.emitted.Actions.find((a) => a.Type === "ShowView") as
      | { Parameters: { ViewResource: { Id: string } } }
      | undefined;
    expect(emitted?.Parameters.ViewResource.Id).toMatch(/^__PULUMI_OUTPUT_\d+__:\$LATEST$/);

    // ...and the deployed content holds the real one, qualified the way console exports are.
    const content = JSON.parse(await read(flow.content)) as {
      Actions: Array<{ Type: string; Parameters: { ViewResource?: { Id: string } } }>;
    };
    const shown = content.Actions.find((a) => a.Type === "ShowView");
    expect(shown?.Parameters.ViewResource?.Id).toBe(
      "arn:aws:connect:us-east-1:123456789012:instance/i-1/view/nickname:$LATEST",
    );

    expect(await read(view.viewId)).toBe("nickname-view-id");
  });
});

describe("references to peer resources", () => {
  it("substitutes a peer flow's ARN, passed as an output or as the resource", async () => {
    const { ContactFlow, disconnect, play, setEventFlow, transferToFlow } = await import(
      "../src/index.js"
    );

    // The flow other flows point at. Its ARN does not exist yet, which is the whole problem.
    const queueFlow = new ContactFlow("queue-flow", {
      instanceId: INSTANCE_ID,
      type: "CUSTOMER_QUEUE",
      flow: () => play("Thanks for waiting."),
      onError: () => play("Sorry."),
    });

    const inbound = new ContactFlow("inbound-peer", {
      instanceId: INSTANCE_ID,
      flow: () => {
        // As an output...
        setEventFlow("CustomerQueue", queueFlow.arn);
        // ...and as the resource itself, which carries one.
        transferToFlow(queueFlow);
        disconnect();
      },
      onError: () => disconnect(),
    });

    const content = JSON.parse(await read(inbound.content)) as {
      Actions: Array<{ Type: string; Parameters: Record<string, unknown> }>;
    };

    const expected =
      "arn:aws:mock:us-east-1:123456789012:aws:connect/contactFlow:ContactFlow/queue-flow";

    const hooks = content.Actions.find((a) => a.Type === "UpdateContactEventHooks") as
      | { Parameters: { EventHooks: Record<string, string> } }
      | undefined;
    expect(hooks?.Parameters.EventHooks).toEqual({
      CustomerQueue: expected,
    });

    const transfer = content.Actions.find((a) => a.Type === "TransferToFlow");
    expect(transfer?.Parameters.ContactFlowId).toBe(expected);
  });
});

describe("ContactFlowModule", () => {
  it("ends a run-off-the-end branch by returning to the caller, not by disconnecting", async () => {
    const { ContactFlowModule, endFlowModule, play, setFlowAttributes } = await import(
      "../src/index.js"
    );

    const authenticate = new ContactFlowModule("authenticate", {
      instanceArn: INSTANCE_ARN,
      flow: () => {
        play("Authenticating.");
        setFlowAttributes({ authenticated: "true" });
      },
      onError: () => {
        play("Sorry.");
        endFlowModule();
      },
    });

    const types = authenticate.emitted.Actions.map((a) => a.Type);
    // Neither terminal a flow uses is legal inside a module.
    expect(types).not.toContain("DisconnectParticipant");
    expect(types).not.toContain("EndFlowExecution");
    expect(types).toContain("EndFlowModuleExecution");
  });

  it("carries the Settings block a module needs and a flow must not have", async () => {
    const { ContactFlow, ContactFlowModule, disconnect, endFlowModule, play } = await import(
      "../src/index.js"
    );

    const module = new ContactFlowModule("settings-module", {
      instanceArn: INSTANCE_ARN,
      flow: () => {
        play("Hello.");
        endFlowModule();
      },
      onError: () => endFlowModule(),
    });

    // Without this, CreateContactFlowModule rejects the content outright. The shape is what the
    // console writes into every module, custom branches or not.
    expect(module.emitted.Settings).toEqual({
      InputParameters: [],
      OutputParameters: [],
      Transitions: [
        { DisplayName: "Success", ReferenceName: "Success", Description: "" },
        { DisplayName: "Error", ReferenceName: "Error", Description: "" },
      ],
    });

    const flow = new ContactFlow("settings-flow", {
      instanceId: INSTANCE_ID,
      flow: () => disconnect(),
      onError: () => disconnect(),
    });
    expect(flow.emitted.Settings).toBeUndefined();
  });

  it("substitutes its id, qualified, into the flow that invokes it", async () => {
    const { ContactFlow, ContactFlowModule, disconnect, endFlowModule, play } = await import(
      "../src/index.js"
    );

    const greeting = new ContactFlowModule("greeting", {
      instanceArn: INSTANCE_ARN,
      flow: () => {
        play("Thanks for calling.");
        endFlowModule();
      },
      onError: () => endFlowModule(),
    });

    const inbound = new ContactFlow("inbound-module-caller", {
      instanceId: INSTANCE_ID,
      flow: () => {
        greeting.invoke({ onNoMatch: () => play("Nothing came back.") });
        disconnect();
      },
      onError: () => disconnect(),
    });

    // Recording cannot know the id, so the emitted JSON holds a token until Pulumi resolves it.
    const emitted = inbound.emitted.Actions.find((a) => a.Type === "InvokeFlowModule");
    expect(emitted?.Parameters.FlowModuleId).toMatch(/^__PULUMI_OUTPUT_\d+__:\$LATEST$/);

    const content = JSON.parse(await read(inbound.content)) as {
      Actions: Array<{ Type: string; Parameters: Record<string, unknown> }>;
    };
    const invoke = content.Actions.find((a) => a.Type === "InvokeFlowModule");
    expect(invoke?.Parameters.FlowModuleId).toBe("greeting:$LATEST");

    expect(await read(greeting.moduleId)).toBe("greeting");
  });

  it("carries its contract on the resource, not in the content", async () => {
    const { ContactFlowModule, endFlowModule } = await import("../src/index.js");

    const authenticate = new ContactFlowModule("contract-module", {
      instanceArn: INSTANCE_ARN,
      input: { phone: "string", attempts: "number" },
      output: { customerId: "string" },
      branches: ["authenticated", "unauthenticated"],
      flow: ({ end }) => end({ branch: "authenticated", data: { customerId: "c-1" } }),
      onError: () => endFlowModule(),
    });

    // Lower camel case, `resultData` rather than "output", and JSON Schema inside — none of which
    // matches the content-level block above.
    expect(JSON.parse(authenticate.settings)).toEqual({
      input: {
        schema: {
          type: "object",
          properties: { phone: { type: "string" }, attempts: { type: "number" } },
        },
      },
      resultData: {
        schema: { type: "object", properties: { customerId: { type: "string" } } },
      },
      transitions: {
        results: [
          { name: "authenticated", description: "" },
          { name: "unauthenticated", description: "" },
        ],
      },
    });

    const end = authenticate.emitted.Actions.find((a) => a.Type === "EndFlowModuleExecution");
    expect(end?.Parameters).toEqual({ Result: "authenticated", ResultData: { customerId: "c-1" } });
  });

  it("passes input and branches on the declared results at the call site", async () => {
    const { ContactFlow, ContactFlowModule, attr, disconnect, endFlowModule, play, setAttributes } =
      await import("../src/index.js");

    const authenticate = new ContactFlowModule("auth-callsite", {
      instanceArn: INSTANCE_ARN,
      input: { phone: "string" },
      output: { customerId: "string" },
      branches: ["authenticated", "unauthenticated"],
      flow: ({ input, end }) => end({ branch: "authenticated", data: { customerId: input.phone } }),
      onError: () => endFlowModule(),
    });

    const inbound = new ContactFlow("inbound-contract", {
      instanceId: INSTANCE_ID,
      flow: () => {
        const result = authenticate.invoke({
          data: { phone: attr("caller_phone") },
          on: { unauthenticated: () => play("We could not verify you.") },
        });
        setAttributes({ customerId: result.customerId });
        disconnect();
      },
      onError: () => disconnect(),
    });

    const invoke = inbound.emitted.Actions.find((a) => a.Type === "InvokeFlowModule");
    // A ref renders as its path, which is legal because `phone` is declared a string.
    expect(invoke?.Parameters.Input).toEqual({ phone: "$.Attributes.caller_phone" });
    // Only the handled branch becomes a condition; the rest fall through to what follows.
    expect(invoke?.Transitions.Conditions).toEqual([
      {
        NextAction: expect.any(String),
        Condition: { Operator: "Equals", Operands: ["unauthenticated"] },
      },
    ]);

    // The caller reads the module's output from the namespace the module filled.
    const set = inbound.emitted.Actions.find((a) => a.Type === "UpdateContactAttributes");
    const attributes = set?.Parameters.Attributes as Record<string, string> | undefined;
    expect(attributes?.customerId).toBe("$.Modules.ResultData.customerId");
  });

  it("rejects a return through a branch the module never declared", async () => {
    const { ContactFlowModule } = await import("../src/index.js");

    expect(
      () =>
        new ContactFlowModule("bad-branch", {
          instanceArn: INSTANCE_ARN,
          branches: ["yes"],
          flow: ({ end }) => end({ branch: "no" as "yes" }),
          onError: () => {},
        }),
    ).toThrow(/has no branch "no".*Declared: yes/s);
  });
});
