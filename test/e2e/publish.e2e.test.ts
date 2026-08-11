/**
 * End-to-end verification against a real Amazon Connect instance.
 *
 * `CreateContactFlow` performs full server-side validation, so publishing is the only way to know
 * that emitted JSON is actually correct — the published AWS reference has been wrong about nine
 * shapes, every one of them caught here rather than by the docs or the offline tests.
 *
 * Opt-in: does nothing unless `CONNECT_E2E_INSTANCE_ID` is set, so `npm test` stays offline.
 *
 *   CONNECT_E2E_INSTANCE_ID=<sandbox-instance-id> npm run test:e2e
 *
 * Point it at a non-production instance. It creates flows named `zz-e2e-*` and deletes them again,
 * but it is still writing to a live contact center.
 */

import {
  ConnectClient,
  CreateContactFlowCommand,
  CreateContactFlowModuleCommand,
  DeleteContactFlowCommand,
  DeleteContactFlowModuleCommand,
  DescribeContactFlowCommand,
  DescribeContactFlowModuleCommand,
  InvalidContactFlowException,
  ListContactFlowsCommand,
  ListQueuesCommand,
} from "@aws-sdk/client-connect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  disconnect,
  endFlowModule,
  type FlowJson,
  invokeFlowModule,
  moduleInputRefs,
  moduleSettingsJson,
  play,
  setAttributes,
  setFlowAttributes,
  system,
} from "../../src/index.js";
import { recordFlow } from "../../src/testing/index.js";
import { type E2eContext, fixtures } from "./fixtures.js";

const instanceId = process.env.CONNECT_E2E_INSTANCE_ID;
const region = process.env.AWS_REGION ?? process.env.CONNECT_E2E_REGION ?? "us-east-1";

/** Prefix every created flow, so anything left behind by a crash is obvious and easy to sweep. */
const PREFIX = "zz-e2e-";

const client = new ConnectClient({ region });
const created: string[] = [];
const createdModules: string[] = [];

/** Publishing is the assertion, so failures need the `problems` list the CLI hides. */
async function publish(name: string, type: string, flow: FlowJson): Promise<string> {
  try {
    const result = await client.send(
      new CreateContactFlowCommand({
        InstanceId: instanceId,
        Name: `${PREFIX}${name}`,
        Type: type as never,
        Description: "Temporary end-to-end verification. Safe to delete.",
        Content: JSON.stringify(flow),
      }),
    );
    const id = result.ContactFlowId as string;
    created.push(id);
    return id;
  } catch (error) {
    if (error instanceof InvalidContactFlowException) {
      const problems = (error.problems ?? []).map((p) => `  - ${p.message}`).join("\n");
      throw new Error(`Amazon Connect rejected ${name}:\n${problems || "  (no detail returned)"}`);
    }
    throw error;
  }
}

describe.skipIf(!instanceId)("published to a live Connect instance", () => {
  let ctx: E2eContext;

  beforeAll(async () => {
    // Discovered rather than configured, so the only thing to set up is the instance id.
    const queues = await client.send(
      new ListQueuesCommand({ InstanceId: instanceId, QueueTypes: ["STANDARD"] }),
    );
    const queueArn = queues.QueueSummaryList?.[0]?.Arn;
    if (queueArn === undefined) {
      throw new Error(`Instance ${instanceId} has no standard queue to route to.`);
    }

    const flows = await client.send(new ListContactFlowsCommand({ InstanceId: instanceId }));
    const flowArn = flows.ContactFlowSummaryList?.find((f) => !f.Name?.startsWith(PREFIX))?.Arn;
    if (flowArn === undefined) {
      throw new Error(`Instance ${instanceId} has no existing flow to reference.`);
    }

    // Every ARN in the corpus shares the instance account, so read it off the queue ARN.
    const accountId = queueArn.split(":")[4] as string;
    ctx = { queueArn, flowArn, accountId };
  }, 120_000);

  afterAll(async () => {
    // Always clean up, including after a failure part-way through.
    for (const id of created) {
      await client
        .send(new DeleteContactFlowCommand({ InstanceId: instanceId, ContactFlowId: id }))
        .catch(() => undefined);
    }
    for (const id of createdModules) {
      await client
        .send(
          new DeleteContactFlowModuleCommand({
            InstanceId: instanceId,
            ContactFlowModuleId: id,
          }),
        )
        .catch(() => undefined);
    }
  }, 120_000);

  // `CreateContactFlowModule` validates against a different schema than `CreateContactFlow` — it
  // requires a `Settings` block the flow API knows nothing about — so a module has to be published
  // for real to know the emitted JSON is accepted.
  it("accepts a flow module", async () => {
    const flow = recordFlow(
      () => {
        play("Thanks for calling.");
        endFlowModule();
      },
      { onError: () => endFlowModule(), endWith: "EndFlowModuleExecution" },
    );

    const result = await client.send(
      new CreateContactFlowModuleCommand({
        InstanceId: instanceId,
        Name: `${PREFIX}module`,
        Description: "Temporary end-to-end verification. Safe to delete.",
        Content: JSON.stringify(flow),
      }),
    );
    const id = result.Id as string;
    createdModules.push(id);

    const described = await client.send(
      new DescribeContactFlowModuleCommand({
        InstanceId: instanceId,
        ContactFlowModuleId: id,
      }),
    );
    // Lower case, unlike a contact flow's `PUBLISHED`.
    expect(described.ContactFlowModule?.Status).toBe("published");

    const stored = JSON.parse(described.ContactFlowModule?.Content as string) as FlowJson;
    expect(stored.StartAction).toBe(flow.StartAction);
    expect(stored.Actions).toHaveLength(flow.Actions.length);
  }, 300_000);

  // The contract half: input schema, output schema and custom branches, all of which the service
  // validates on both sides. Publishing the caller is what proves the two agree — `CreateContactFlow`
  // rejects an input key or a branch name the module did not declare.
  it("accepts a module with a declared contract, and a flow that invokes it", async () => {
    const settings = moduleSettingsJson({
      input: { phone: "string" },
      output: { customerId: "string" },
      branches: ["authenticated", "unauthenticated"],
    });

    const moduleFlow = recordFlow(
      () => {
        const input = moduleInputRefs<{ phone: string }>();
        setFlowAttributes({ dialed: input.phone });
        endFlowModule({ branch: "authenticated", data: { customerId: "c-1" } });
      },
      { onError: () => endFlowModule(), endWith: "EndFlowModuleExecution" },
    );

    const created = await client.send(
      new CreateContactFlowModuleCommand({
        InstanceId: instanceId,
        Name: `${PREFIX}contract-module`,
        Description: "Temporary end-to-end verification. Safe to delete.",
        Content: JSON.stringify(moduleFlow),
        Settings: settings,
      }),
    );
    const moduleId = created.Id as string;
    createdModules.push(moduleId);

    // The contract comes back on the resource, not in the content — the content's own `Settings`
    // block stays the fixed Success/Error boilerplate whatever the module declares.
    const described = await client.send(
      new DescribeContactFlowModuleCommand({
        InstanceId: instanceId,
        ContactFlowModuleId: moduleId,
      }),
    );
    expect(JSON.parse(described.ContactFlowModule?.Settings as string)).toEqual(
      JSON.parse(settings),
    );

    const callerFlow = recordFlow(
      () => {
        const result = invokeFlowModule<{ customerId: string }>(`${moduleId}:$LATEST`, {
          input: { phone: system.customerEndpoint.address },
          on: { unauthenticated: () => play("We could not verify you.") },
        });
        setAttributes({ customerId: result.customerId });
        disconnect();
      },
      { onError: () => disconnect() },
    );

    // Publishing is the assertion: the service checks the input key and the branch name against the
    // module's declaration and rejects the flow if either is wrong.
    await publish("contract-caller", "CONTACT_FLOW", callerFlow);
  }, 300_000);

  for (const fixture of fixtures) {
    it(`accepts ${fixture.name} (${fixture.type}): ${fixture.covers.length} action types`, async () => {
      const flow = recordFlow(fixture.build(ctx), {
        onError: fixture.onError,
        ...(fixture.endWith === undefined ? {} : { endWith: fixture.endWith }),
      });
      const id = await publish(fixture.name, fixture.type, flow);

      const described = await client.send(
        new DescribeContactFlowCommand({ InstanceId: instanceId, ContactFlowId: id }),
      );
      expect(described.ContactFlow?.Status).toBe("PUBLISHED");

      // Connect stores what it was given; a difference means it normalized something we should
      // know about.
      const stored = JSON.parse(described.ContactFlow?.Content as string) as FlowJson;
      expect(stored.StartAction).toBe(flow.StartAction);
      expect(stored.Actions).toHaveLength(flow.Actions.length);

      const byId = new Map(stored.Actions.map((a) => [a.Identifier, a]));
      for (const sent of flow.Actions) {
        const back = byId.get(sent.Identifier);
        expect(back, `${sent.Identifier} missing from stored flow`).toBeDefined();
        expect(back?.Parameters).toEqual(sent.Parameters);
        expect(back?.Transitions).toEqual(sent.Transitions);
      }
    }, 300_000);
  }

  it("covers every action type the library emits", () => {
    // Guards against adding an action module and never proving the service accepts it.
    const emitted = new Set<string>();
    for (const fixture of fixtures) {
      const flow = recordFlow(fixture.build(ctx), {
        onError: fixture.onError,
        ...(fixture.endWith === undefined ? {} : { endWith: fixture.endWith }),
      });
      for (const action of flow.Actions) emitted.add(action.Type);
    }

    const declared = new Set(fixtures.flatMap((f) => f.covers));
    const unproven = [...declared].filter((t) => !emitted.has(t));
    expect(unproven, "declared as covered but never emitted").toEqual([]);
  }, 120_000);
});
