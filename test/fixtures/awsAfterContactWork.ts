/**
 * Amazon Connect's own "After Contact Work" view, exactly as the service returns it.
 *
 * The one AWS-managed view that is an ordinary template rather than a single pass-through composite,
 * which makes it the one worth reproducing component by component. Checked in verbatim so the
 * reproduction in `test/awsManagedViews.test.ts` is compared against the service rather than against
 * a transcription of it.
 *
 * Re-download with:
 *
 *     aws connect describe-view --instance-id <id> --region us-east-1 \
 *       --view-id arn:aws:connect:us-east-1:aws:view/after-contact-work \
 *       --query View.Content.Template --output text | jq .
 */

import type { ViewTemplate } from "../../src/index.js";

/** Version 1 of `arn:aws:connect:us-east-1:aws:view/after-contact-work`. */
export const AWS_AFTER_CONTACT_WORK_TEMPLATE: ViewTemplate = {
  Head: {
    Configuration: {
      Layout: {
        Columns: [12],
      },
    },
    Title: "After Contact Work",
  },
  Body: [
    {
      Type: "AttributeBar",
      Content: [],
      _id: "AttributeBar",
      Props: {
        Attributes: [
          {
            Label: "Customer Name",
            Value: "$.CustomerName",
          },
          {
            Label: "Phone Number",
            Value: "$.PhoneNumber",
          },
          {
            Label: "Example",
            Value: "$.Example_Label",
            LinkType: "external",
            Url: "$.Example_Url",
          },
        ],
      },
    },
    {
      Type: "Header",
      Content: ["$.ContactWrapUp_Header_Title"],
      _id: "ContactWrapUp_Header",
      Props: {
        variant: "h1",
        description: "$.ContactWrapUp_Header_Description",
      },
    },
    {
      Type: "Form",
      Configuration: {
        Layout: {
          Align: "right",
        },
      },
      Content: [
        {
          Type: "Section",
          Configuration: {
            Layout: {
              Align: "left",
              Columns: "12",
            },
          },
          Content: [
            {
              Type: "Header",
              Content: ["$.Disposition_Header_Title"],
              _id: "Disposition_Header",
              Props: {
                variant: "h2",
                description: "$.Disposition_Header_Description",
              },
            },
            {
              Type: "Dropdown",
              Content: [],
              _id: "Category_Dropdown",
              Props: {
                Options: [
                  {
                    Label: "Support",
                    Value: "Support",
                  },
                  {
                    Label: "Sales",
                    Value: "Sales",
                  },
                ],
                DefaultValue: ["$.Category_DefaultValue"],
                Label: "Category",
                Name: "Category",
              },
            },
            {
              Type: "Dropdown",
              Content: [],
              _id: "Driver_Dropdown",
              Props: {
                Options: [
                  {
                    Label: "Billing inquiries",
                    Value: "Billing inquiries",
                  },
                  {
                    Label: "Technical support requests",
                    Value: "Technical support requests",
                  },
                  {
                    Label: "Product information questions",
                    Value: "Product information questions",
                  },
                  {
                    Label: "Order status",
                    Value: "Order status",
                  },
                  {
                    Label: "Account management",
                    Value: "Account management",
                  },
                  {
                    Label: "Complaints or feedback",
                    Value: "Complaints or feedback",
                  },
                ],
                DefaultValue: ["$.Driver_DefaultValue"],
                Label: "Driver",
                Name: "Driver",
              },
            },
            {
              Type: "Dropdown",
              Content: [],
              _id: "CustomerSatisfactionRating_Dropdown",
              Props: {
                Options: [
                  {
                    Label: "Very Satisfied",
                    Value: "Very Satisfied",
                  },
                  {
                    Label: "Satisfied",
                    Value: "Satisfied",
                  },
                  {
                    Label: "Neutral",
                    Value: "Neutral",
                  },
                  {
                    Label: "Unsatisfied",
                    Value: "Unsatisfied",
                  },
                  {
                    Label: "Very Unsatisfied",
                    Value: "Very Unsatisfied",
                  },
                ],
                DefaultValue: ["$.Satisfaction_DefaultValue"],
                Label: "Customer Satisfaction Rating",
                Name: "Satisfaction",
              },
            },
            {
              Type: "Dropdown",
              Content: [],
              _id: "FollowUp_Dropdown",
              Props: {
                Options: [
                  {
                    Label: "Yes",
                    Value: "Yes",
                  },
                  {
                    Label: "No",
                    Value: "No",
                  },
                ],
                DefaultValue: ["$.FollowUp_DefaultValue"],
                Label: "Follow Up Required",
                Name: "FollowUp",
              },
            },
            {
              Type: "Dropdown",
              Content: [],
              _id: "Resolved_Dropdown",
              Props: {
                Options: [
                  {
                    Label: "Yes",
                    Value: "Yes",
                  },
                  {
                    Label: "No",
                    Value: "No",
                  },
                ],
                DefaultValue: ["$.Resolved_DefaultValue"],
                Label: "Resolved",
                Name: "Resolved",
              },
            },
          ],
          _id: "Disposition_Section",
          Props: {},
        },
        {
          Type: "Section",
          Configuration: {
            Layout: {
              Align: "left",
              Columns: "12",
            },
          },
          Content: [
            {
              Type: "Header",
              Content: ["$.ContactSummary_Header_Title"],
              _id: "ContactSummary_Header",
              Props: {
                variant: "h2",
                description: "$.ContactSummary_Header_Description",
              },
            },
            {
              Type: "TextArea",
              Content: [],
              _id: "ContactSummary_TextArea",
              Props: {
                DefaultValue: "$.ContactSummary_DefaultValue",
                HelperText:
                  "Review and edit the summary of this customer interaction. This creates a record of what was discussed and resolved.",
                Required: false,
                Label: "Modified Summary",
                Name: "ModifiedSummary",
              },
            },
          ],
          _id: "ContactSummary_Section",
          Props: {},
        },
        {
          Type: "Section",
          Configuration: {
            Layout: {
              Align: "left",
              Columns: "12",
            },
          },
          Content: [
            {
              Type: "Header",
              Content: ["$.AdditionalNotes_Header_Title"],
              _id: "AdditionalNotes_Header",
              Props: {
                variant: "h2",
                description: "$.AdditionalNotes_Header_Description",
              },
            },
            {
              Type: "TextArea",
              Content: [],
              _id: "AdditionalNotes_TextArea",
              Props: {
                DefaultValue: "$.AdditionalNotes_DefaultValue",
                HelperText: "Document any important details not covered in the Contact Summary.",
                Required: false,
                Label: "Contact Notes",
                Name: "ContactNotes",
              },
            },
          ],
          _id: "AdditionalNotes_Section",
          Props: {},
        },
        {
          Type: "ButtonGroup",
          Content: [],
          _id: "ButtonGroup",
          Props: {
            SpaceBetweenButtons: "s",
            Items: [
              {
                Variant: "normal",
                Action: "Cancel",
                Label: "Cancel",
                FormAction: "none",
              },
              {
                Variant: "primary",
                Action: "Submit",
                Label: "Submit",
                FormAction: "submit",
              },
            ],
            ButtonsOrientation: "horizontal",
          },
        },
      ],
      _id: "Form",
      Props: {
        HideBorder: true,
      },
    },
  ],
};

/** The action list the same view resource declares. */
export const AWS_AFTER_CONTACT_WORK_ACTIONS: string[] = ["Cancel", "Submit"];
