/** @jsxImportSource pulumi-amazon-connect */

/**
 * JSX authoring.
 *
 * JSX is a compile-time transform, so this produces exactly the tree the functional API produces —
 * which is what these tests assert. Nothing React-related is involved and nothing extra is shipped.
 *
 * The pragma above stands in for the `jsxImportSource` a consuming project would set in its tsconfig.
 */

import { describe, expect, it } from "vitest";
import {
  Attribute,
  AttributeBar,
  AttributeSection,
  Button,
  ButtonGroup,
  Column,
  Container,
  defineView,
  Form,
  FormInput,
  GroupButton,
  shape,
  SubmitButton,
  Table,
  TextBox,
  type ViewNode,
} from "../src/index.js";

interface OrderInputs {
  customerName: string;
  orders: Array<{ order: string; status: string }>;
}

describe("jsx and the functional API agree", () => {
  it("produces an identical tree", () => {
    const built = defineView({
      title: "Orders",
      actions: ["Skip"],
      inputs: shape<OrderInputs>(),
      body: ({ inputs, actions }) => (
        <Container hideBorder>
          <TextBox variant="h2">Recent orders</TextBox>
          <TextBox>{["Hello ", inputs.customerName]}</TextBox>
          <Button action={actions.Skip} variant="primary">
            Skip
          </Button>
        </Container>
      ),
    });

    const functional = defineView({
      title: "Orders",
      actions: ["Skip"],
      inputs: shape<OrderInputs>(),
      body: ({ inputs, actions }) =>
        Container({ hideBorder: true }, [
          TextBox("Recent orders", { variant: "h2" }),
          TextBox(["Hello ", inputs.customerName]),
          Button({ action: actions.Skip, variant: "primary" }, ["Skip"]),
        ]),
    });

    expect(built.Template).toEqual(functional.Template);
    expect(built.Actions).toEqual(["Skip"]);
  });

  it("passes text children through as content, not props", () => {
    const view = defineView({
      title: "Text",
      actions: ["Go"],
      body: ({ actions }) => (
        <Container>
          <TextBox variant="h3">Heading</TextBox>
          <Button action={actions.Go}>Go</Button>
        </Container>
      ),
    });

    const [textbox, button] = (view.Template.Body[0] as ViewNode).Content as ViewNode[];
    // Text children land as content, and never as a Text property, which TextBox does not have.
    expect(textbox?.Content).toEqual(["Heading"]);
    expect(textbox?.Props).toEqual({ Variant: "h3" });
    expect(button?.Content).toEqual(["Go"]);
    expect(button?.Props).toEqual({ Action: "Go" });
  });

  it("drops the gaps a conditional leaves behind", () => {
    const withExtra = (show: boolean) =>
      defineView({
        title: "Conditional",
        actions: ["Go"],
        body: ({ actions }) => (
          <Container>
            {show && <TextBox>Extra</TextBox>}
            <Button action={actions.Go}>Go</Button>
          </Container>
        ),
      });

    expect((withExtra(false).Template.Body[0] as ViewNode).Content).toHaveLength(1);
    expect((withExtra(true).Template.Body[0] as ViewNode).Content).toHaveLength(2);
  });

  it("still collects fields and actions from a JSX tree", () => {
    const view = defineView({
      title: "Intake",
      actions: ["Save"],
      body: ({ actions }) => (
        <Form>
          <FormInput name="account" label="Account" required />
          <SubmitButton label="Save" action={actions.Save} />
        </Form>
      ),
    });

    expect(view.fields).toEqual(["account"]);
    expect(view.Actions).toEqual(["Save"]);
  });
});

/**
 * Several siblings from one element.
 *
 * A fragment and an array-returning component are the same thing to this runtime — a component whose
 * result is flattened into its parent's content — so neither leaves a trace in the template. That is
 * what these assert: the tree, ids included, is the one writing the children in place produces.
 */
describe("fragments", () => {
  it("is identical to writing the children in place", () => {
    const body = (wrapped: boolean) =>
      defineView({
        title: "Fragment",
        body: () =>
          wrapped ? (
            <Container>
              <TextBox variant="h2">Heading</TextBox>
              <>
                <TextBox>One</TextBox>
                <TextBox>Two</TextBox>
              </>
            </Container>
          ) : (
            <Container>
              <TextBox variant="h2">Heading</TextBox>
              <TextBox>One</TextBox>
              <TextBox>Two</TextBox>
            </Container>
          ),
      });

    // Ids come from position, so an equal template also means the fragment added no level of nesting.
    expect(body(true).Template).toEqual(body(false).Template);
  });

  it("holds a component that returns several nodes", () => {
    // The reason `ViewComponent` returns `ViewNode | ViewChild[]`: a helper like this is the functional
    // half of a fragment, and has to be usable as `<Lines/>` rather than only as `{Lines()}`.
    const Lines = (): ViewNode[] => [TextBox("One"), TextBox("Two")];

    const view = defineView({
      title: "Fragment",
      body: () => (
        <Container>
          <Lines />
        </Container>
      ),
    });

    const content = (view.Template.Body[0] as ViewNode).Content as ViewNode[];
    expect(content.map((node) => node.Content)).toEqual([["One"], ["Two"]]);
    expect(content.map((node) => node._id)).toEqual(["container-0-textbox-0", "container-0-textbox-1"]);
  });

  it("groups the siblings a conditional or a map produces", () => {
    const show: boolean = true;
    const hide: boolean = false;
    const view = defineView({
      title: "Fragment",
      body: () => (
        <Container>
          {show && (
            <>
              <TextBox>One</TextBox>
              <TextBox>Two</TextBox>
            </>
          )}
          {hide && (
            <>
              <TextBox>Never</TextBox>
            </>
          )}
          {["a", "b"].map((letter) => (
            <>
              <TextBox>{letter}</TextBox>
            </>
          ))}
        </Container>
      ),
    });

    const content = (view.Template.Body[0] as ViewNode).Content as ViewNode[];
    expect(content.map((node) => node.Content)).toEqual([["One"], ["Two"], ["a"], ["b"]]);
  });

  it("can be the whole body", () => {
    const view = defineView({
      title: "Fragment",
      body: () => (
        <>
          <Container>First</Container>
          <Container>Second</Container>
        </>
      ),
    });

    expect(view.Template.Body.map((node) => node._id)).toEqual(["container-0", "container-1"]);
  });

  it("folds into an item list like the items written directly", () => {
    const group = (wrapped: boolean) =>
      defineView({
        title: "Fragment",
        actions: ["Search", "Cancel"],
        body: ({ actions }) =>
          wrapped ? (
            <ButtonGroup>
              <>
                <GroupButton label="Search" action={actions.Search} />
                <GroupButton label="Cancel" action={actions.Cancel} />
              </>
            </ButtonGroup>
          ) : (
            <ButtonGroup>
              <GroupButton label="Search" action={actions.Search} />
              <GroupButton label="Cancel" action={actions.Cancel} />
            </ButtonGroup>
          ),
      });

    expect(group(true).Template).toEqual(group(false).Template);
    expect(group(true).Actions).toEqual(["Search", "Cancel"]);
  });

  it("rejects text at the top level of the body", () => {
    expect(() =>
      defineView({
        title: "Fragment",
        body: () => (
          <>
            Loose text
            <Container>Body</Container>
          </>
        ),
      }),
    ).toThrow(/text at the top level of its body: "Loose text"/);
  });
});

/**
 * Item lists as children.
 *
 * A `ButtonGroup`'s buttons and an `AttributeBar`'s attributes live in a *property*, so written out
 * they are object literals in the middle of a component tree. `<GroupButton>` and `<Attribute>` are the
 * same lists as children; they fold into the property, so the tree is unchanged.
 */
describe("item children", () => {
  it("builds the same ButtonGroup as the items property", () => {
    const items = (
      <ButtonGroup spaceBetween="s">
        <GroupButton label="Cancel" action="Cancel" formAction="none" />
        <GroupButton label="Submit" action="Submit" variant="primary" formAction="submit" />
      </ButtonGroup>
    );

    expect(items).toEqual(
      ButtonGroup({
        spaceBetween: "s",
        items: [
          { label: "Cancel", action: "Cancel", formAction: "none" },
          { label: "Submit", action: "Submit", variant: "primary", formAction: "submit" },
        ],
      }),
    );
  });

  it("builds the same attribute lists as the attributes and items properties", () => {
    const bar = (
      <AttributeBar>
        <Attribute label="Reference" value="$.DocRef" url="$.DocRefLink" linkType="external" />
        <Attribute label="Customer" value="$.CustomerName" copyable />
      </AttributeBar>
    );
    const section = (
      <AttributeSection heading="Order" columns={2}>
        <Attribute label="Order" value="$.OrderId" />
      </AttributeSection>
    );

    expect(bar).toEqual(
      AttributeBar({
        attributes: [
          { label: "Reference", value: "$.DocRef", url: "$.DocRefLink", linkType: "external" },
          { label: "Customer", value: "$.CustomerName", copyable: true },
        ],
      }),
    );
    expect(section).toEqual(
      AttributeSection({ heading: "Order", columns: 2, items: [{ label: "Order", value: "$.OrderId" }] }),
    );
  });

  it("builds a Table from its two kinds of item child", () => {
    // A table holds both lists at once, so its children are sorted by which pseudo-component they
    // are rather than by position.
    const table = (
      <Table items="$.Orders" name="OrderTable" tableAction="OrderSelected" filterable>
        <Column label="Order" id="order_id" type="action" />
        <Column label="Priority" id="priority" editableType="select" options={["1", "2"]} />
        <GroupButton label="Save" action="Save" variant="primary" formAction="submit" />
      </Table>
    );

    expect(table).toEqual(
      Table({
        items: "$.Orders",
        name: "OrderTable",
        tableAction: "OrderSelected",
        filterable: true,
        columns: [
          { label: "Order", id: "order_id", type: "action" },
          { label: "Priority", id: "priority", editableType: "select", options: ["1", "2"] },
        ],
        actions: [{ label: "Save", action: "Save", variant: "primary", formAction: "submit" }],
      }),
    );
  });

  it("collects actions and references from item children", () => {
    const view = defineView({
      title: "Search",
      actions: ["Search", "SearchPrescriber"],
      inputs: shape<{ docRef: string }>(),
      body: ({ inputs, actions }) => (
        <Container>
          <AttributeBar>
            <Attribute label="Reference" value={inputs.docRef} />
          </AttributeBar>
          <ButtonGroup>
            <GroupButton label="Search" action={actions.Search} formAction="submit" />
            <GroupButton label="Search Prescriber" action={actions.SearchPrescriber} />
          </ButtonGroup>
        </Container>
      ),
    });

    // Both come out of the folded item lists, exactly as they do from the property form.
    expect(view.Actions).toEqual(["Search", "SearchPrescriber"]);
    expect(JSON.stringify(view.Template)).toContain("$.docRef");
  });

  it("flattens a mapped list and drops a conditional entry", () => {
    const labels = ["A", "B"];
    const group = (show: boolean) => (
      <ButtonGroup>
        {labels.map((label) => (
          <GroupButton label={label} />
        ))}
        {show && <GroupButton label="Extra" />}
      </ButtonGroup>
    );

    expect(group(false).Props.Items).toEqual([{ Label: "A" }, { Label: "B" }]);
    expect(group(true).Props.Items).toHaveLength(3);
  });

  it("rejects both a property and children, since one of them would be ignored", () => {
    expect(() => (
      <ButtonGroup items={[{ label: "Cancel" }]}>
        <GroupButton label="Submit" />
      </ButtonGroup>
    )).toThrow(/both `items` and <GroupButton> children/);
  });

  it("rejects a list given neither way", () => {
    expect(() => <AttributeBar />).toThrow(/AttributeBar has no attributes/);
  });

  it("rejects a child that is not an entry of the list", () => {
    expect(() => (
      <ButtonGroup>
        {/* A real Button is a different component: no label, no formAction. */}
        <Button action="Go">Go</Button>
      </ButtonGroup>
    )).toThrow(/takes only <GroupButton> children, but was given <Button>/);
  });

  it("rejects an item element used as a component", () => {
    expect(() =>
      defineView({
        title: "Stray",
        actions: ["Go"],
        body: ({ actions }) => (
          <Container>
            <Attribute label="Reference" value="$.DocRef" />
            <Button action={actions.Go}>Go</Button>
          </Container>
        ),
      }),
    ).toThrow(/<Attribute> at \/Container\/Attribute, outside the AttributeBar or AttributeSection/);
  });
});
