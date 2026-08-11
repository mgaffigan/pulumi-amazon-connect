/**
 * End-to-end verification for authored views.
 *
 * `CreateView` with `Status: PUBLISHED` runs full content validation — Connect checks the template with
 * AJV and enforces `additionalProperties: false` per component — so publishing is the only way to know
 * a component and its props are real. It also returns the `InputSchema` it derives from the template's
 * `$.` references, which is how the reference rules below were established.
 *
 * Opt-in, same as the flow suite:
 *
 *   CONNECT_E2E_INSTANCE_ID=<sandbox-instance-id> npm run test:e2e
 */

import {
  ConnectClient,
  CreateViewCommand,
  DeleteViewCommand,
  UpdateViewContentCommand,
  UpdateViewMetadataCommand,
} from "@aws-sdk/client-connect";
import { afterAll, describe, expect, it } from "vitest";
import {
  Alert,
  Application,
  AttributeBar,
  AttributeSection,
  Button,
  ButtonGroup,
  Card,
  CheckboxGroup,
  Container,
  DatePicker,
  Dropdown,
  defineView,
  Form,
  FormInput,
  Header,
  Icon,
  Image,
  Link,
  Loader,
  RadioGroup,
  Section,
  SubmitButton,
  shape,
  Table,
  TextArea,
  TextBox,
  TimePicker,
  Toggle,
  toViewInputContent,
  type ViewContent,
} from "../../src/index.js";

/** As much of a derived `InputSchema` as the assertions below read. */
interface JsonSchema {
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: unknown;
}

const instanceId = process.env.CONNECT_E2E_INSTANCE_ID;
const region = process.env.AWS_REGION ?? process.env.CONNECT_E2E_REGION ?? "us-east-1";
const PREFIX = "zz-e2e-view-";

const client = new ConnectClient({ region });
const created: string[] = [];

/** Publishes a view and returns the input schema Connect derived from it. */
async function publish(name: string, content: ViewContent): Promise<Record<string, unknown>> {
  const wire = toViewInputContent(content);
  try {
    const result = await client.send(
      new CreateViewCommand({
        InstanceId: instanceId,
        // View names allow a narrow character set, and must be unique per instance.
        Name: `${PREFIX}${name}-${Date.now()}`,
        Status: "PUBLISHED",
        Description: "Temporary end-to-end verification. Safe to delete.",
        Content: wire,
      }),
    );
    const id = result.View?.Id;
    if (id) created.push(id);
    return JSON.parse(result.View?.Content?.InputSchema ?? "{}");
  } catch (error) {
    const message = String((error as { Message?: string }).Message ?? (error as Error).message);
    throw new Error(`Amazon Connect rejected view ${name}:\n  ${message.slice(0, 900)}`);
  }
}

describe.skipIf(!instanceId)("published views", () => {
  afterAll(async () => {
    for (const id of created) {
      await client
        .send(new DeleteViewCommand({ InstanceId: instanceId, ViewId: id }))
        .catch(() => undefined);
    }
  }, 120_000);

  it("accepts every layout and content component", async () => {
    await publish(
      "layout",
      defineView({
        title: "Layout",
        actions: ["Next", "Choose"],
        body: () => [
          Container({ hideBorder: true }, [
            TextBox("Patient summary", {
              variant: "h2",
              fontSize: "heading-l",
              fontWeight: "bold",
              textAlign: "left",
            }),
            Section({ heading: "Details" }, [TextBox("Body copy")]),
            Image({ src: "https://example.com/logo.png", alt: "logo" }),
            Icon({ name: "Headset", variant: "icon-only" }),
            Link({ type: "external", url: "https://example.com", autoOpen: false }),
            Card({
              id: "refill",
              heading: "Refill",
              description: "Start a refill",
              action: "Choose",
              icon: "Pills",
            }),
            Button({ action: "Next", variant: "primary", iconName: "check", iconAlign: "left" }, [
              TextBox("Continue"),
            ]),
          ]),
        ],
      }),
    );
  }, 120_000);

  it("accepts every form field", async () => {
    await publish(
      "form",
      defineView({
        title: "Intake",
        actions: ["Submit", "Cancel"],
        body: () => [
          Form({}, [
            FormInput({
              name: "account",
              label: "Account",
              inputType: "number",
              required: true,
              helperText: "Eight digits",
            }),
            TextArea({ name: "notes", label: "Notes" }),
            Dropdown({
              name: "reason",
              label: "Reason",
              choices: [{ label: "Refill", value: "refill" }],
              clearable: true,
              multiSelect: false,
            }),
            RadioGroup({
              name: "channel",
              label: "Channel",
              choices: [{ label: "Phone", value: "p" }],
            }),
            CheckboxGroup({
              name: "consent",
              label: "Consent",
              choices: [{ label: "Yes", value: "y" }],
            }),
            DatePicker({ name: "dob", label: "Date of birth" }),
            TimePicker({ name: "callback", label: "Callback time" }),
            Toggle({ name: "sms", label: "SMS updates" }),
            ButtonGroup({
              items: [
                { label: "Submit", action: "Submit", variant: "primary" },
                { label: "Cancel", action: "Cancel" },
              ],
              orientation: "horizontal",
              spaceBetween: "s",
            }),
          ]),
        ],
      }),
    );
  }, 120_000);

  it("accepts the components recovered from the docs site", async () => {
    // Header, Alert and Container's header/footer take lower-case properties; SubmitButton takes the
    // label Button rejects; Loader and Application take none of the names a prop sieve would guess.
    await publish(
      "documented",
      defineView({
        title: "Documented",
        actions: ["Save"],
        body: () => [
          Container({ header: "Top", footer: "Bottom" }, [
            Header({ variant: "h2", description: "Supporting text" }, [TextBox("Summary")]),
            Alert({ type: "warning", level: "inline", heading: "Careful", dismissible: true }, [
              TextBox("Something needs attention."),
            ]),
            Loader(),
            Application({ appIdentifier: "example-app", path: "/detail" }),
            Form({}, [SubmitButton({ label: "Save", action: "Save", variant: "primary" })]),
          ]),
        ],
      }),
    );
  }, 120_000);

  it("declares an input from a reference in text content", async () => {
    // TextBox has no Text property: the text is content, and a reference there declares an input just
    // as it does in a data component's property.
    const schema = await publish(
      "content-reference",
      defineView({
        title: "Content",
        actions: ["Next"],
        body: () => [
          Container({}, [
            TextBox(["Hello ", "$.CustomerName", ", welcome back."]),
            Button({ action: "Next" }, [TextBox("Continue")]),
          ]),
        ],
      }),
    );

    expect(Object.keys((schema.properties ?? {}) as Record<string, unknown>)).toEqual([
      "CustomerName",
    ]);
  }, 120_000);

  it("derives an input schema from whole-value references", async () => {
    // This is the pay-off of the reference rule: Connect reports exactly which inputs the view needs,
    // so `showView`'s data can be checked against it.
    const schema = await publish(
      "inputs",
      defineView({
        title: "Data",
        actions: ["RowPicked"],
        body: () => [
          Container({}, [
            AttributeBar({ attributes: [{ label: "Customer", value: "$.CustomerName" }] }),
            AttributeSection({ heading: "Order", items: "$.OrderAttributes" }),
            Table({
              items: "$.Orders",
              columns: [
                { label: "Order", id: "order_id" },
                { label: "Status", id: "status" },
              ],
              actions: [{ label: "Open", action: "RowPicked" }],
            }),
          ]),
        ],
      }),
    );

    const properties = Object.keys((schema.properties ?? {}) as Record<string, unknown>);
    expect(properties.sort()).toEqual(["CustomerName", "OrderAttributes", "Orders"]);
    expect(schema.required).toEqual(
      expect.arrayContaining(["CustomerName", "OrderAttributes", "Orders"]),
    );
  }, 120_000);

  it("accepts every Table property, including the editable and action columns", async () => {
    await publish(
      "table",
      defineView({
        title: "Orders",
        actions: ["OrderSelected", "Save"],
        body: ({ actions }) => [
          Container({}, [
            Form({}, [
              Table({
                items: "$.Orders",
                name: "OrderTable",
                tableAction: actions.OrderSelected,
                header: "Recent orders",
                description: "Pick one, or fix a priority in place",
                filterable: true,
                itemsPerPage: 5,
                columnWidth: "flexible",
                columns: [
                  { label: "Order", id: "order_id", type: "action" },
                  { label: "Placed", id: "placed", type: "number" },
                  { label: "Status", id: "status", type: "text" },
                  { label: "Notes", id: "notes", editableType: "input" },
                  {
                    label: "Priority",
                    id: "priority",
                    editableType: "select",
                    options: ["1", "2"],
                  },
                ],
                actions: [
                  { label: "Save", action: actions.Save, variant: "primary", formAction: "submit" },
                ],
              }),
            ]),
          ]),
        ],
      }),
    );
  }, 120_000);

  it("derives the Table's own column and action shapes when they are references", async () => {
    // How the shapes above were recovered, and the only check on them: Connect has no component
    // schema for Table, so a literal column list is accepted whatever it contains — a misspelled
    // `Header` included. A referenced list is different: the derived InputSchema *is* the shape, and
    // an unknown property with a reference on it is rejected outright.
    const schema = await publish(
      "table-refs",
      defineView({
        title: "Referenced",
        actions: ["OrderSelected"],
        body: ({ actions }) => [
          Container({}, [
            Table({
              items: "$.Orders",
              columns: "$.Cols",
              actions: "$.Acts",
              tableAction: actions.OrderSelected,
            }),
          ]),
        ],
      }),
    );

    // Each input is `anyOf: [<the shape>, <a reference>]`, and a list's shape carries its `items`.
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const itemsOf = (name: string): JsonSchema => {
      const list = properties[name]?.anyOf?.[0];
      if (list?.items === undefined) throw new Error(`no derived shape for ${name}`);
      return list.items;
    };

    const column = itemsOf("Cols");
    expect(Object.keys(column.properties ?? {}).sort()).toEqual([
      "EditableType",
      "Id",
      "Label",
      "Options",
      "Type",
    ]);
    expect(column.required).toEqual(["Label", "Id"]);
    expect(column.additionalProperties).toBe(false);

    // A table's actions are a ButtonGroup's items, which is why <GroupButton> serves both.
    const action = itemsOf("Acts").anyOf?.[0];
    expect(Object.keys(action?.properties ?? {}).sort()).toEqual([
      "Action",
      "Disabled",
      "FormAction",
      "Href",
      "IconAlign",
      "IconName",
      "Label",
      "Loading",
      "Variant",
    ]);
  }, 120_000);

  it("accepts the field names a view submits back under", async () => {
    // These names are the output half of a view's contract: the flow reads
    // `$.Views.ViewResultData.<Name>`, and for a table `<Name>.0.<column>`. Publishing is the only
    // confirmation that Connect accepts `Name` on a Table at all, since it is optional there.
    interface Outputs {
      notes: string;
      OrderTable: Array<{ order_id: string }>;
    }

    const view = defineView({
      title: "Submit",
      actions: ["RowPicked"],
      outputs: shape<Outputs>(),
      body: ({ actions, fields }) =>
        Container({}, [
          Form({}, [FormInput({ name: fields.notes, label: "Notes" })]),
          Table({
            name: fields.OrderTable,
            items: "$.Orders",
            columns: [{ label: "Order", id: "order_id" }],
            actions: [{ label: "Open", action: actions.RowPicked }],
          }),
        ]),
    });

    expect(view.fields.sort()).toEqual(["OrderTable", "notes"]);
    await publish("outputs", view);
  }, 120_000);

  it("declares no inputs when a reference is embedded in text", async () => {
    // The reason `defineView` rejects this shape: Connect accepts the template but derives no inputs,
    // so the reference renders literally to whoever is looking at the view.
    const schema = await publish("embedded", {
      Template: {
        Head: { Title: "Embedded", Configuration: {} },
        Body: [
          {
            Type: "TextBox",
            Props: { Text: "Hello $.CustomerName" },
            Content: [],
            _id: "textbox-0",
          },
        ],
      },
      Actions: [],
    });

    expect(Object.keys((schema.properties ?? {}) as Record<string, unknown>)).toEqual([]);
  }, 120_000);

  // A deployed view is mutated far more often than it is created, and `AlreadyExists` on a
  // `pulumi up` looks like a mutation bug. It is not one: every edit a `ConnectView` can produce is
  // an in-place update — `AWS::Connect::View` declares no create-only properties, so Cloud Control
  // never replaces the view — and the only thing the service rejects with that code is a *second*
  // view claiming a live view's name. Both halves are checked here.
  it("updates a published view in place, and reserves its name only while it lives", async () => {
    const name = `${PREFIX}mutate-${Date.now()}`;
    const screen = (title: string, body: string) =>
      defineView({
        title,
        actions: ["Next"],
        body: () => [
          Container({}, [TextBox(body), Button({ action: "Next" }, [TextBox("Continue")])]),
        ],
      });

    const first = await client.send(
      new CreateViewCommand({
        InstanceId: instanceId,
        Name: name,
        Status: "PUBLISHED",
        Description: "Temporary end-to-end verification. Safe to delete.",
        Content: toViewInputContent(screen("Before", "First body")),
      }),
    );
    const id = first.View?.Id;
    if (id === undefined) throw new Error("CreateView returned no id");
    created.push(id);

    // The content edit keeps the id and the ARN, which is what lets a flow keep referencing the view.
    const content = await client.send(
      new UpdateViewContentCommand({
        InstanceId: instanceId,
        ViewId: id,
        Status: "PUBLISHED",
        Content: toViewInputContent(screen("After", "Second body, changed")),
      }),
    );
    expect(content.View?.Id).toBe(id);
    expect(content.View?.Arn).toBe(first.View?.Arn);
    expect(JSON.parse(content.View?.Content?.Template ?? "{}").Head.Title).toBe("After");

    // So does the rename, which is why changing `name` on a `ConnectView` is not a replacement.
    const renamed = `${name}-renamed`;
    const metadata = await client.send(
      new UpdateViewMetadataCommand({ InstanceId: instanceId, ViewId: id, Name: renamed }),
    );
    expect(metadata.$metadata.httpStatusCode).toBe(200);

    // The one rejection: a live view already holds the name. This is the `AlreadyExists` a rename of
    // the Pulumi resource, a second stack on one instance, or an orphan from an interrupted `up`
    // turns into — a create, never an update.
    await expect(
      client.send(
        new CreateViewCommand({
          InstanceId: instanceId,
          Name: renamed,
          Status: "PUBLISHED",
          Description: "Temporary end-to-end verification. Safe to delete.",
          Content: toViewInputContent(screen("Duplicate", "Should not be created")),
        }),
      ),
    ).rejects.toThrow(/name already exists/i);

    // And the name is released on delete, with no soft-delete window: a destroy/up cycle, or a rerun
    // of this suite, can reuse it immediately.
    await client.send(new DeleteViewCommand({ InstanceId: instanceId, ViewId: id }));
    const reused = await client.send(
      new CreateViewCommand({
        InstanceId: instanceId,
        Name: renamed,
        Status: "PUBLISHED",
        Description: "Temporary end-to-end verification. Safe to delete.",
        Content: toViewInputContent(screen("Reused", "Same name, new view")),
      }),
    );
    expect(reused.View?.Id).not.toBe(id);
    if (reused.View?.Id) created.push(reused.View.Id);
  }, 120_000);
});
