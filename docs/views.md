# Views

Authoring, deploying and reading back a view. See the [README](../README.md) to get started.

## Authoring

Components are functions, and `defineView` assembles the
template Connect wants. The body is a function so that the inputs and actions it may reference are
handed to it already typed:

```ts
import {
  defineView, shape, Container, TextBox, AttributeBar, Table, FormInput, Button,
} from "pulumi-amazon-connect";

interface OrderPickerInputs {
  customerName: string;
  orders: Array<{ order: string; status: string }>;
}

interface OrderPickerOutputs {
  notes: string;
  OrderTable: Array<{ order_id: string }>;
}

export const orderPicker = defineView({
  title: "Choose an order",
  actions: ["OrderSelected", "Skip"],
  inputs: shape<OrderPickerInputs>(),
  outputs: shape<OrderPickerOutputs>(),
  body: ({ inputs, actions, fields }) =>
    Container({}, [
      TextBox("Recent orders", { variant: "h2", fontSize: "heading-l" }),
      AttributeBar({ attributes: [{ label: "Customer", value: inputs.customerName }] }),
      Table({
        name: fields.OrderTable,
        items: inputs.orders,
        columns: [{ label: "Order", id: "order_id" }],
        actions: [{ label: "Open", action: actions.OrderSelected }],
      }),
      FormInput({ name: fields.notes, label: "Notes" }),
      Button({ action: actions.Skip }, ["Skip"]),
    ]),
});
```

`inputs.customerName` *is* the string `"$.customerName"` — the reference is generated from the declared
type, so a typo is a compile error instead of a property that silently renders as literal text. Likewise
`actions.Skip` is the string `"Skip"` and `fields.notes` is the field name `"notes"`, both checked against
their declarations. All three are optional; without them, write the strings yourself.

The three declarations are the view's whole contract, and each one is a spelling the flow has to agree
with. `fields` is the one that matters most, because a field's `Name` is what the flow reads back as
`$.Views.ViewResultData.<name>` — nothing at runtime compares those two spellings, so a mismatch is an
empty reference and no error anywhere. Declaring `outputs` also makes assembly reject a field whose name
did not come from `fields`.

`defineView` assigns each node the `_id` Connect requires, collects the `Actions` list from the tree, and
fails if the tree and the declared `actions` disagree in either direction — an action nothing raises is a
branch the flow can never take, and one that is raised but undeclared is a dead end for whoever hits it.
It also returns `fields`, the input names collected from the form components, and rejects two fields
sharing a name.

Wrap the body in a `Container`. Connect validates the top level of a body strictly and rejects a node
that holds other components there, while accepting the identical nesting one level down; every
AWS-managed view's body is a single container for this reason. `defineView` checks this and says so.

### JSX

The component library's own documentation is written in JSX, and it works here with no runtime
involved — JSX is a compile-time transform, so it produces exactly the tree the functional API produces.
Point `jsxImportSource` at this library:

```jsonc
// tsconfig.json
{ "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "pulumi-amazon-connect" } }
```

```tsx
export const orderPicker = defineView({
  title: "Choose an order",
  actions: ["OrderSelected", "Skip"],
  inputs: shape<OrderPickerInputs>(),
  body: ({ inputs, actions }) => (
    <Container>
      <TextBox variant="h2">Recent orders</TextBox>
      <TextBox>{["Hello ", inputs.customerName]}</TextBox>
      <Button action={actions.Skip}>Skip</Button>
    </Container>
  ),
});
```

Text between tags becomes the component's content, which is where Connect wants it. Nothing is imported
at runtime beyond the components themselves, and `{cond && <TextBox>…</TextBox>}` is fine — the `false`
a conditional leaves behind is dropped.

`<>…</>` groups siblings where one component is expected — inside a conditional, or as the whole body —
and adds no level of nesting to the published template, since it is flattened into its parent's content.
A helper component may return several nodes for the same reason:

```tsx
const Instructions = (): ViewNode[] => [
  <TextBox variant="h3">Before you continue</TextBox>,
  <TextBox>Confirm the caller's date of birth.</TextBox>,
];

body: ({ actions }) => (
  <Container>
    <Instructions />
    {needsWarning && (
      <>
        <TextBox variant="h4">Account on hold</TextBox>
        <TextBox>Transfer to billing.</TextBox>
      </>
    )}
    <Button action={actions.Next}>Next</Button>
  </Container>
)
```

A body is a list of components, so text at its top level is an error rather than a `Body` entry Connect
would reject — put it in a `TextBox`.

### Item lists

A few components carry their contents in a *property* rather than in their content: a `ButtonGroup`'s
buttons are `Items`, an `AttributeBar`'s attributes are `Attributes`. Written out, those lists are object
literals in the middle of a component tree — so each has a pseudo-component that writes the same list as
children:

```tsx
<AttributeBar>
  <Attribute label="DMS Reference" value={inputs.docRef} url={inputs.docRefLink} linkType="external" />
</AttributeBar>

<ButtonGroup spaceBetween="s">
  <GroupButton label="Search" action={actions.Search} formAction="submit" />
  <GroupButton label="Search Prescriber" action={actions.SearchPrescriber} formAction="submit" />
</ButtonGroup>
```

`<Attribute>` serves `AttributeBar` and `AttributeSection`; `<GroupButton>` serves `ButtonGroup` and a
`Table`'s header buttons; `<Column>` serves `Table`. Each folds into the parent's property, so the tree,
and therefore the published template, is identical to the `items={[…]}` form — which still works, and is
still the way to pass a `$.` reference to a whole list. Passing both is an error rather than a merge,
since one of the two would be silently ignored.

A `Table` carries two such lists at once, and sorts its children by which pseudo-component they are:

```tsx
<Table items={inputs.orders} name={fields.OrderTable} tableAction={actions.OrderSelected} filterable>
  <Column label="Order" id="order_id" type="action" />
  <Column label="Priority" id="priority" editableType="select" options={["1", "2", "3"]} />
  <GroupButton label="Save" action={actions.Save} variant="primary" formAction="submit" />
</Table>
```

Neither is a component in its own right, and neither exists on the wire: `<GroupButton>` is not
`<Button>` — a group's buttons take a `label` and a `formAction`, which a bare `Button` refuses. Used
anywhere but inside its parent, `defineView` rejects it and names the component it belongs to. That check
is a runtime one by necessity: TypeScript types every JSX expression as `JSX.Element`, so "this child
must be a `GroupButton`" is not something the type system can be told. The functional form does get it
checked, because there the child's real type survives:

```ts
ButtonGroup({ spaceBetween: "s" }, [GroupButton({ label: "Search", action: actions.Search })])
```

The component and property sets come from two places that check each other. The
[component library docs](https://d3irlmavjxd3d8.cloudfront.net/) publish a complete JSON Schema per
component, and Connect validates templates with AJV and enforces `additionalProperties: false`, so
publishing reports an unknown property by name. Every component here is documented *and* confirmed by
publishing.

Both sources are needed. The service alone cannot tell you a property is wrong when the schema does not
seal `Props` — `TextBox` accepts a `Text` property and silently drops it, because the text is really
its content. And the docs alone do not tell you what a given instance accepts: `Container` documents
`header`/`footer` while the service also takes `HideBorder`.

That is also why `Button` has no `label`: Connect rejects it, and the label is the button's content.
`SubmitButton` does take one, and requires it.

### Layout

`Configuration` is a sibling of a component's `Props`, not one of them — it is on the *base* component
definition in the service's schema, sealed to `Layout` and `Style`, so every component takes one. It is
exposed on `Container`, `Section`, `Form` and `AttributeSection`, where it means something:

```ts
Form({ hideBorder: true, configuration: { Layout: { Align: "right" } } }, [
  // One span for all the children, so the fields stack full width.
  Section({ configuration: { Layout: { Align: "left", Columns: "12" } } }, [...]),
])
```

`defineView`'s own `configuration` is the same shape, applied to the whole view through `Head`.

### Submitting a form

Two components submit a `Form`, and they are not interchangeable. `SubmitButton` is one button that
does it. A `ButtonGroup` item does it through `formAction`, which is how a form gets a Submit *and* a
Cancel beside it:

```ts
ButtonGroup({
  spaceBetween: "s",
  items: [
    { label: "Cancel", action: actions.Cancel, formAction: "none" },
    { label: "Submit", action: actions.Submit, variant: "primary", formAction: "submit" },
  ],
})
```

`formAction` defaults to `"none"`, so a group whose buttons should submit has to say so. Otherwise a
`ButtonGroup` item takes everything a `Button` does — variant, icon, `disabled`, `loading`, `href` —
plus the `label` a bare `Button` refuses. In JSX the same group is written as `<GroupButton>` children;
see [Item lists](#item-lists).

### Tables

A `Table` is the component with the most moving parts, and the one usually fed straight from a Lambda:

```ts
Table({
  items: lookup.orders,              // a `$.` reference, or the rows themselves
  name: fields.OrderTable,           // the key the flow reads the chosen row back under
  tableAction: actions.OrderSelected,
  header: "Recent orders",
  description: "Pick one, or fix a priority in place",
  filterable: true,                  // the search box
  itemsPerPage: 5,                   // without it there is no pager and every row shows
  columnWidth: "flexible",           // "flexible" columns are resizable; "locked" are not
  columns: [
    { label: "Order", id: "order_id", type: "action" },
    { label: "Status", id: "status" },
    { label: "Priority", id: "priority", editableType: "select", options: ["1", "2", "3"] },
    { label: "Notes", id: "notes", editableType: "input" },
  ],
  actions: [{ label: "Save", action: actions.Save, variant: "primary", formAction: "submit" }],
})
```

A column's heading is `label`, and `id` is the row key it shows — both are required. Beware the
near-miss: `Header` is the heading above the *whole table*, and a column given one renders with a blank
heading rather than an error, because Connect has no component schema for `Table` and accepts a literal
column list whatever it contains.

There are two ways a row leaves the table, and a table can use both:

- **An action column.** `type: "action"` renders its cells as links; clicking one raises `tableAction`
  with that row as the submitted data. `tableAction` is required once a column is an action column,
  since Connect's own fallback is a branch named `"TableAction"`.
- **A submitting action.** A header button with `formAction: "submit"` submits the table's rows along
  with the enclosing `Form`, which is how edits get out.

`editableType` makes a column editable in place — `"input"` for free text, `"select"` for a dropdown
over `options`, which that variant requires. Editability can vary by row: a row may carry
`_Configuration: { EditableDisabled: ["priority"] }` alongside its values, naming the columns that row
will not let the agent change.

Either list may instead be a `$.` reference to the whole thing (`columns: "$.Cols"`), which is also the
one place Connect checks their shape — see [wire-format checks](wire-format-checks.md).

### Passing data in

A `$.Something` reference declares an input when it is the **entire** value of a property, or an entire
item of a component's content. Connect derives the view's `InputSchema` from those references and
returns it from `CreateView`:

```ts
AttributeBar({ attributes: [{ label: "Customer", value: "$.CustomerName" }] })
TextBox(["Hello ", "$.CustomerName", ", welcome back."])
// -> both declare an input named CustomerName
```

Interpolation is a list, not a template string. A reference **inside** a longer string declares nothing
and renders literally, so `TextBox("Hello $.CustomerName")` would put that text in front of a customer
— `defineView` rejects it and points you at the list form.

`$.#Name` is a different thing again: an integration reference, which must be declared in the view's
`Head`. This library does not support integrations yet.

### Deploying a view

`ConnectView` deploys the view and is showable itself, so nothing gets redeclared:

```ts
const picker = new ConnectView("order-picker", {
  instanceArn: instance.arn,
  view: orderPicker,
});
```

The classic `aws` provider still has no View resource as of 7.41, so this is the one place the library
uses [`@pulumi/aws-native`](https://www.pulumi.com/registry/packages/aws-native/), which mirrors
`AWS::Connect::View`. It needs its own region setting:

```sh
pulumi config set aws-native:region us-east-1
```

A view deployed this way has no id while the flow is being recorded, so `show` embeds a deferred token
and `ContactFlow` substitutes the real ARN — qualified `:$LATEST`, which is what console-exported flows
reference. Override with `viewVersion`.

For a view this program did not create, `existingView` takes an id and the types:

```ts
const picker = existingView({
  viewId: config.require("orderPickerViewId"),
  actions: ["OrderSelected", "Skip"],
  input: shape<{ customerName: string }>(),
  output: shape<{ OrderTable: Array<{ order_id: string }> }>(),
});
```

If you already have the authored view but it is deployed by another stack, pass it instead of retyping:
`existingView({ viewId, view: orderPicker })`. `toViewInputContent` is still there for calling
`CreateView` directly.

### Reading what the participant submitted

`show()` returns references shaped like the declared output type, on the paths a flow actually uses.
Tables are addressed positionally, because that is how Connect reports the row that was chosen:

```ts
const result = picker.show({
  data: { customerName: attr("name"), orders: lookup.orders },
  on: {
    OrderSelected: (r) => setAttributes({ orderId: r.OrderTable.at(0).order_id }),
    Skip: () => play("No problem."),
  },
});

result.notes                        // Ref<string> -> $.Views.ViewResultData.notes
result.OrderTable.at(0).order_id    // Ref<string> -> $.Views.ViewResultData.OrderTable.0.order_id
```

A `Dropdown` is addressed positionally too, because it submits an array whether or not it is a
multi-select — declare it as one and read the first element:

```ts
outputs: shape<{ Category: string[] }>()
result.Category.at(0)               // Ref<string> -> $.Views.ViewResultData.Category.0
```

`on` is optional and partial. An action with no handler continues with whatever follows the `show` call,
so a run of screens reads as a run of statements rather than nesting one inside the next:

```ts
const details = intake.show({ data: { customerName } });
setAttributes({ name: details.fullName });

const confirm = review.show({ data: { name: details.fullName } });
setAttributes({ confirmed: confirm.agreed });
```

Give an action a handler when it should do something *different* — a Back button that jumps elsewhere.
The submitted references are passed to each handler as an argument, since handlers are recorded
*during* the `show` call and so cannot close over its return value.

Note that `$.Views.ViewResultData` is overwritten by the next `show`, so read a view's results into
attributes before showing another one, as above. Reading them afterwards is an error where it is
written rather than a wrong value at contact time — see
[Results that a later action overwrites](flows.md#results-that-a-later-action-overwrites).

`actions`, `inputs` and `outputs` are all optional: a view that only displays something declares none
of them, and `show({})` takes no arguments at all.

### The action the participant chose

Connect reports the action twice: as a *branch* out of the `ShowView` block, and as `$.Views.Action`.
The branch is what `on` handles; the reference is `$action` on the result, typed as the declared action
union:

```ts
// picker declared its actions as ["OrderSelected", "Skip"], so that is the type of the ref.
result.$action                      // Ref<"OrderSelected" | "Skip"> -> $.Views.Action
setAttributes({ chose: result.$action });
```

Reach for `$action` to carry the choice onward without duplicating it — one `setAttributes` after the
call instead of a literal inside every branch. Branch with `on` when the actions should do something
*different*.

The key is `$`-prefixed because a component's `Name` becomes a path segment and `$` is illegal there,
so no view can submit a field that shadows it. It sits beside `$.Views.ViewResultData`, not inside it,
which is why it is not part of the declared output type.

Beware of the near-namesake on the AWS-managed views below: their `actionName` is an ordinary output
field holding the *chosen item's* id or label, which is not the same thing as the action that branched.

References read `$.Views.ViewResultData` and `$.Views.Action`, both of which the next `showView`
overwrites, so reading either after another view has been shown throws while the flow is being built.

## The views Connect ships

Every instance has six AWS-managed views, and five of them are not templates worth reproducing: each
body is a *single* composite component — `CardsView`, `DetailsView`, `ListView`, `ConfirmationView`,
`FormWithSteps` — whose every property is a `$.` reference. The whole view is a pass-through, so all of
its content is `ViewData` the flow supplies. There is nothing to author, only something to call:

```ts
import { awsCardsView, awsFormView } from "pulumi-amazon-connect";

// The ARN carries the region and no account, and there is no ambient region while recording.
const cards = awsCardsView({ region: "us-east-1" });

cards.show({
  data: {
    Heading: "Customer may be contacting about...",
    Back: { Label: "Back" },
    NoMatchFound: { Label: "Can't find a match?" },
    Cards: [
      {
        Summary: { Id: "lost_luggage", Icon: "Suitcase", Heading: "Lost luggage claim" },
        Detail: { Sections: { TemplateString: "<p>Usually 5-8 minutes</p>" }, Actions: ["Start"] },
      },
    ],
  },
  on: { ActionSelected: (r) => setAttributes({ topic: r.actionName }) },
});
```

Each one's input type is transcribed from the `InputSchema` Connect derives for it, so a card's
`Summary.Id` and a wizard step's `Heading` are checked. Two things are worth knowing:

- **They report the choice as `actionName`.** `$.Views.ViewResultData.actionName` is the label of the
  action or the `Id` of the item that was chosen, so ids have to be distinct. Confirmation also reports
  `Label`, and the Form view nests the field values under `FormData` — `r.FormData.pickup_location`,
  a level deeper than an authored view. This is not `$action`, which on these views is only ever
  `ActionSelected` — the branch, not the thing inside the view that was clicked.
- **Their actions come from slot names.** `Back`, `Next`, `NoMatchFound` and `Step` appear in a view's
  `Actions` list without appearing anywhere in its template: the slot raises its own name unless the
  data passed in renames it with `Action`. Each wrapper declares the list its view resource declares.

The sixth, After Contact Work, *is* an ordinary template built from ordinary components. It has a
wrapper too — `awsAfterContactWorkView` — but its dispositions are AWS's, so it is more likely a
starting point: `test/awsManagedViews.test.ts` reproduces it with `defineView` and asserts the result
against what `describe-view` returns, which makes it a worked example of everything above.

Not yet done: `ExpandableSection`, `HTMLBox`, `Detail`, and view
integrations. The five composite components are not exposed as components either — there is no reason
to build a template around one when AWS already publishes that template.
