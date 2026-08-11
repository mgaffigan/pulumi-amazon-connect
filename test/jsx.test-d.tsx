/** @jsxImportSource pulumi-amazon-connect */

/**
 * Type-level guarantees for JSX authoring.
 *
 * These are the mistakes JSX makes easy to make — an HTML tag, a misspelled action, an input that was
 * never declared — and each one has to fail at compile time, because none of them fail at publish time.
 * A `$.` reference to a nonexistent input is accepted by Connect and renders as literal text.
 */

import { describe, expectTypeOf, it } from "vitest";
import {
  Attribute,
  AttributeBar,
  Button,
  ButtonGroup,
  type ButtonGroupItem,
  Container,
  defineView,
  GroupButton,
  shape,
  TextBox,
  type ViewItemNode,
  type ViewNode,
} from "../src/index.js";

interface Inputs {
  customerName: string;
}

describe("jsx types", () => {
  it("has no intrinsic elements", () => {
    // @ts-expect-error — there is no `<div>` in a view template.
    const bad = <div>nope</div>;
    expectTypeOf(bad).toEqualTypeOf<ViewNode>();
  });

  it("builds a ViewNode", () => {
    expectTypeOf(<TextBox variant="h2">Title</TextBox>).toEqualTypeOf<ViewNode>();
  });

  it("rejects an undeclared action or input", () => {
    defineView({
      title: "Typed",
      actions: ["Confirm"],
      inputs: shape<Inputs>(),
      body: ({ inputs, actions }) => (
        <Container>
          {/* @ts-expect-error — "Cancel" is not in the declared actions. */}
          <TextBox>{actions.Cancel}</TextBox>
          {/* @ts-expect-error — `orderId` is not a declared input. */}
          <TextBox>{inputs.orderId}</TextBox>
          <TextBox>{[inputs.customerName, actions.Confirm]}</TextBox>
        </Container>
      ),
    });
  });

  it("rejects an unknown property on a component", () => {
    // @ts-expect-error — TextBox has no `text` property; the text is its content.
    const bad = <TextBox text="Hello" />;
    expectTypeOf(bad).toBeObject();
  });

  it("types a fragment, and a component returning several nodes, as one element", () => {
    // `JSX.Element` is a single node even for these, since TypeScript erases a child's return type at
    // the tag boundary. The arrays are flattened where children are collected.
    expectTypeOf(
      <>
        <TextBox>One</TextBox>
        <TextBox>Two</TextBox>
      </>,
    ).toEqualTypeOf<ViewNode>();

    const Lines = (): ViewNode[] => [TextBox("One"), TextBox("Two")];
    expectTypeOf(<Lines />).toEqualTypeOf<ViewNode>();
  });

  it("rejects a component whose result is not part of a view", () => {
    const NotAComponent = (): string => "nope";
    // @ts-expect-error — a component returns a node or a list of them, not an arbitrary value.
    const bad = <NotAComponent />;
    expectTypeOf(bad).toEqualTypeOf<ViewNode>();
  });
});

/**
 * What an item element can and cannot be checked for.
 *
 * `<GroupButton>` is one entry of a `ButtonGroup`'s item list, not a component, and its props are
 * checked like any other. But the *placement* cannot be: TypeScript types every JSX expression as
 * `JSX.Element`, so a child's own return type is erased at the tag boundary and "only `<GroupButton>`
 * here" is inexpressible. `defineView` and the parent components check it at build time instead — these
 * cases pin down which half is which, so a future attempt to tighten it has the boundary written down.
 */
describe("item element types", () => {
  it("checks an item element's own props", () => {
    // @ts-expect-error — a group's button needs a label; that is what distinguishes it from a Button.
    const missingLabel = <GroupButton action="Go" />;
    // @ts-expect-error — `formAction` is a group button's, not an attribute's.
    const wrongList = <Attribute label="L" value="V" formAction="submit" />;
    expectTypeOf(missingLabel).toBeObject();
    expectTypeOf(wrongList).toBeObject();
  });

  it("erases the item type at the JSX boundary, so placement is a build-time check", () => {
    // Both compile and both throw when built: the tag boundary is where the type is lost.
    expectTypeOf(<GroupButton label="Search" />).toEqualTypeOf<ViewNode>();
    const misplaced = (
      <Container>
        <GroupButton label="Search" />
      </Container>
    );
    const wrongChild = (
      <ButtonGroup>
        <Button action="Go">Go</Button>
      </ButtonGroup>
    );
    expectTypeOf(misplaced).toEqualTypeOf<ViewNode>();
    expectTypeOf(wrongChild).toEqualTypeOf<ViewNode>();
  });

  it("keeps the check in the functional form, where the type survives", () => {
    expectTypeOf(GroupButton({ label: "Search" })).toEqualTypeOf<ViewItemNode<ButtonGroupItem>>();
    // @ts-expect-error — a TextBox is not an entry of a ButtonGroup's item list.
    ButtonGroup({}, [TextBox("Search")]);
    AttributeBar({}, [Attribute({ label: "L", value: "V" })]);
  });
});
