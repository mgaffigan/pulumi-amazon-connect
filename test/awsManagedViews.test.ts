/**
 * The AWS-managed views, reproduced.
 *
 * Amazon Connect ships six views in every instance, and they answer two different questions about this
 * library. After Contact Work is an ordinary template built from ordinary components, so the question
 * is whether the component set can emit it — the first half of this file builds it and compares the
 * result to what `describe-view` returns, so the assertion is against the service rather than against a
 * transcription of it.
 *
 * The other five are not templates in any meaningful sense: each body is a *single* composite component
 * whose every property is a `$.` reference, so all of their content arrives from the flow as `ViewData`
 * and there is nothing to author. The question for those is whether a flow can call them with the right
 * data and branch on the right actions, which the second half checks against their published schemas.
 *
 * Sources, all from `arn:aws:connect:us-east-1:422331085735:instance/7c7f9bdb-...`:
 *
 *     aws connect list-views --instance-id <id> --region us-east-1
 *     aws connect describe-view --instance-id <id> --view-id arn:aws:connect:us-east-1:aws:view/<id>
 *
 * The example `ViewData` below is AWS's own, from the per-view "Input data example" in the
 * [managed view reference](https://docs.aws.amazon.com/connect/latest/adminguide/view-resources-managed-view.html),
 * and the `ViewResource.Id` assertions match `Sample after contact work flow` in the same instance.
 */

import { describe, expect, it } from "vitest";
import {
  type AfterContactWorkViewInputs,
  type AfterContactWorkViewResult,
  AttributeBar,
  awsAfterContactWorkView,
  awsCardsView,
  awsConfirmationView,
  awsDetailView,
  awsFormView,
  awsListView,
  ButtonGroup,
  Dropdown,
  defineView,
  disconnect,
  type FlowJson,
  Form,
  Header,
  play,
  Section,
  setAttributes,
  shape,
  TextArea,
  type ViewNode,
  type ViewTemplate,
} from "../src/index.js";
import { recordFlow } from "../src/testing/index.js";
import {
  AWS_AFTER_CONTACT_WORK_ACTIONS,
  AWS_AFTER_CONTACT_WORK_TEMPLATE,
} from "./fixtures/awsAfterContactWork.js";

const region = "us-east-1";
const root = { onError: () => disconnect() };

/**
 * Drops the `_id`s before comparing.
 *
 * Ids are the one thing that legitimately differs: Connect only requires them to be unique and stable,
 * AWS hand-wrote theirs ("Category_Dropdown"), and this library derives them from tree position.
 */
function withoutIds(template: ViewTemplate): unknown {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "_id")
        .map(([key, nested]) => [key, strip(nested)]),
    );
  };
  return strip(template);
}

/** The single `ShowView` in a recorded flow. */
function showViewIn(flow: FlowJson): { ViewResource: { Id: string }; ViewData: object } {
  const action = flow.Actions.find((a) => a.Type === "ShowView");
  if (action === undefined) throw new Error("no ShowView in the recorded flow");
  return action.Parameters as unknown as { ViewResource: { Id: string }; ViewData: object };
}

/** The action names a `ShowView` branches on. */
function branchesOf(flow: FlowJson): string[] {
  const action = flow.Actions.find((a) => a.Type === "ShowView");
  return (action?.Transitions.Conditions ?? []).flatMap((c) => c.Condition.Operands ?? []);
}

const yesNo = [
  { label: "Yes", value: "Yes" },
  { label: "No", value: "No" },
];

/** Label and value are the same string in every one of this view's dropdowns. */
const choices = (...values: string[]) => values.map((value) => ({ label: value, value }));

/**
 * After Contact Work, rebuilt from the component library.
 *
 * The types it is declared with are the same ones `awsAfterContactWorkView` uses to *call* the
 * deployed view, so the inputs the template references and the fields the flow reads back are checked
 * against one declaration rather than two.
 */
const afterContactWork = defineView({
  title: "After Contact Work",
  actions: ["Cancel", "Submit"],
  inputs: shape<AfterContactWorkViewInputs>(),
  outputs: shape<AfterContactWorkViewResult>(),
  configuration: { Layout: { Columns: [12] } },
  body: ({ inputs, actions, fields }) => [
    AttributeBar({
      attributes: [
        { label: "Customer Name", value: inputs.CustomerName },
        { label: "Phone Number", value: inputs.PhoneNumber },
        {
          label: "Example",
          value: inputs.Example_Label,
          linkType: "external",
          url: inputs.Example_Url,
        },
      ],
    }),
    Header({ variant: "h1", description: inputs.ContactWrapUp_Header_Description }, [
      inputs.ContactWrapUp_Header_Title,
    ]),
    // The buttons sit at the bottom right; each section stacks its fields full width.
    Form({ hideBorder: true, configuration: { Layout: { Align: "right" } } }, [
      Section({ configuration: { Layout: { Align: "left", Columns: "12" } } }, [
        Header({ variant: "h2", description: inputs.Disposition_Header_Description }, [
          inputs.Disposition_Header_Title,
        ]),
        Dropdown({
          name: fields.Category,
          label: "Category",
          choices: choices("Support", "Sales"),
          defaultValue: inputs.Category_DefaultValue,
        }),
        Dropdown({
          name: fields.Driver,
          label: "Driver",
          choices: choices(
            "Billing inquiries",
            "Technical support requests",
            "Product information questions",
            "Order status",
            "Account management",
            "Complaints or feedback",
          ),
          defaultValue: inputs.Driver_DefaultValue,
        }),
        Dropdown({
          name: fields.Satisfaction,
          label: "Customer Satisfaction Rating",
          choices: choices(
            "Very Satisfied",
            "Satisfied",
            "Neutral",
            "Unsatisfied",
            "Very Unsatisfied",
          ),
          defaultValue: inputs.Satisfaction_DefaultValue,
        }),
        Dropdown({
          name: fields.FollowUp,
          label: "Follow Up Required",
          choices: yesNo,
          defaultValue: inputs.FollowUp_DefaultValue,
        }),
        Dropdown({
          name: fields.Resolved,
          label: "Resolved",
          choices: yesNo,
          defaultValue: inputs.Resolved_DefaultValue,
        }),
      ]),
      Section({ configuration: { Layout: { Align: "left", Columns: "12" } } }, [
        Header({ variant: "h2", description: inputs.ContactSummary_Header_Description }, [
          inputs.ContactSummary_Header_Title,
        ]),
        TextArea({
          name: fields.ModifiedSummary,
          label: "Modified Summary",
          defaultValue: inputs.ContactSummary_DefaultValue,
          helperText:
            "Review and edit the summary of this customer interaction. This creates a record of what was discussed and resolved.",
          required: false,
        }),
      ]),
      Section({ configuration: { Layout: { Align: "left", Columns: "12" } } }, [
        Header({ variant: "h2", description: inputs.AdditionalNotes_Header_Description }, [
          inputs.AdditionalNotes_Header_Title,
        ]),
        TextArea({
          name: fields.ContactNotes,
          label: "Contact Notes",
          defaultValue: inputs.AdditionalNotes_DefaultValue,
          helperText: "Document any important details not covered in the Contact Summary.",
          required: false,
        }),
      ]),
      // No SubmitButton anywhere: the pair of FormActions is what makes one of these submit the form
      // and the other merely raise its action.
      ButtonGroup({
        spaceBetween: "s",
        orientation: "horizontal",
        items: [
          { label: "Cancel", action: actions.Cancel, variant: "normal", formAction: "none" },
          { label: "Submit", action: actions.Submit, variant: "primary", formAction: "submit" },
        ],
      }),
    ]),
  ],
});

describe("After Contact Work, reproduced from the component library", () => {
  it("emits the template the service returns, apart from the node ids", () => {
    expect(withoutIds(afterContactWork.Template)).toEqual(
      withoutIds(AWS_AFTER_CONTACT_WORK_TEMPLATE),
    );
  });

  it("declares the same actions the view resource does", () => {
    expect([...afterContactWork.Actions].sort()).toEqual(
      [...AWS_AFTER_CONTACT_WORK_ACTIONS].sort(),
    );
  });

  it("names the same fields, which is what the flow reads back", () => {
    // A mismatch here is silent at runtime: the flow would read an empty reference.
    expect(afterContactWork.fields).toEqual([
      "Category",
      "Driver",
      "Satisfaction",
      "FollowUp",
      "Resolved",
      "ModifiedSummary",
      "ContactNotes",
    ]);
  });

  it("puts a section's layout beside its Props, not inside them", () => {
    const form = afterContactWork.Template.Body[2] as ViewNode;
    expect(form.Props).toEqual({ HideBorder: true });
    expect(form.Configuration).toEqual({ Layout: { Align: "right" } });

    const section = form.Content[0] as ViewNode;
    expect(section.Props).toEqual({});
    expect(section.Configuration).toEqual({ Layout: { Align: "left", Columns: "12" } });
  });

  it("wraps a dropdown's default value in an array, as the schema requires", () => {
    const form = afterContactWork.Template.Body[2] as ViewNode;
    const section = form.Content[0] as ViewNode;
    const category = section.Content[1] as ViewNode;

    expect(category.Props.DefaultValue).toEqual(["$.Category_DefaultValue"]);
    expect(category.Props).not.toHaveProperty("Required");
  });

  it("carries FormAction on the button group's items", () => {
    const form = afterContactWork.Template.Body[2] as ViewNode;
    const buttons = form.Content[3] as ViewNode;

    expect(buttons.Props.Items).toEqual([
      { Label: "Cancel", Action: "Cancel", Variant: "normal", FormAction: "none" },
      { Label: "Submit", Action: "Submit", Variant: "primary", FormAction: "submit" },
    ]);
  });
});

describe("showing the managed views from a flow", () => {
  it("references an AWS-managed view by its bare published version, not $1", () => {
    // `Sample after contact work flow` in the same instance carries exactly this id. A customer view
    // takes a `$LATEST`-style qualifier; a managed one takes the number on its own.
    const flow = recordFlow(() => {
      awsAfterContactWorkView({ region }).show({
        data: { CustomerName: "Jane Doe", Category_DefaultValue: "Support" },
        on: { Submit: () => play("thanks"), Cancel: () => play("no problem") },
      });
      disconnect();
    }, root);

    expect(showViewIn(flow).ViewResource).toEqual({
      Id: "arn:aws:connect:us-east-1:aws:view/after-contact-work:1",
    });
  });

  it("reads a dropdown's value positionally, since a Dropdown submits an array", () => {
    // AWS's own flow stores `$.Views.ViewResultData.Category.0` from this view.
    const flow = recordFlow(() => {
      const result = awsAfterContactWorkView({ region }).show({
        data: { CustomerName: "Jane Doe" },
        on: {
          Submit: (r) =>
            setAttributes({
              Category: r.Category.at(0),
              Satisfaction: r.Satisfaction.at(0),
              ModifiedSummary: r.ModifiedSummary,
            }),
          Cancel: () => play("no problem"),
        },
      });
      setAttributes({ notes: result.ContactNotes });
      disconnect();
    }, root);

    const update = flow.Actions.find((a) => a.Type === "UpdateContactAttributes");
    expect(update?.Parameters.Attributes).toEqual({
      Category: "$.Views.ViewResultData.Category.0",
      Satisfaction: "$.Views.ViewResultData.Satisfaction.0",
      ModifiedSummary: "$.Views.ViewResultData.ModifiedSummary",
    });
  });

  it("passes the Detail view its sections and branches on both its actions", () => {
    const detail = awsDetailView({ region });
    const flow = recordFlow(() => {
      detail.show({
        data: {
          AttributeBar: [
            { Label: "Example", Value: "Attribute" },
            {
              Label: "Example 2",
              Value: "Attribute 3",
              LinkType: "case",
              ResourceId: "123456",
              Copyable: true,
            },
          ],
          Back: { Label: "Back" },
          Heading: "Hello world",
          Description: "This view is showing off the wonders of a detail page",
          Sections: [{ TemplateString: "This is an intro paragraph" }, "abc"],
          Actions: ["Do thing!", "Update thing 2!"],
        },
        on: {
          ActionSelected: (r) => setAttributes({ chose: r.actionName }),
          Back: () => play("going back"),
        },
      });
      disconnect();
    }, root);

    const { ViewResource, ViewData } = showViewIn(flow);
    expect(ViewResource.Id).toBe("arn:aws:connect:us-east-1:aws:view/detail:1");
    // Structured data survives as structure — only scalars are stringified on the way out.
    expect(ViewData).toEqual({
      AttributeBar: [
        { Label: "Example", Value: "Attribute" },
        {
          Label: "Example 2",
          Value: "Attribute 3",
          LinkType: "case",
          ResourceId: "123456",
          Copyable: true,
        },
      ],
      Back: { Label: "Back" },
      Heading: "Hello world",
      Description: "This view is showing off the wonders of a detail page",
      Sections: [{ TemplateString: "This is an intro paragraph" }, "abc"],
      Actions: ["Do thing!", "Update thing 2!"],
    });
    expect(branchesOf(flow).sort()).toEqual(["ActionSelected", "Back"]);
    expect(
      flow.Actions.find((a) => a.Type === "UpdateContactAttributes")?.Parameters.Attributes,
    ).toEqual({ chose: "$.Views.ViewResultData.actionName" });
  });

  it("passes the List view its items, whose Id is what comes back", () => {
    const flow = recordFlow(() => {
      awsListView({ region }).show({
        data: {
          Heading: "José may be contacting about...",
          SubHeading: "Optional List Title",
          Back: { Label: "Back" },
          Items: [
            {
              Heading: "List item with link",
              Description: "Optional description here.",
              Icon: "School",
              Id: "Select_Car",
            },
            { Heading: "List item not a link", Icon: "School" },
          ],
        },
        on: { ActionSelected: (r) => setAttributes({ picked: r.actionName }) },
      });
      disconnect();
    }, root);

    const { ViewResource, ViewData } = showViewIn(flow);
    expect(ViewResource.Id).toBe("arn:aws:connect:us-east-1:aws:view/list:1");
    expect(ViewData).toMatchObject({ Items: [{ Id: "Select_Car" }, { Icon: "School" }] });
    // Back has no handler, so it continues past the show call rather than getting its own branch.
    expect(branchesOf(flow)).toEqual(["ActionSelected", "Back"]);
  });

  it("passes the Cards view its cards, including each card's detail and actions", () => {
    const flow = recordFlow(() => {
      awsCardsView({ region }).show({
        data: {
          Heading: "Customer may be contacting about...",
          CardsPerRow: 3,
          Back: { Label: "Back" },
          NoMatchFound: { Label: "Can't find match?" },
          Cards: [
            {
              Summary: { Id: "lost_luggage", Icon: "plus", Heading: "Lost luggage claim" },
              Detail: {
                Heading: "Lost luggage claim",
                Description: "Use this flow for customers that have lost their luggage.",
                Sections: { TemplateString: "<TextContent>Steps:</TextContent>" },
                Actions: ["Start a new claim", "Something else"],
              },
            },
            {
              Summary: {
                Id: "car_rental",
                Icon: "Car Side View",
                Heading: "Car rental - New York",
                Status: "Upcoming Sept 17, 2022",
              },
            },
          ],
        },
        on: {
          ActionSelected: (r) => setAttributes({ topic: r.actionName }),
          NoMatchFound: () => play("Let me take some details."),
        },
      });
      disconnect();
    }, root);

    const { ViewResource, ViewData } = showViewIn(flow);
    expect(ViewResource.Id).toBe("arn:aws:connect:us-east-1:aws:view/cards:1");
    expect(ViewData).toMatchObject({
      // Quoted, like every other top-level flow parameter — the view's renderer compares
      // `${CardsPerRow}` against "1".."12", so the string form is what it expects anyway. Only
      // structured data keeps its JSON types, which is what the nested assertions below check.
      CardsPerRow: "3",
      NoMatchFound: { Label: "Can't find match?" },
      Cards: [
        {
          Summary: { Id: "lost_luggage" },
          Detail: { Actions: ["Start a new claim", "Something else"] },
        },
        { Summary: { Status: "Upcoming Sept 17, 2022" } },
      ],
    });
    expect(branchesOf(flow).sort()).toEqual(["ActionSelected", "Back", "NoMatchFound"]);
  });

  it("passes the Confirmation view its graphic, and reads the button's label back", () => {
    const flow = recordFlow(() => {
      awsConfirmationView({ region }).show({
        data: {
          Heading: "I have updated your reservation for pickup on July 22.",
          SubHeading: "You will be receiving a confirmation shortly.",
          Graphic: { Include: true },
          Next: { Label: "Go Home" },
        },
        on: { Next: (r) => setAttributes({ dismissedWith: r.Label }) },
      });
      disconnect();
    }, root);

    const { ViewResource, ViewData } = showViewIn(flow);
    expect(ViewResource.Id).toBe("arn:aws:connect:us-east-1:aws:view/confirmation:1");
    // A boolean inside structured data stays a boolean; only top-level scalars are stringified.
    expect(ViewData).toMatchObject({ Graphic: { Include: true }, Next: { Label: "Go Home" } });
    expect(
      flow.Actions.find((a) => a.Type === "UpdateContactAttributes")?.Parameters.Attributes,
    ).toEqual({ dismissedWith: "$.Views.ViewResultData.Label" });
  });

  it("reads the Form view's submission out of FormData, a level deeper than an authored view", () => {
    interface Reservation {
      pickup_location: string;
      pickup_day: string;
    }

    const flow = recordFlow(() => {
      const form = awsFormView<Reservation>({ region });
      const result = form.show({
        data: {
          Heading: "Modify Reservation",
          SubHeading: "Cadillac XT5",
          Back: { Label: "Back Home" },
          Next: { Label: "Confirm Reservation", Details: { endpoint: "example.com/submit" } },
          Cancel: { Label: "Cancel" },
          Wizard: [{ Heading: "Pickup and drop off" }, { Heading: "Review", Optional: true }],
          ErrorText: { Heading: "Modify reservation failed", Content: "Please try again" },
          Sections: [
            {
              Type: "FormSection",
              Heading: "Pickup Details",
              Configuration: { Layout: { Columns: ["6", "6"] } },
              Items: [
                {
                  Type: "FormInput",
                  Name: "pickup_location",
                  Label: "Location",
                  InputType: "text",
                  Fluid: true,
                  DefaultValue: "Seattle",
                },
                {
                  Type: "DatePicker",
                  Name: "pickup_day",
                  Label: "Day",
                  DefaultValue: "2022-10-10",
                },
              ],
            },
          ],
        },
        on: { Next: (r) => setAttributes({ where: r.FormData.pickup_location }) },
      });
      setAttributes({ step: result.StepName });
      disconnect();
    }, root);

    const { ViewResource, ViewData } = showViewIn(flow);
    expect(ViewResource.Id).toBe("arn:aws:connect:us-east-1:aws:view/form:1");
    expect(ViewData).toMatchObject({
      Wizard: [{ Heading: "Pickup and drop off" }, { Heading: "Review", Optional: true }],
      Sections: [{ Type: "FormSection", Configuration: { Layout: { Columns: ["6", "6"] } } }],
    });
    // Step is the third declared action; the wizard and a DataSection's edit button raise it.
    expect(branchesOf(flow).sort()).toEqual(["Back", "Next", "Step"]);

    const updates = flow.Actions.filter((a) => a.Type === "UpdateContactAttributes");
    expect(updates[0]?.Parameters.Attributes).toEqual({
      where: "$.Views.ViewResultData.FormData.pickup_location",
    });
    expect(updates[1]?.Parameters.Attributes).toEqual({
      step: "$.Views.ViewResultData.StepName",
    });
  });

  it("pins a different version when one is asked for", () => {
    const flow = recordFlow(() => {
      awsListView({ region: "eu-west-2", version: "$LATEST" }).show({
        data: { Items: [] },
        on: { Back: () => play("back") },
      });
      disconnect();
    }, root);

    expect(showViewIn(flow).ViewResource.Id).toBe(
      "arn:aws:connect:eu-west-2:aws:view/list:$LATEST",
    );
  });
});
