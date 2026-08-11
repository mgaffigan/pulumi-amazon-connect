/** @jsxImportSource pulumi-amazon-connect */

/**
 * End-to-end verification that a JSX-authored view is a real view.
 *
 * The unit tests prove JSX and the functional API build the same tree; this proves that tree is one
 * Connect actually accepts, and that the inputs a JSX body references still reach the derived
 * `InputSchema`. Opt-in, same as the other suites:
 *
 *   CONNECT_E2E_INSTANCE_ID=<sandbox-instance-id> npm run test:e2e
 */

import { ConnectClient, CreateViewCommand, DeleteViewCommand } from "@aws-sdk/client-connect";
import { afterAll, describe, expect, it } from "vitest";
import {
  AttributeBar,
  Button,
  Container,
  defineView,
  Form,
  FormInput,
  shape,
  SubmitButton,
  TextBox,
  toViewInputContent,
} from "../../src/index.js";

const instanceId = process.env.CONNECT_E2E_INSTANCE_ID;
const region = process.env.AWS_REGION ?? process.env.CONNECT_E2E_REGION ?? "us-east-1";

const client = new ConnectClient({ region });
const created: string[] = [];

interface RefillInputs {
  customerName: string;
  prescription: string;
}

describe.skipIf(!instanceId)("a JSX-authored view", () => {
  afterAll(async () => {
    for (const id of created) {
      await client
        .send(new DeleteViewCommand({ InstanceId: instanceId, ViewId: id }))
        .catch(() => undefined);
    }
  }, 120_000);

  it("publishes, and its inputs survive into the derived schema", async () => {
    const view = defineView({
      title: "Confirm refill",
      actions: ["Confirm", "Skip"],
      inputs: shape<RefillInputs>(),
      body: ({ inputs, actions }) => (
        <Container>
          <TextBox variant="h2">Confirm refill</TextBox>
          <TextBox>{["Hello ", inputs.customerName, ", please confirm."]}</TextBox>
          <AttributeBar attributes={[{ label: "Prescription", value: inputs.prescription }]} />
          <Form>
            <FormInput name="notes" label="Notes" inputType="text" />
            <SubmitButton label="Confirm" action={actions.Confirm} />
          </Form>
          <Button action={actions.Skip} variant="normal">
            Skip
          </Button>
        </Container>
      ),
    });

    expect(view.fields).toEqual(["notes"]);

    const result = await client
      .send(
        new CreateViewCommand({
          InstanceId: instanceId,
          Name: `zz-e2e-view-jsx-${Date.now()}`,
          Status: "PUBLISHED",
          Description: "Temporary end-to-end verification. Safe to delete.",
          Content: toViewInputContent(view),
        }),
      )
      .catch((error: { Message?: string; message?: string }) => {
        throw new Error(
          `Amazon Connect rejected the JSX-authored view:\n  ${String(
            error.Message ?? error.message,
          ).slice(0, 900)}`,
        );
      });

    const id = result.View?.Id;
    if (id) created.push(id);

    // Both references were whole property values or whole content items, so Connect declares them.
    const schema = JSON.parse(result.View?.Content?.InputSchema ?? "{}");
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["customerName", "prescription"]);
    expect(result.View?.Content?.Actions).toEqual(["Confirm", "Skip"]);
  }, 120_000);
});
