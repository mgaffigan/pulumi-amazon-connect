/**
 * View authoring.
 *
 * The component and property sets here were recovered from Connect's own view validator, which checks
 * templates with AJV and enforces `additionalProperties: false` per component — so an unknown property
 * is reported by name. Every component below has been published to a real instance.
 */

import { describe, expect, it } from "vitest";
import {
  Alert,
  Attribute,
  AttributeBar,
  AttributeSection,
  Button,
  ButtonGroup,
  Card,
  Column,
  Container,
  Dropdown,
  defineView,
  Form,
  FormInput,
  GroupButton,
  Header,
  Loader,
  SubmitButton,
  Table,
  TextBox,
  toViewInputContent,
  type ViewNode,
} from "../src/index.js";

describe("template assembly", () => {
  it("wraps the tree in Head and Body, with Configuration always present", () => {
    // The validator rejects a Head without Configuration, even an empty one.
    const view = defineView({
      title: "Greeting",
      actions: ["Next"],
      body: () => [Container({}, [Button({ action: "Next" }, [TextBox("Go")])])],
    });

    expect(view.Template.Head).toEqual({ Title: "Greeting", Configuration: {} });
    expect(view.Template.Body).toHaveLength(1);
  });

  it("assigns ids from tree position, so a sibling insert does not renumber subtrees", () => {
    const build = (extra: ViewNode[]) =>
      defineView({
        title: "Ids",
        actions: ["Go"],
        body: () => [Container({}, [...extra, Button({ action: "Go" }, [TextBox("Go")])])],
      });

    const idsOf = (nodes: ViewNode[]): string[] =>
      nodes.flatMap((n) => [
        n._id as string,
        ...idsOf(n.Content.filter((c): c is ViewNode => typeof c === "object")),
      ]);

    const before = idsOf(build([]).Template.Body);
    const after = idsOf(build([TextBox("inserted")]).Template.Body);

    // The button moved, so its id changes; its own child keeps its position-relative id.
    expect(before[0]).toBe(after[0]);
    expect(after).toContain("container-0-textbox-0");
  });

  it("does not let a reused component tree leak ids between views", () => {
    const shared = Container({}, [Button({ action: "Go" }, [TextBox("Go")])]);
    defineView({ title: "First", actions: ["Go"], body: () => [shared] });

    // The author's node is untouched: assembly works on a copy.
    expect(shared._id).toBeUndefined();
  });
});

describe("action collection", () => {
  it("finds actions on buttons, cards, button groups and table rows", () => {
    const view = defineView({
      title: "Actions",
      actions: ["FromButton", "FromCard", "FromGroup", "FromRow"],
      body: () => [
        Container({}, [
          Button({ action: "FromButton" }, [TextBox("b")]),
          Card({ id: "c1", action: "FromCard", heading: "c" }),
          ButtonGroup({ items: [{ label: "g", action: "FromGroup" }] }),
          Table({
            items: "$.Rows",
            columns: [{ label: "Order", id: "order_id" }],
            actions: [{ label: "Open", action: "FromRow" }],
          }),
        ]),
      ],
    });

    expect(view.Actions).toEqual(["FromButton", "FromCard", "FromGroup", "FromRow"]);
  });

  it("rejects an action the tree raises but nothing declares", () => {
    expect(() =>
      defineView({
        title: "Undeclared",
        actions: ["Next"],
        body: () => [Container({}, [Button({ action: "Surprise" }, [TextBox("x")])])],
      }),
    ).toThrow(/raises undeclared action\(s\): Surprise/);
  });

  it("rejects a declared action nothing raises", () => {
    // Otherwise the flow handles a branch the view can never take.
    expect(() =>
      defineView({
        title: "Unused",
        actions: ["Next", "Ghost"],
        body: () => [Container({}, [Button({ action: "Next" }, [TextBox("x")])])],
      }),
    ).toThrow(/declares action\(s\) nothing raises: Ghost/);
  });
});

describe("input references", () => {
  it("accepts a reference that is the whole property value", () => {
    const view = defineView({
      title: "Refs",
      actions: ["Next"],
      body: () => [
        Container({}, [
          AttributeBar({ attributes: [{ label: "Customer", value: "$.CustomerName" }] }),
          AttributeSection({ items: "$.OrderAttributes" }),
          Button({ action: "Next" }, [TextBox("Go")]),
        ]),
      ],
    });

    expect(JSON.stringify(view.Template)).toContain("$.CustomerName");
  });

  it("rejects a reference embedded in a longer string", () => {
    // Connect declares an input only when the reference is the entire value. Embedded, it renders
    // literally — confirmed by publishing, which returned an empty input schema. That would put
    // "$.CustomerName" in front of a customer.
    expect(() =>
      defineView({
        title: "Embedded",
        actions: ["Next"],
        body: () => [
          Container({}, [
            TextBox("Hello $.CustomerName"),
            Button({ action: "Next" }, [TextBox("Go")]),
          ]),
        ],
      }),
    ).toThrow(/embeds a "\$\." reference inside a longer string/);
  });

  it("checks the head's configuration as well as the body", () => {
    // Every AWS-managed view takes its `Style` as `$.Style` in the head, so the head declares inputs
    // the same way the body does — and gets the same wrong answer from an embedded reference.
    expect(() =>
      defineView({
        title: "Head",
        configuration: { Style: { "--color": "use $.Brand here" } },
        body: () => [Container({}, [TextBox("Hi")])],
      }),
    ).toThrow(/Head\.Configuration.*embeds a "\$\." reference/s);
  });

  it("rejects a Style key Connect's validator would", () => {
    // `^--[a-z0-9\-]+$`, confirmed against the service: `--Container-Padding-Top`,
    // `--container_padding_top`, `-container-padding-top` and `container-padding-top` are all
    // rejected. Caught here because the service's rejection is invisible — the CloudFormation
    // handler retries `InvalidParameterException` forever, so a bad key just hangs `pulumi up`.
    for (const key of ["padding", "--Container-Padding-Top", "--container_padding_top", "-x"]) {
      expect(() =>
        defineView({
          title: "Style",
          body: () => [Container({ configuration: { Style: { [key]: "0px" } } }, [TextBox("Hi")])],
        }),
      ).toThrow(/which Connect rejects/);
    }
  });

  it("accepts a component style token, and the head takes one too", () => {
    expect(() =>
      defineView({
        title: "Style",
        configuration: { Style: { "--container-padding-top": "0px" } },
        body: () => [
          Container({ configuration: { Style: { "--container-padding-left": "0px" } } }, [
            TextBox("Hi"),
          ]),
        ],
      }),
    ).not.toThrow();
  });

  it("checks a node's layout, which can also take a reference", () => {
    expect(() =>
      defineView({
        title: "Layout",
        body: () => [Container({ configuration: { Layout: { Columns: "up to $.Columns" } } }, [])],
      }),
    ).toThrow(/Container\.Configuration.*embeds a "\$\." reference/s);
  });

  it("rejects an integration reference, which needs a Head declaration", () => {
    expect(() =>
      defineView({
        title: "Integration",
        actions: ["Next"],
        body: () => [
          Container({}, [
            AttributeBar({ attributes: [{ label: "L", value: "$.#Integration" }] }),
            Button({ action: "Next" }, [TextBox("Go")]),
          ]),
        ],
      }),
    ).toThrow(/integration reference/);
  });
});

describe("text content", () => {
  it("puts a TextBox's text in Content, since it has no Text property", () => {
    // A Text property is silently dropped: the component schema does not seal Props, so the service
    // accepts it and the text never renders.
    const view = defineView({
      title: "Text",
      actions: ["Next"],
      body: () => [
        Container({}, [
          TextBox("Patient summary", { variant: "h2", fontSize: "heading-l" }),
          Button({ action: "Next" }, [TextBox("Go")]),
        ]),
      ],
    });

    const textbox = (view.Template.Body[0] as ViewNode).Content[0] as ViewNode;
    expect(textbox.Content).toEqual(["Patient summary"]);
    expect(textbox.Props).toEqual({ Variant: "h2", FontSize: "heading-l" });
    expect(textbox.Props).not.toHaveProperty("Text");
  });

  it("mixes literal text and references as separate content items", () => {
    // This is how interpolation works. One combined string would declare no input and render the
    // reference literally, which is why the guard rejects it.
    const view = defineView({
      title: "Mixed",
      actions: ["Next"],
      body: () => [
        Container({}, [
          TextBox(["Hello ", "$.CustomerName", ", welcome back."]),
          Button({ action: "Next" }, [TextBox("Go")]),
        ]),
      ],
    });

    const textbox = (view.Template.Body[0] as ViewNode).Content[0] as ViewNode;
    expect(textbox.Content).toEqual(["Hello ", "$.CustomerName", ", welcome back."]);
  });

  it("rejects a reference embedded in a content item", () => {
    expect(() =>
      defineView({
        title: "Embedded content",
        actions: ["Next"],
        body: () => [
          Container({}, [
            TextBox("Hello $.CustomerName"),
            Button({ action: "Next" }, [TextBox("Go")]),
          ]),
        ],
      }),
    ).toThrow(/Split it into separate content items/);
  });
});

describe("components with lower-case properties", () => {
  it("emits Header and Alert props in the casing the service expects", () => {
    // Most components use PascalCase; these do not. Both spellings were checked by publishing.
    const view = defineView({
      title: "Casing",
      actions: ["Next"],
      body: () => [
        Container({ header: "Top", footer: "Bottom" }, [
          Header({ variant: "h2", description: "Sub" }, [TextBox("Title")]),
          Alert({ type: "warning", level: "inline", heading: "Careful", dismissible: true }, [
            TextBox("Body"),
          ]),
          Loader(),
          Button({ action: "Next" }, [TextBox("Go")]),
        ]),
      ],
    });

    const container = view.Template.Body[0] as ViewNode;
    expect(container.Props).toEqual({ header: "Top", footer: "Bottom" });

    const [header, alert, loader] = container.Content as ViewNode[];
    expect(header?.Props).toEqual({ variant: "h2", description: "Sub" });
    expect(alert?.Props).toEqual({
      type: "warning",
      level: "inline",
      heading: "Careful",
      dismissible: true,
    });
    expect(loader?.Props).toEqual({});
  });

  it("gives SubmitButton the label Button refuses", () => {
    const view = defineView({
      title: "Submit",
      actions: ["Submit"],
      body: () => [
        Form({}, [SubmitButton({ label: "Save", action: "Submit", variant: "primary" })]),
      ],
    });

    const submit = (view.Template.Body[0] as ViewNode).Content[0] as ViewNode;
    expect(submit.Props).toEqual({ Label: "Save", Action: "Submit", Variant: "primary" });
  });
});

describe("component props", () => {
  it("renders camelCase options as the PascalCase wire keys", () => {
    const view = defineView({
      title: "Props",
      actions: ["Submit"],
      body: () => [
        Form({ hideBorder: true }, [
          FormInput({ name: "account", label: "Account", inputType: "number", required: true }),
          Dropdown({
            name: "reason",
            label: "Reason",
            choices: [{ label: "Refill", value: "refill" }],
            multiSelect: false,
          }),
          Button({ action: "Submit", variant: "primary" }, [TextBox("Submit")]),
        ]),
      ],
    });

    const form = view.Template.Body[0] as ViewNode;
    expect(form.Props).toEqual({ HideBorder: true });

    const [input, dropdown] = form.Content as ViewNode[];
    expect(input?.Props).toEqual({
      Name: "account",
      Label: "Account",
      InputType: "number",
      Required: true,
    });
    // Options are objects on the wire, and booleans are booleans — matching AWS's own views. The
    // schema also accepts the strings "true"/"false", which this library used to emit.
    expect(dropdown?.Props).toEqual({
      Name: "reason",
      Label: "Reason",
      Options: [{ Label: "Refill", Value: "refill" }],
      MultiSelect: false,
    });
  });

  it("puts a button's label in its content, since Connect rejects a Label prop", () => {
    const view = defineView({
      title: "Button",
      actions: ["Go"],
      body: () => [Container({}, [Button({ action: "Go" }, [TextBox("Continue")])])],
    });

    const button = (view.Template.Body[0] as ViewNode).Content[0] as ViewNode;
    expect(button.Props).not.toHaveProperty("Label");
    // The label is text content, not a Text property, which TextBox does not have.
    expect(button.Content[0]).toEqual({
      Type: "TextBox",
      Props: {},
      Content: ["Continue"],
      _id: "container-0-button-0-textbox-0",
    });
  });
});

describe("item lists", () => {
  it("folds item children into the parent's property, leaving nothing on the wire", () => {
    const view = defineView({
      title: "Items",
      actions: ["Search"],
      body: () => [
        Container({}, [
          AttributeBar({}, [Attribute({ label: "Customer", value: "$.CustomerName" })]),
          ButtonGroup({ spaceBetween: "s" }, [
            GroupButton({ label: "Search", action: "Search", formAction: "submit" }),
          ]),
        ]),
      ],
    });

    const [bar, group] = (view.Template.Body[0] as ViewNode).Content as ViewNode[];
    // Both are ordinary props on an ordinary node: the pseudo-nodes are gone, ids and all.
    expect(bar?.Props).toEqual({ Attributes: [{ Label: "Customer", Value: "$.CustomerName" }] });
    expect(bar?.Content).toEqual([]);
    expect(group?.Props).toEqual({
      Items: [{ Label: "Search", Action: "Search", FormAction: "submit" }],
      SpaceBetweenButtons: "s",
    });
    expect(JSON.stringify(view.Template)).not.toContain("_item");
  });

  it("keeps a reference to a whole list on the property, where children cannot express it", () => {
    const view = defineView({
      title: "Referenced",
      actions: ["Next"],
      body: () => [
        Container({}, [
          AttributeSection({ items: "$.OrderAttributes" }),
          Button({ action: "Next" }, [TextBox("Go")]),
        ]),
      ],
    });

    const section = (view.Template.Body[0] as ViewNode).Content[0] as ViewNode;
    expect(section.Props.Items).toBe("$.OrderAttributes");
  });

  it("rejects an item element left outside the component it belongs to", () => {
    // "Attribute" is not a component Connect knows, so publishing would report it with no hint as to
    // why. Named here instead, along with where it belongs.
    expect(() =>
      defineView({
        title: "Stray",
        actions: ["Next"],
        body: () => [
          Container({}, [
            Attribute({ label: "Customer", value: "$.CustomerName" }),
            Button({ action: "Next" }, [TextBox("Go")]),
          ]),
        ],
      }),
    ).toThrow(/outside the AttributeBar or AttributeSection it belongs to/);
  });

  it("rejects an item element of the wrong list", () => {
    expect(() => ButtonGroup({}, [Attribute({ label: "L", value: "V" })])).toThrow(
      /ButtonGroup takes only <GroupButton> children, but was given <Attribute>/,
    );
  });
});

/**
 * The Table's two lists.
 *
 * Its columns and its header buttons are both properties rather than content, so both are written as
 * item children — and the buttons are a `ButtonGroup`'s entries, which is why a table's actions are
 * `<GroupButton>`s rather than a list of their own.
 */
describe("table", () => {
  it("emits every column property in the shape the renderer reads", () => {
    // `Label`, not `Header`: a column given a Header renders with a blank heading, since the
    // component reads its heading from Label. Both Label and Id are required.
    const table = Table({
      items: "$.Orders",
      name: "OrderTable",
      tableAction: "OrderSelected",
      header: "Recent orders",
      description: "Pick one",
      filterable: true,
      itemsPerPage: 5,
      columnWidth: "locked",
      columns: [
        { label: "Order", id: "order_id", type: "action" },
        { label: "Status", id: "status" },
        { label: "Priority", id: "priority", editableType: "select", options: ["1", "2"] },
        { label: "Notes", id: "notes", editableType: "input" },
      ],
      actions: [{ label: "Save", action: "Save", variant: "primary", formAction: "submit" }],
    });

    expect(table.Props).toEqual({
      Items: "$.Orders",
      Columns: [
        { Label: "Order", Id: "order_id", Type: "action" },
        { Label: "Status", Id: "status" },
        { Label: "Priority", Id: "priority", EditableType: "select", Options: ["1", "2"] },
        { Label: "Notes", Id: "notes", EditableType: "input" },
      ],
      Actions: [{ Label: "Save", Action: "Save", Variant: "primary", FormAction: "submit" }],
      TableAction: "OrderSelected",
      Name: "OrderTable",
      Header: "Recent orders",
      Description: "Pick one",
      Filterable: true,
      ItemsPerPage: 5,
      ColumnWidth: "locked",
    });
  });

  it("folds Column and GroupButton children into the two lists", () => {
    const fromChildren = Table({ items: "$.Orders" }, [
      Column({ label: "Order", id: "order_id" }),
      GroupButton({ label: "Save", action: "Save" }),
    ]);

    expect(fromChildren).toEqual(
      Table({
        items: "$.Orders",
        columns: [{ label: "Order", id: "order_id" }],
        actions: [{ label: "Save", action: "Save" }],
      }),
    );
    expect(JSON.stringify(fromChildren)).not.toContain("_item");
  });

  it("keeps a reference to either list on the property", () => {
    const table = Table({ items: "$.Orders", columns: "$.Cols", actions: "$.Acts" });
    expect(table.Props.Columns).toBe("$.Cols");
    expect(table.Props.Actions).toBe("$.Acts");
  });

  it("collects the row action, which is a property rather than an item", () => {
    const view = defineView({
      title: "Rows",
      actions: ["RowPicked"],
      body: ({ actions }) => [
        Container({}, [
          Table({
            items: "$.Orders",
            tableAction: actions.RowPicked,
            columns: [{ label: "Order", id: "order_id", type: "action" }],
          }),
        ]),
      ],
    });

    expect(view.Actions).toEqual(["RowPicked"]);
  });

  it("rejects an action column with no action to raise", () => {
    // Connect's fallback is the literal name "TableAction", which is a branch nobody means to write.
    expect(() =>
      Table({ items: "$.Orders", columns: [{ label: "Order", id: "order_id", type: "action" }] }),
    ).toThrow(/action column but no `tableAction`/);
  });

  it("rejects an editable select with nothing to select", () => {
    expect(() =>
      Column({ label: "Priority", id: "priority", editableType: "select", options: [] }),
    ).toThrow(/editable select with no `options`/);
  });

  it("rejects a table with no columns, which renders nothing", () => {
    expect(() => Table({ items: "$.Orders" })).toThrow(/Table has no columns/);
  });

  it("rejects a list given both ways, and a child of neither list", () => {
    expect(() =>
      Table({ items: "$.Orders", columns: [{ label: "Order", id: "order_id" }] }, [
        Column({ label: "Status", id: "status" }),
      ]),
    ).toThrow(/both `columns` and <Column> children/);

    expect(() =>
      Table({ items: "$.Orders" }, [Attribute({ label: "L", value: "V" }) as never]),
    ).toThrow(/Table takes only <Column> and <GroupButton> children, but was given <Attribute>/);
  });

  it("rejects a Column left outside a Table", () => {
    expect(() =>
      defineView({
        title: "Stray",
        actions: ["Next"],
        body: () => [
          Container({}, [
            Column({ label: "Order", id: "order_id" }) as never,
            Button({ action: "Next" }, [TextBox("Go")]),
          ]),
        ],
      }),
    ).toThrow(/outside the Table it belongs to/);
  });
});

describe("serialization", () => {
  it("stringifies the template the way CreateView expects", () => {
    const view = defineView({
      title: "Wire",
      actions: ["Next"],
      body: () => [Container({}, [Button({ action: "Next" }, [TextBox("Go")])])],
    });

    const content = toViewInputContent(view);
    expect(typeof content.Template).toBe("string");
    expect(content.Actions).toEqual(["Next"]);
    expect(JSON.parse(content.Template).Head.Title).toBe("Wire");
  });

  it("rejects an empty body", () => {
    expect(() => defineView({ title: "Empty", actions: [], body: () => [] })).toThrow(
      /at least one component/,
    );
  });
});
