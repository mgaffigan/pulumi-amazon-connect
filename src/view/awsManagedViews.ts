/**
 * The AWS-managed views, as typed `existingView` declarations.
 *
 * Amazon Connect ships six views in every instance. Five of them are not really templates at all: each
 * one's body is a *single* composite component (`CardsView`, `DetailsView`, `ListView`,
 * `ConfirmationView`, `FormWithSteps`) whose every property is a `$.` reference, so the whole view is
 * a pass-through and all of its content arrives as `ViewData` from the flow. There is nothing to
 * author, only something to call — which is what these are.
 *
 * The sixth, After Contact Work, *is* an ordinary template built from ordinary components, so it is
 * reproducible with `defineView` instead; `test/awsManagedViews.test.ts` does exactly that.
 *
 * The input types below are transcribed from the `InputSchema` Connect derives for each view — read
 * back with `aws connect describe-view --view-id arn:aws:connect:<region>:aws:view/<id>` — which is the
 * composite component's own property schema, not documentation. The output types come from the
 * [managed view reference](https://docs.aws.amazon.com/connect/latest/adminguide/view-resources-managed-view.html),
 * whose per-view "Output data example" is the only published description of what these submit back.
 */

import type { LinkType } from "./components.js";
import type { CardIconName } from "./icons.js";
import { existingView, type ShowableView, shape } from "./connectView.js";

/**
 * Where the managed view lives.
 *
 * A managed view's ARN carries the region and no account (`arn:aws:connect:us-east-1:aws:view/list`),
 * and there is no ambient region while a flow is being recorded, so it has to be named. `version`
 * defaults to 1, which is the only published version and what AWS's own sample flows reference.
 */
export interface AwsManagedViewOptions {
  /** The region the flow runs in, e.g. `"us-east-1"`. */
  region: string;
  /** Published version to pin. Defaults to `1`. */
  version?: string | number;
  /** Default time to wait for the agent. Overridable per `show` call. */
  timeoutSeconds?: number;
}

/** Builds the ARN of an AWS-managed view. These live under the `aws` account, in every region. */
export function awsManagedViewArn(region: string, id: string): string {
  return `arn:aws:connect:${region}:aws:view/${id}`;
}

function managed<In extends object, Out extends object, A extends string>(
  id: string,
  actions: readonly A[],
  options: AwsManagedViewOptions,
): ShowableView<In, Out, A> {
  return existingView<In, Out, A>({
    viewId: awsManagedViewArn(options.region, id),
    viewVersion: options.version ?? 1,
    actions,
    input: shape<In>(),
    output: shape<Out>(),
    ...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }),
  });
}

// ---------------------------------------------------------------------------
// Shapes shared by the managed views
// ---------------------------------------------------------------------------

/**
 * One entry in the attribute bar across the top of a view.
 *
 * PascalCase, unlike this library's component props: these are values passed *through* a flow as
 * `ViewData`, so the spelling is the managed view's rather than ours.
 */
export interface ManagedAttribute {
  Label: string;
  Value: string;
  /** Lets the agent copy `ResourceId`. */
  Copyable?: boolean;
  LinkType?: LinkType;
  /** Where an `external` link goes. */
  Url?: string;
  /** Which record a `case` link opens. */
  ResourceId?: string;
  ApplicationName?: string;
  /** Opens as soon as the view renders. */
  AutoOpen?: boolean;
}

/**
 * A navigation or submission slot.
 *
 * A bare string is the label. As an object, `Action` renames the action the view raises — otherwise it
 * raises the slot's own name, which is why `Back` appears in a view's `Actions` list without appearing
 * anywhere in its template.
 */
export type ManagedAction = string | { Label: string; Action?: string; Details?: object };

/** Markup rendered inside a section, using the managed views' own tag set. */
export interface TemplateString {
  TemplateString: string;
}

/** A labelled block of read-only values. */
export interface ManagedAttributeSection {
  Items: Array<{ Label: string; Value: string }>;
  Heading?: string;
  Columns?: string | number;
  Configuration?: { Layout?: { Columns?: string | number | Array<string | number> } };
  /** Shown when `Items` is empty. */
  NoItemMessage?: string;
}

/** Section content: plain text, markup, a block of values, or a list of those. */
export type ManagedSectionContent =
  | string
  | TemplateString
  | ManagedAttributeSection
  | Array<string | TemplateString | ManagedAttributeSection>;

/**
 * What the four selection views report back.
 *
 * `actionName` is the chosen thing: the label of a `Detail`/`Cards` action, or the `Id` of the chosen
 * list item. There is no separate field naming the card or item, so ids have to be distinct.
 *
 * Not to be confused with `$action` on the result, which is the action that *branched* —
 * `ActionSelected` for every one of these, which is why the field is what carries the choice here.
 */
export interface ActionSelectedResult {
  actionName: string;
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export interface DetailViewInputs {
  /** The body of the page. The only required input. */
  Sections: ManagedSectionContent;
  Heading?: string;
  Description?: string;
  AttributeBar?: ManagedAttribute[];
  /** Buttons along the bottom. Each label comes back as `actionName`. */
  Actions?: string[];
  /** Required when `Actions` is empty, or the agent has no way out. */
  Back?: ManagedAction;
  Style?: object;
}

export type DetailViewActions = "ActionSelected" | "Back";

/**
 * The AWS-managed **Detail** view: data plus a list of actions. The usual screen-pop.
 *
 * ```ts
 * const detail = awsDetailView({ region: "us-east-1" });
 *
 * detail.show({
 *   data: {
 *     Heading: "Jane Doe",
 *     Sections: [{ TemplateString: "<p>Premium since 2019</p>" }],
 *     Actions: ["Open case", "Something else"],
 *   },
 *   on: { ActionSelected: (r) => setAttributes({ chose: r.actionName }) },
 * });
 * ```
 */
export function awsDetailView(
  options: AwsManagedViewOptions,
): ShowableView<DetailViewInputs, ActionSelectedResult, DetailViewActions> {
  return managed("detail", ["ActionSelected", "Back"], options);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/** One row of the List view. An item with no `Id` renders as text rather than a link. */
export interface ManagedListItem {
  Heading?: string;
  Description?: string;
  /** An illustration name from Connect's fixed set, e.g. `"School"`. */
  Icon?: CardIconName;
  /** Makes the row selectable, and is what comes back as `actionName`. */
  Id?: string;
}

export interface ListViewInputs {
  Items: ManagedListItem[];
  Heading?: string;
  SubHeading?: string;
  AttributeBar?: ManagedAttribute[];
  Back?: ManagedAction;
  Style?: object;
}

export type ListViewActions = "ActionSelected" | "Back";

/** The AWS-managed **List** view: headings and descriptions, optionally selectable. */
export function awsListView(
  options: AwsManagedViewOptions,
): ShowableView<ListViewInputs, ActionSelectedResult, ListViewActions> {
  return managed("list", ["ActionSelected", "Back"], options);
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** A card's face, shown in the grid. */
export interface ManagedCardSummary {
  /** Required, and what comes back when the card's own actions are not used. */
  Id: string;
  Heading: string;
  Description?: string;
  /** An illustration name from Connect's fixed set, e.g. `"Car Side View"`. */
  Icon?: CardIconName;
  /** A line of context under the heading, e.g. `"Upcoming Sept 17, 2022"`. */
  Status?: string;
}

/** What opening a card reveals: the Detail view, inline. */
export interface ManagedCardDetail {
  Heading?: string;
  Description?: string;
  Sections?: ManagedSectionContent;
  Actions?: string[];
}

export interface ManagedCard {
  Summary: ManagedCardSummary;
  Detail?: ManagedCardDetail;
}

export interface CardsViewInputs {
  Cards: ManagedCard[];
  Heading?: string;
  /** One of 1, 2, 3, 4, 6 or 12 — the grid is twelve columns wide. */
  CardsPerRow?: 1 | 2 | 3 | 4 | 6 | 12;
  AttributeBar?: ManagedAttribute[];
  Back?: ManagedAction;
  /** The escape hatch under the grid, for when none of the cards fit. */
  NoMatchFound?: ManagedAction;
  Style?: object;
}

export type CardsViewActions = "ActionSelected" | "Back" | "NoMatchFound";

/** The AWS-managed **Cards** view: pick a topic, then see its detail. */
export function awsCardsView(
  options: AwsManagedViewOptions,
): ShowableView<CardsViewInputs, ActionSelectedResult, CardsViewActions> {
  return managed("cards", ["ActionSelected", "Back", "NoMatchFound"], options);
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

export interface ConfirmationViewInputs {
  /** Required: what just happened. */
  Heading: string;
  SubHeading?: string;
  AttributeBar?: ManagedAttribute[];
  /** `{ Include: true }` shows the tick illustration. */
  Graphic?: { Include: boolean };
  Next?: ManagedAction;
  Style?: object;
}

/** Confirmation reports the button's label alongside the action, unlike the selection views. */
export interface ConfirmationViewResult {
  actionName: string;
  Label: string;
}

/** The AWS-managed **Confirmation** view: the end of a form, with one way onward. */
export function awsConfirmationView(
  options: AwsManagedViewOptions,
): ShowableView<ConfirmationViewInputs, ConfirmationViewResult, "Next"> {
  return managed("confirmation", ["Next"], options);
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

/** A field in a `FormSection`. `Type` picks which one; `Name` is the key it submits under. */
export interface ManagedFormField {
  Name: string;
  Type?:
    | "FormInput"
    | "TextArea"
    | "DatePicker"
    | "TimePicker"
    | "Dropdown"
    | "RadioGroup"
    | "CheckboxGroup"
    | "Checkbox"
    | "Toggle"
    | "Address"
    | "CreditCard";
  Label?: string;
  DefaultValue?: unknown;
  Required?: boolean;
  HelperText?: string;
  InputType?: "number" | "text" | "password" | "email" | "tel" | "url";
  /** Fills the width of its column. */
  Fluid?: boolean;
  Options?: Array<{ Label?: string; Value?: string; Description?: string }>;
  MultiSelect?: boolean;
}

/** A read-only row in a `DataSection`. */
export interface ManagedDataItem {
  Label: string;
  Value: string;
  Name?: string;
  Copyable?: boolean;
  LinkType?: LinkType;
  Url?: string;
  ResourceId?: string;
  ApplicationName?: string;
  AutoOpen?: boolean;
}

export interface ManagedFormSection {
  /** `FormSection` collects input; `DataSection` displays labels and values. */
  Type: "FormSection" | "DataSection";
  Heading?: string;
  Items: Array<ManagedFormField | ManagedDataItem>;
  /** Puts an edit button on a `DataSection`'s header, which raises the `Edit` slot's action. */
  IsEditable?: boolean;
  Configuration?: { Layout?: { Columns?: string | number | Array<string | number> } };
}

/** One step in the progress tracker down the left-hand side. */
export interface ManagedWizardStep {
  Heading: string;
  Optional?: boolean;
  Selected?: boolean;
}

export interface FormViewInputs {
  /** Required. The fields, grouped. */
  Sections: ManagedFormSection[];
  Heading?: string;
  SubHeading?: string;
  /** A server-side failure to show above the form. */
  ErrorText?: string | { Heading?: string; Content?: string };
  AttributeBar?: ManagedAttribute[];
  /** Shows the progress tracker, one entry per step. */
  Wizard?: ManagedWizardStep[];
  Next?: ManagedAction;
  Back?: ManagedAction;
  Previous?: ManagedAction;
  Cancel?: ManagedAction;
  Edit?: ManagedAction;
  Style?: object;
}

/**
 * What the Form view submits: the field values, keyed by `Name`, under `FormData`.
 *
 * Nested one level down, unlike an authored view, whose fields are read straight off
 * `$.Views.ViewResultData`. So the flow reads `result.FormData.pickup_location`.
 */
export interface FormViewResult<Fields extends object> {
  FormData: Fields;
  /** The heading of the step that was submitted. */
  StepName: string;
}

export type FormViewActions = "Next" | "Back" | "Step";

/**
 * The AWS-managed **Form** view (`FormWithSteps`): a multi-step form with a progress tracker.
 *
 * The fields are data rather than template, so the submitted shape is declared at the call site:
 *
 * ```ts
 * const form = awsFormView<{ pickup_location: string; pickup_day: string }>({ region: "us-east-1" });
 *
 * const result = form.show({
 *   data: {
 *     Heading: "Modify reservation",
 *     Next: { Label: "Confirm" },
 *     Sections: [
 *       {
 *         Type: "FormSection",
 *         Heading: "Pickup",
 *         Items: [
 *           { Type: "FormInput", Name: "pickup_location", Label: "Location" },
 *           { Type: "DatePicker", Name: "pickup_day", Label: "Day" },
 *         ],
 *       },
 *     ],
 *   },
 *   on: { Next: (r) => setAttributes({ where: r.FormData.pickup_location }) },
 * });
 * ```
 *
 * Note the actions: the view resource declares `Next`, `Back` and `Step` — `Step` is what the wizard
 * and a `DataSection`'s edit button raise. The published reference shows a `Submit` action in its
 * output example instead, which is not in the resource's list; the resource is what the flow branches
 * on, so that is what this declares.
 */
export function awsFormView<Fields extends object = Record<string, string>>(
  options: AwsManagedViewOptions,
): ShowableView<FormViewInputs, FormViewResult<Fields>, FormViewActions> {
  return managed("form", ["Next", "Back", "Step"], options);
}

// ---------------------------------------------------------------------------
// After Contact Work
// ---------------------------------------------------------------------------

/**
 * Inputs of the AWS-managed **After Contact Work** view.
 *
 * The odd one out: an ordinary template, so its inputs are the individual `$.` references its
 * components carry rather than one composite's properties. Every one is a string, and the dropdowns'
 * options are baked into the template — `Category_DefaultValue` has to be one of them.
 *
 * Since it is an ordinary template, it is also the one managed view worth reproducing rather than
 * calling: build your own with `defineView` when the disposition codes below are not yours.
 */
export interface AfterContactWorkViewInputs {
  CustomerName?: string;
  PhoneNumber?: string;
  /** A link in the attribute bar. */
  Example_Label?: string;
  Example_Url?: string;
  ContactWrapUp_Header_Title?: string;
  ContactWrapUp_Header_Description?: string;
  Disposition_Header_Title?: string;
  Disposition_Header_Description?: string;
  /** `"Support"` or `"Sales"`. */
  Category_DefaultValue?: string;
  /** One of the six drivers the template lists, e.g. `"Billing inquiries"`. */
  Driver_DefaultValue?: string;
  /** `"Very Satisfied"` … `"Very Unsatisfied"`. */
  Satisfaction_DefaultValue?: string;
  /** `"Yes"` or `"No"`. */
  FollowUp_DefaultValue?: string;
  /** `"Yes"` or `"No"`. */
  Resolved_DefaultValue?: string;
  ContactSummary_Header_Title?: string;
  ContactSummary_Header_Description?: string;
  ContactSummary_DefaultValue?: string;
  AdditionalNotes_Header_Title?: string;
  AdditionalNotes_Header_Description?: string;
  AdditionalNotes_DefaultValue?: string;
}

/**
 * What the After Contact Work view submits.
 *
 * The five dropdowns come back as arrays, so the flow reads `result.Category.at(0)` — AWS's own sample
 * flow stores `$.Views.ViewResultData.Category.0`. The two text areas are plain strings.
 */
export interface AfterContactWorkViewResult {
  Category: string[];
  Driver: string[];
  Satisfaction: string[];
  FollowUp: string[];
  Resolved: string[];
  ModifiedSummary: string;
  ContactNotes: string;
}

export type AfterContactWorkViewActions = "Submit" | "Cancel";

/** The AWS-managed **After Contact Work** view: disposition codes, summary and notes. */
export function awsAfterContactWorkView(
  options: AwsManagedViewOptions,
): ShowableView<
  AfterContactWorkViewInputs,
  AfterContactWorkViewResult,
  AfterContactWorkViewActions
> {
  return managed("after-contact-work", ["Submit", "Cancel"], options);
}
