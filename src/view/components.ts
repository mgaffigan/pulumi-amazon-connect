import type { ButtonIconName, CardIconName } from "./icons.js";

/**
 * View components, as TypeScript functions.
 *
 * Every component and property here was recovered from Amazon Connect's own view validator, which
 * checks templates with AJV and enforces `additionalProperties: false` per component. Publishing a
 * view with an unknown component or property is rejected and the offending name is reported, so the
 * prop sets below are the service's, not a transcription of the documentation.
 *
 * Props are camelCase here and PascalCase on the wire, and a boolean prop is emitted as a real boolean.
 * Every boolean in that schema is `anyOf: [boolean, "true" | "false", <reference>]`, so the stringified
 * form this library used to emit was accepted too — but AWS's own views emit booleans, and `Required`
 * was already emitted unstringified, so the two conventions disagreed inside a single view.
 */

/**
 * Marks a component whose first parameter is its content rather than its properties.
 *
 * `TextBox("hello", { variant })` reads better than passing content through an options bag, and the JSX
 * factory needs to know which convention a component follows. It lives here rather than beside the
 * factory so that `components` has no import back into `jsx-runtime`: a cycle between them is fine
 * under a bundler but throws in real ESM when the JSX subpath is loaded first.
 */
export const CONTENT_FIRST: unique symbol = Symbol.for("pulumi-amazon-connect.contentFirst");

/**
 * Text or a reference inside a component's content.
 *
 * A string that is exactly `$.Something` references the view's input. Several items combine, so
 * `["Hello ", "$.CustomerName"]` renders as one sentence while still declaring `CustomerName` as an
 * input — putting the reference inside a single string does not.
 */
export type TextContent = string | number;

/** Anything that can sit inside a component. */
export type ViewChild = ViewNode | TextContent;

/** A node in a view's component tree. */
export interface ViewNode {
  /**
   * The component's name on the wire.
   *
   * An item pseudo-node ({@link ViewItemNode}) carries the name of the pseudo-component instead —
   * `"Attribute"`, `"GroupButton"` — which is not a component Connect knows.
   */
  Type: string;
  Props: Record<string, unknown>;
  /**
   * Layout, a sibling of `Props` rather than one of them.
   *
   * Only some components take one — see {@link ViewConfiguration}. Omitted entirely when unset, since
   * the validator rejects it on a component that has none.
   */
  Configuration?: ViewConfiguration;
  /** Child components, text, and references. */
  Content: ViewChild[];
  /** Assigned during template assembly; authors never set it. */
  _id?: string;
}

/** A column span: a number of grid columns, or the same as a string, both of which Connect accepts. */
export type ColumnSpan = string | number;

/** How a node arranges its children. */
export interface ViewLayout {
  /** Which way the children are pushed. */
  Align?: TextAlign;
  /** Column width in 1/12 of the container (e.g.: 6 for half-width) */
  Columns?: ColumnSpan | ColumnSpan[];
}

/**
 * Node-level layout, in the same shape as a view's `Head.Configuration`.
 *
 * PascalCase, unlike component props, because it is one object handed through rather than a set of
 * options — and because `defineView`'s `configuration` is the same shape at the top of the template.
 *
 * The recovered schema puts `Configuration` on the *base* component definition, sealed to these two
 * keys, so every component accepts one. It is exposed on the components where it means something.
 */
export interface ViewConfiguration {
  Layout?: ViewLayout;
  /**
   * Component style tokens: `{ "--container-padding-top": "13px" }`.
   *
   * The schema is `oneOf[ { patternProperties: { "^--[a-z0-9\-]+$": string }, additionalProperties:
   * false }, string ]`, so a bare string is *accepted* — but nothing is known to consume one. Every
   * component's CSS reads named custom properties (`padding-top: var(--container-padding-top, …)`),
   * and Connect's own view designer only ever emits the object form. Treat the string branch as
   * dead: it publishes and does nothing.
   *
   * The key pattern is lower-case, digits and hyphens only, and it is not expressible as a template
   * literal type — `checkStyle` enforces it at `defineView` instead. That check earns its keep:
   * `AWS::Connect::View`'s CloudFormation handler retries the resulting `InvalidParameterException`
   * on a ~60s loop rather than failing, so a bad key is a silently hung `pulumi up`.
   */
  Style?: Record<string, string> | string;
}

/**
 * A value a component prop can take.
 *
 * A `$.`-prefixed string is a reference into the view's input data, which is what `showView` passes as
 * `data`. Connect derives the view's `InputSchema` from these references rather than being told it.
 */
export type ViewValue = string | number | boolean;

/**
 * Options plus the `children` JSX passes.
 *
 * JSX hands a component one props object, and TypeScript checks it against the first parameter — so a
 * component that takes children has to accept them there, even though the functional style passes them
 * positionally.
 */
export type WithChildren<T> = T & { children?: JsxChildren };

/**
 * Children of some kind, as JSX produces them.
 *
 * Nested arrays come from `.map` and from a fragment, and the gaps come from `cond && <X/>` — both are
 * flattened away, so a conditional child needs no ceremony.
 *
 * `boolean` rather than `false`, though only `false` can be produced deliberately: TypeScript widens the
 * `false` out of `cond && <X/>` to `boolean` once a children list holds two of them alongside an array,
 * which made an ordinary mix of conditionals and a `.map` a type error. `true` is dropped the same way.
 */
export type ItemChildren<T> = T | boolean | null | undefined | ItemChildren<T>[];

/** Children as JSX produces them. */
export type JsxChildren = ItemChildren<ViewChild>;

function node(
  type: string,
  props: Record<string, unknown>,
  content: ViewChild[] = [],
  configuration?: ViewConfiguration,
): ViewNode {
  return {
    Type: type,
    Props: compactProps(props),
    ...(configuration === undefined ? {} : { Configuration: configuration }),
    Content: content,
  };
}

/** Flattens nested arrays and drops the gaps conditionals leave behind. */
export function flattenChildren<T>(children: ItemChildren<T>): T[] {
  if (children === undefined || children === null || typeof children === "boolean") return [];
  if (Array.isArray(children)) return children.flatMap(flattenChildren);
  return [children];
}

/** Picks whichever way the children arrived. */
function contentOf(options: { children?: JsxChildren }, positional: ViewChild[]): ViewChild[] {
  return positional.length > 0 ? positional : flattenChildren(options.children);
}

function compactProps(props: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined));
}

// ---------------------------------------------------------------------------
// Item lists
// ---------------------------------------------------------------------------

/**
 * One entry of a component's item list, as a node in the tree.
 *
 * A few components carry their contents in a *property* rather than in `Content`: a `ButtonGroup`'s
 * buttons are `Items`, an `AttributeBar`'s attributes are `Attributes`. Written out as object literals
 * those lists are the one place a view stops looking like markup, and nothing checks them — a stray key
 * is only caught on publish.
 *
 * So each list has a pseudo-component — {@link GroupButton}, {@link Attribute} — that yields one of
 * these. The parent unwraps `_item` and folds it into its own props, and nothing of the pseudo-node
 * reaches the wire. It is a real node only because a JSX child has to be one: TypeScript types every
 * JSX expression as `JSX.Element`, so a child whose type differs from a component's is not something
 * the type system can express.
 *
 * That is also why the parent's check is a runtime one, and why {@link isViewItemNode} exists —
 * assembly rejects a pseudo-node left somewhere no parent folded it in, rather than letting Connect
 * report an unknown component at publish time.
 */
export interface ViewItemNode<T = unknown> extends ViewNode {
  /** The entry itself, in the same shape the parent's list prop takes. */
  _item: T;
  /** Which component this entry belongs inside, named for the error when it is outside one. */
  _itemOf: string;
}

/** Whether a node is one entry of a parent's item list rather than a component of its own. */
export function isViewItemNode(node: ViewChild): node is ViewItemNode {
  return typeof node === "object" && node !== null && "_item" in node;
}

function itemNode<T>(type: string, itemOf: string, item: T): ViewItemNode<T> {
  return { Type: type, Props: {}, Content: [], _item: item, _itemOf: itemOf };
}

/** Names the list being built, for the errors below. */
interface ItemList {
  /** The component that holds the list, e.g. `ButtonGroup`. */
  component: string;
  /** The property that carries it, e.g. `items`. */
  prop: string;
  /** The pseudo-component for one entry, e.g. `GroupButton`. */
  item: string;
}

/** A list was given twice: as a property and as children. */
function bothGiven(list: ItemList): never {
  throw new Error(
    `${list.component} was given both \`${list.prop}\` and <${list.item}> children. Use one or the ` +
      "other; they are two ways of writing the same list.",
  );
}

/** A required list was given neither way. */
function noneGiven(list: ItemList): never {
  throw new Error(
    `${list.component} has no ${list.prop}. Pass \`${list.prop}\`, a "$." reference to a list, or ` +
      `<${list.item}> children.`,
  );
}

/** Names what was written where an item pseudo-node was expected. */
function describeChild(child: ViewChild): string {
  return typeof child === "object" ? `<${child.Type}>` : JSON.stringify(child);
}

/**
 * Picks whichever way a list was given: the property, or item children already collected.
 *
 * Both at once is an error rather than a merge — one of the two is being ignored, and which one is not
 * something the author can see from the call. Neither is `undefined`, for the caller to reject or
 * default as that list requires.
 */
function pickList<T>(
  list: ItemList,
  explicit: T[] | string | undefined,
  fromChildren: T[],
): T[] | string | undefined {
  if (explicit !== undefined && fromChildren.length > 0) bothGiven(list);
  if (explicit !== undefined) return explicit;
  return fromChildren.length > 0 ? fromChildren : undefined;
}

/**
 * Takes a component's item list from whichever way it was given: the property, or item children.
 *
 * The overloads carry through what the caller can be given: a whole list may arrive as a `$.` reference
 * on the property, and stays a string, but a component whose property takes no reference gets an array
 * back without having to narrow one out again.
 */
function itemsOf<T>(
  list: ItemList,
  explicit: T[] | undefined,
  options: { children?: JsxChildren },
  positional: ViewChild[],
): T[];
function itemsOf<T>(
  list: ItemList,
  explicit: T[] | string | undefined,
  options: { children?: JsxChildren },
  positional: ViewChild[],
): T[] | string;
function itemsOf<T>(
  list: ItemList,
  explicit: T[] | string | undefined,
  options: { children?: JsxChildren },
  positional: ViewChild[],
): T[] | string {
  const children = contentOf(options, positional);
  const fromChildren = children.map((child) => {
    if (isViewItemNode(child) && child.Type === list.item) return child._item as T;
    throw new Error(
      `${list.component} takes only <${list.item}> children, but was given ${describeChild(child)}. ` +
        "Its contents are a list of entries rather than a component tree.",
    );
  });
  return pickList(list, explicit, fromChildren) ?? noneGiven(list);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Groups components. The core building block of any view. */
export function Container(
  options: WithChildren<{
    hideBorder?: boolean;
    header?: string;
    footer?: string;
    configuration?: ViewConfiguration;
  }> = {},
  children: ViewChild[] = [],
): ViewNode {
  return node(
    "Container",
    {
      HideBorder: options.hideBorder,
      // Lower case, unlike most properties. Several components mix casing this way.
      header: options.header,
      footer: options.footer,
    },
    contentOf(options, children),
    options.configuration,
  );
}

/**
 * A titled group inside a container.
 *
 * `configuration` is how a section lays its children out — `{ Layout: { Columns: "12" } }` stacks them,
 * a `Columns` array gives each child its own span. Every AWS-managed form section carries one.
 */
export function Section(
  options: WithChildren<{ heading?: string; configuration?: ViewConfiguration }> = {},
  children: ViewChild[] = [],
): ViewNode {
  return node(
    "Section",
    { Heading: options.heading },
    contentOf(options, children),
    options.configuration,
  );
}

export type HeaderVariant = "h1" | "h2" | "h3" | "h4";

/**
 * A heading with optional supporting text.
 *
 * Its properties are lower case, unlike most components'.
 */
export function Header(
  options: WithChildren<{ variant?: HeaderVariant; description?: string }> = {},
  children: ViewChild[] = [],
): ViewNode {
  return node(
    "Header",
    { variant: options.variant, description: options.description },
    contentOf(options, children),
  );
}

export type AlertType = "info" | "success" | "warning" | "error";
export type AlertLevel = "inline" | "page" | "global";

/** A banner drawing attention to something. Lower-case properties again. */
export function Alert(
  options: WithChildren<{
    type?: AlertType;
    level?: AlertLevel;
    heading?: string;
    dismissible?: boolean;
  }> = {},
  children: ViewChild[] = [],
): ViewNode {
  return node(
    "Alert",
    {
      type: options.type,
      level: options.level,
      heading: options.heading,
      dismissible: options.dismissible,
    },
    contentOf(options, children),
  );
}

/** A spinner, for a view waiting on something. Takes no properties. */
export function Loader(): ViewNode {
  return node("Loader", {});
}

/** Embeds a third-party application registered on the instance. */
export function Application(options: { appIdentifier?: string; path?: string } = {}): ViewNode {
  return node("Application", { AppIdentifier: options.appIdentifier, Path: options.path });
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export type FontSize =
  | "body-s"
  | "body-m"
  | "heading-xs"
  | "heading-s"
  | "heading-m"
  | "heading-l"
  | "heading-xl"
  | "display-l";

export type FontWeight = "light" | "normal" | "bold" | "heavy";
export type TextAlign = "left" | "center" | "right";
export type TextVariant = "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "div" | "span";

export interface TextBoxOptions {
  /** The element to render as. Defaults to div. */
  variant?: TextVariant;
  fontSize?: FontSize;
  fontWeight?: FontWeight;
  textAlign?: TextAlign;
}

/**
 * A run of read-only text.
 *
 * The text is the component's *content*, not a property: TextBox has no Text property, and one set
 * there is silently dropped, because the schema does not seal Props.
 *
 *     TextBox("Patient summary", { variant: "h2" })
 *     TextBox(["Hello ", "$.CustomerName"])
 *
 * Pass several items to mix literal text with references. A reference inside a single string declares
 * no input and renders literally, which is why assembly rejects that shape.
 */
export function TextBox(content: TextContent | TextContent[], options?: TextBoxOptions): ViewNode;
export function TextBox(props: WithChildren<TextBoxOptions>): ViewNode;
export function TextBox(
  first: TextContent | TextContent[] | WithChildren<TextBoxOptions>,
  second: TextBoxOptions = {},
): ViewNode {
  // JSX passes one props object; the functional form passes content first.
  const fromJsx = typeof first === "object" && !Array.isArray(first);
  const options: TextBoxOptions = fromJsx ? (first as TextBoxOptions) : second;
  const content = fromJsx
    ? contentOf(first as WithChildren<TextBoxOptions>, [])
    : Array.isArray(first)
      ? first
      : [first];

  return node(
    "TextBox",
    {
      Variant: options.variant,
      FontSize: options.fontSize,
      FontWeight: options.fontWeight,
      TextAlign: options.textAlign,
    },
    content,
  );
}

// JSX passes a single props object; this tells the factory that TextBox takes its content first.
TextBox[CONTENT_FIRST] = true;

/** An image, by URL. */
export function Image(options: { src: string; alt?: string }): ViewNode {
  return node("Image", { Src: options.src, Alt: options.alt });
}

/** Illustration icons, distinct from the small glyphs on a {@link Button}. */
export type IconVariant = "card" | "icon-only";

/**
 * A named illustration.
 *
 * Connect accepts a long fixed list of names (`"Headset"`, `"Pills"`, `"Clock"`, ...). The name is
 * validated on publish, so a typo is a deploy-time rejection rather than a blank space.
 */
export function Icon(options: { name: string; variant?: IconVariant }): ViewNode {
  return node("Icon", { Name: options.name, Variant: options.variant });
}

export type LinkType = "external" | "case" | "third-party applications";

/** A link out of the workspace, to a case, or into a third-party application. */
export function Link(options: {
  type: LinkType;
  url?: string;
  resourceId?: string;
  /** Opens as soon as the view renders. */
  autoOpen?: boolean;
}): ViewNode {
  return node("Link", {
    Type: options.type,
    Url: options.url,
    ResourceId: options.resourceId,
    AutoOpen: options.autoOpen,
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** The service also accepts "link", though the component library documents only these two. */
export type ButtonVariant = "primary" | "normal";
export type IconAlign = "left" | "right";

export interface ButtonOptions {
  /**
   * The action name reported back to the flow.
   *
   * Every action a view raises must appear in the view's `Actions` list, which `defineView` collects
   * from these props.
   */
  action?: string;
  variant?: ButtonVariant;
  loading?: boolean;
  /** A small glyph, from Connect's fixed set (`"check"`, `"call"`, `"edit"`, ...). */
  iconName?: ButtonIconName;
  iconAlign?: IconAlign;
  /** Makes the button a link instead of an action. */
  href?: string;
  disabled?: boolean;
}

/** How a button interacts with the `Form` around it. */
export type FormAction = "submit" | "none";

function buttonProps(options: ButtonOptions): Record<string, unknown> {
  return {
    Action: options.action,
    Variant: options.variant,
    Loading: options.loading,
    IconName: options.iconName,
    IconAlign: options.iconAlign,
    Href: options.href,
    Disabled: options.disabled,
  };
}

/**
 * A button.
 *
 * There is no `label` property: the label is the button's text content, so pass it as a child
 * {@link TextBox}. Connect rejects `Label` outright.
 */
export function Button(
  options: WithChildren<ButtonOptions> = {},
  children: ViewChild[] = [],
): ViewNode {
  return node("Button", buttonProps(options), contentOf(options, children));
}

/**
 * A button that submits the enclosing Form.
 *
 * Unlike Button, this one does take a label, and requires it.
 */
export function SubmitButton(options: ButtonOptions & { label: string }): ViewNode {
  return node("SubmitButton", { Label: options.label, ...buttonProps(options) });
}

export type ButtonOrientation = "vertical" | "horizontal";
export type Spacing = "xxxs" | "xxs" | "xs" | "s" | "m" | "l" | "xl" | "xxl";

/**
 * One button in a {@link ButtonGroup}: everything a {@link Button} takes, plus a label and a form
 * behaviour.
 */
export interface ButtonGroupItem extends ButtonOptions {
  label: string;
  /**
   * Whether this button submits the enclosing `Form`. Defaults to `"none"`.
   *
   * This is how a form built from a `ButtonGroup` is submitted, and the only way to have the Cancel
   * button beside it *not* submit — AWS's own After Contact Work view pairs `"none"` with `"submit"`
   * and has no `SubmitButton` anywhere.
   */
  formAction?: FormAction;
}

/**
 * One button of a {@link ButtonGroup} or a {@link Table}'s toolbar, as a child rather than an object
 * literal.
 *
 *     <ButtonGroup spaceBetween="s">
 *       <GroupButton label="Cancel" action={actions.Cancel} />
 *       <GroupButton label="Submit" action={actions.Submit} variant="primary" formAction="submit" />
 *     </ButtonGroup>
 *
 * It is not a {@link Button}: a group's buttons take a `label` and a `formAction`, and are entries in
 * the parent's `Actions`/`Items` rather than components of their own — see {@link ViewItemNode}. A
 * `Table` lays its actions out with a `ButtonGroup` of its own, which is why the same entry serves
 * both. Anywhere else it is rejected when the view is assembled.
 */
export function GroupButton(options: ButtonGroupItem): ViewItemNode<ButtonGroupItem> {
  return itemNode("GroupButton", "ButtonGroup or Table", { ...options });
}

/** One button, in the shape both `ButtonGroup.Items` and `Table.Actions` take. */
function groupButtonItems(items: ButtonGroupItem[] | string): unknown {
  if (typeof items === "string") return items;
  return items.map((item) =>
    compactProps({ Label: item.label, FormAction: item.formAction, ...buttonProps(item) }),
  );
}

/**
 * Lays several buttons out together.
 *
 * The buttons come from `items` or from {@link GroupButton} children, not both.
 */
export function ButtonGroup(
  options: {
    items?: ButtonGroupItem[];
    children?: JsxChildren;
    orientation?: ButtonOrientation;
    spaceBetween?: Spacing;
  } = {},
  children: Array<ViewItemNode<ButtonGroupItem>> = [],
): ViewNode {
  const items = itemsOf<ButtonGroupItem>(
    { component: "ButtonGroup", prop: "items", item: "GroupButton" },
    options.items,
    options,
    children,
  );
  return node("ButtonGroup", {
    Items: groupButtonItems(items),
    ButtonsOrientation: options.orientation,
    SpaceBetweenButtons: options.spaceBetween,
  });
}

// ---------------------------------------------------------------------------
// Data display
// ---------------------------------------------------------------------------

/** Whether the agent can drag a column edge. `"flexible"` columns are resizable. */
export type ColumnWidth = "locked" | "flexible";

/**
 * What a column's cells hold.
 *
 * `"action"` is the one that does something: those cells render as links, and clicking one raises the
 * table's {@link TableOptions.tableAction} with that row as the submitted data. `"text"` and
 * `"number"` both render the value.
 */
export type TableColumnType = "text" | "number" | "action";

/** How a column's cells are edited in place. `"select"` is a dropdown over {@link TableColumn.options}. */
export type TableEditableType = "input" | "select";

interface TableColumnBase {
  /**
   * The column heading.
   *
   * `Label` on the wire, not `Header` — a `Table`'s own `Header` is the heading above the whole table,
   * and a column given one renders with a blank heading instead.
   */
  label: string;
  /**
   * Which key of a row this column shows, and the key it submits under.
   *
   * A cell reaches the flow as `$.Views.ViewResultData.<table name>.0.<id>`, so this is half of the
   * table's output contract, the same way a form field's `name` is.
   */
  id: string;
  type?: TableColumnType;
}

/**
 * One column of a {@link Table}.
 *
 * `options` belongs to `editableType: "select"` and is required there, which is the one conditional
 * Connect's own schema carries: a select with nothing to select from is rejected when the column list
 * arrives as a reference, and renders as an empty dropdown when it is written out.
 */
export type TableColumn =
  | (TableColumnBase & { editableType?: "input"; options?: never })
  | (TableColumnBase & { editableType: "select"; options: Array<string | number> });

/**
 * One column of a {@link Table}, as a child rather than an object literal.
 *
 *     <Table items={inputs.orders} name={fields.OrderTable} tableAction={actions.OrderSelected}>
 *       <Column label="Order" id="order_id" type="action" />
 *       <Column label="Priority" id="priority" editableType="select" options={["1", "2", "3"]} />
 *       <GroupButton label="Save" action={actions.Save} variant="primary" formAction="submit" />
 *     </Table>
 *
 * A column is an entry in the table's `Columns` rather than a component of its own — see
 * {@link ViewItemNode} — so anywhere but inside a `Table` it is rejected when the view is assembled.
 */
export function Column(options: TableColumn): ViewItemNode<TableColumn> {
  if (options.editableType === "select" && (options.options ?? []).length === 0) {
    throw new Error(
      `Column "${options.label}" is an editable select with no \`options\`, so there would be ` +
        "nothing to choose from. Pass the values it offers.",
    );
  }
  return itemNode("Column", "Table", { ...options } as TableColumn);
}

/** Per-row settings, alongside the row's own values. */
export interface TableRowConfiguration {
  /**
   * Column `id`s this row will not let the agent edit.
   *
   * PascalCase, and inside the row rather than the column, because it is data the flow supplies with
   * the rows themselves — editability that varies row by row is the only thing it can express.
   */
  EditableDisabled: Array<string | number>;
}

/**
 * One row of a {@link Table}: a value per column `id`, plus optional per-row settings.
 *
 * The keys are the columns' `id`s rather than anything declared here, since the rows usually arrive
 * from a Lambda.
 */
export interface TableRow {
  [column: string]: ViewValue | TableRowConfiguration | undefined;
  _Configuration?: TableRowConfiguration;
}

export interface TableOptions {
  /** A `$.` reference to the rows, or the rows themselves. */
  items: string | TableRow[];
  /** The columns, in order. A reference, a list, or {@link Column} children — not both. */
  columns?: TableColumn[] | string;
  /**
   * Buttons across the table's header, laid out as a `ButtonGroup`.
   *
   * A reference, a list, or {@link GroupButton} children. An action with `formAction: "submit"`
   * submits the table's edited rows along with the enclosing `Form`.
   */
  actions?: ButtonGroupItem[] | string;
  children?: JsxChildren;
  /**
   * The action a cell in a `type: "action"` column raises, carrying that row as the submitted data.
   *
   * Required once any column is an action column: Connect's own default is the literal action name
   * `"TableAction"`, which is a branch nobody means to write.
   */
  tableAction?: string;
  /**
   * The key this table submits under, read back as `$.Views.ViewResultData.<name>.0.<column id>`.
   *
   * Optional, unlike a form field's — a table nothing reads back needs no name. Connect names an
   * unnamed one `TableName`.
   */
  name?: string;
  /** The heading above the table. */
  header?: string;
  /** Supporting text under the heading. */
  description?: string;
  /** Adds the search box that filters rows as the agent types. */
  filterable?: boolean;
  /** Rows per page. Without one the table shows every row and has no pager. */
  itemsPerPage?: number | string;
  columnWidth?: ColumnWidth;
}

const TABLE_COLUMNS: ItemList = { component: "Table", prop: "columns", item: "Column" };
const TABLE_ACTIONS: ItemList = { component: "Table", prop: "actions", item: "GroupButton" };

/** Splits a table's children into its two lists, since it carries both. */
function tableChildren(options: TableOptions, positional: ViewChild[]) {
  const columns: TableColumn[] = [];
  const actions: ButtonGroupItem[] = [];
  for (const child of contentOf(options, positional)) {
    if (isViewItemNode(child) && child.Type === "Column") columns.push(child._item as TableColumn);
    else if (isViewItemNode(child) && child.Type === "GroupButton")
      actions.push(child._item as ButtonGroupItem);
    else
      throw new Error(
        `Table takes only <Column> and <GroupButton> children, but was given ` +
          `${describeChild(child)}. Its contents are its columns and its actions rather than a ` +
          "component tree.",
      );
  }
  return { columns, actions };
}

/**
 * A table of rows, usually fed from a `$.` reference to a Lambda's response.
 *
 * The columns say what to show and what may be edited; the actions are the buttons in the header; and
 * an action column turns each of its cells into a link that raises `tableAction` for that row:
 *
 * ```ts
 * Table({
 *   items: inputs.orders,
 *   name: fields.OrderTable,
 *   tableAction: actions.OrderSelected,
 *   header: "Recent orders",
 *   filterable: true,
 *   itemsPerPage: 5,
 *   columns: [
 *     { label: "Order", id: "order_id", type: "action" },
 *     { label: "Status", id: "status" },
 *     { label: "Priority", id: "priority", editableType: "select", options: ["1", "2", "3"] },
 *   ],
 *   actions: [{ label: "Save", action: actions.Save, variant: "primary", formAction: "submit" }],
 * })
 * ```
 *
 * Whichever way a row leaves the table — an action column, or an action that submits the form — it
 * arrives as `$.Views.ViewResultData.<name>.0.<column id>`, indexed rather than keyed.
 */
export function Table(
  options: TableOptions,
  children: Array<ViewItemNode<TableColumn | ButtonGroupItem>> = [],
): ViewNode {
  const fromChildren = tableChildren(options, children);
  const columns =
    pickList(TABLE_COLUMNS, options.columns, fromChildren.columns) ?? noneGiven(TABLE_COLUMNS);
  const actions = pickList(TABLE_ACTIONS, options.actions, fromChildren.actions);

  if (
    options.tableAction === undefined &&
    typeof columns !== "string" &&
    columns.some((column) => column.type === "action")
  ) {
    throw new Error(
      "Table has an action column but no `tableAction`, so clicking a cell would raise Connect's " +
        'default action name, "TableAction". Name the action the flow branches on.',
    );
  }

  return node("Table", {
    Items: options.items,
    Columns:
      typeof columns === "string"
        ? columns
        : columns.map((column) =>
            compactProps({
              Label: column.label,
              Id: column.id,
              Type: column.type,
              EditableType: column.editableType,
              Options: column.options,
            }),
          ),
    Actions: actions === undefined ? undefined : groupButtonItems(actions),
    TableAction: options.tableAction,
    ColumnWidth: options.columnWidth,
    Header: options.header,
    Filterable: options.filterable,
    ItemsPerPage: options.itemsPerPage,
    Name: options.name,
    Description: options.description,
  });
}

/** A selectable card. */
export function Card(
  options: {
    /** Required by the service. */
    id: string;
    heading?: string;
    description?: string;
    /** Reported back when the card is chosen. */
    action?: string;
    /** An illustration name, same set as {@link Icon}. */
    icon?: CardIconName;
    status?: string;
  } & { children?: JsxChildren },
  children: ViewChild[] = [],
): ViewNode {
  return node(
    "Card",
    {
      Heading: options.heading,
      Description: options.description,
      Id: options.id,
      Action: options.action,
      Icon: options.icon,
      Status: options.status,
    },
    contentOf(options, children),
  );
}

export interface AttributeItem {
  label: string;
  value: string;
  copyable?: boolean;
  url?: string;
  linkType?: LinkType;
  resourceId?: string;
  autoOpen?: boolean;
}

function attributeItems(items: AttributeItem[] | string): unknown {
  if (typeof items === "string") return items;
  return items.map((item) =>
    compactProps({
      Label: item.label,
      Value: item.value,
      Copyable: item.copyable,
      Url: item.url,
      LinkType: item.linkType,
      ResourceId: item.resourceId,
      AutoOpen: item.autoOpen,
    }),
  );
}

/**
 * One attribute of an {@link AttributeBar} or {@link AttributeSection}, as a child rather than an
 * object literal.
 *
 *     <AttributeBar>
 *       <Attribute label="Reference" value={inputs.docRef} url={inputs.docRefLink} linkType="external" />
 *     </AttributeBar>
 *
 * An attribute is an entry in its parent's list rather than a component of its own — see
 * {@link ViewItemNode} — so anywhere else it is rejected when the view is assembled.
 */
export function Attribute(options: AttributeItem): ViewItemNode<AttributeItem> {
  return itemNode("Attribute", "AttributeBar or AttributeSection", { ...options });
}

/**
 * The strip of contact attributes across the top of a view.
 *
 * The attributes come from `attributes` — a list, or a `$.` reference to one — or from
 * {@link Attribute} children, not both.
 */
export function AttributeBar(
  options: { attributes?: AttributeItem[] | string; children?: JsxChildren } = {},
  children: Array<ViewItemNode<AttributeItem>> = [],
): ViewNode {
  const items = itemsOf<AttributeItem>(
    { component: "AttributeBar", prop: "attributes", item: "Attribute" },
    options.attributes,
    options,
    children,
  );
  return node("AttributeBar", { Attributes: attributeItems(items) });
}

/**
 * A labelled block of read-only attributes.
 *
 * As with {@link AttributeBar}, the attributes come from `items` or from {@link Attribute} children.
 */
export function AttributeSection(
  options: {
    heading?: string;
    items?: AttributeItem[] | string;
    children?: JsxChildren;
    columns?: number | string;
    /** Shown when `items` is empty. */
    noItemMessage?: string;
    configuration?: ViewConfiguration;
  } = {},
  children: Array<ViewItemNode<AttributeItem>> = [],
): ViewNode {
  const items = itemsOf<AttributeItem>(
    { component: "AttributeSection", prop: "items", item: "Attribute" },
    options.items,
    options,
    children,
  );
  return node(
    "AttributeSection",
    {
      Heading: options.heading,
      Items: attributeItems(items),
      Columns: options.columns,
      NoItemMessage: options.noItemMessage,
    },
    [],
    options.configuration,
  );
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

/**
 * Wraps form fields and gives them a submit target.
 *
 * Field values are reported back to the flow keyed by each field's `name`.
 */
export function Form(
  options: WithChildren<{ hideBorder?: boolean; configuration?: ViewConfiguration }> = {},
  children: ViewChild[] = [],
): ViewNode {
  return node(
    "Form",
    { HideBorder: options.hideBorder },
    contentOf(options, children),
    options.configuration,
  );
}

export type InputType = "number" | "text" | "password" | "email" | "tel" | "url";

interface FieldOptions {
  name: string;
  label?: string;
  defaultValue?: string;
  required?: boolean;
  disabled?: boolean;
  helperText?: string;
}

function field(
  type: string,
  options: Omit<FieldOptions, "defaultValue"> & { defaultValue?: string | string[] },
  extra: Record<string, unknown> = {},
): ViewNode {
  return node(type, {
    Name: options.name,
    Label: options.label,
    DefaultValue: options.defaultValue,
    Required: options.required,
    Disabled: options.disabled,
    HelperText: options.helperText,
    ...extra,
  });
}

/** A single-line input. */
export function FormInput(options: FieldOptions & { inputType?: InputType }): ViewNode {
  return field("FormInput", options, { InputType: options.inputType });
}

/** A multi-line input. */
export function TextArea(options: FieldOptions): ViewNode {
  return field("TextArea", options);
}

export interface SelectOption {
  label: string;
  value: string;
}

function selectOptions(options: SelectOption[] | string): unknown {
  return typeof options === "string"
    ? options
    : options.map((o) => ({ Label: o.label, Value: o.value }));
}

/**
 * A select, optionally multi-select.
 *
 * Its `DefaultValue` is an *array*, unlike every other field's — the schema types it that way whether
 * or not `multiSelect` is set, and AWS's own views emit a one-element array for a single select. A
 * single string is wrapped here rather than left to the author.
 *
 * The same asymmetry shows up on the way back: a Dropdown submits an array, so the flow reads
 * `result.Category.at(0)` (`$.Views.ViewResultData.Category.0`), not `result.Category`.
 */
export function Dropdown(
  options: Omit<FieldOptions, "defaultValue"> & {
    choices: SelectOption[] | string;
    /** One value, or several for a multi-select. Emitted as an array either way. */
    defaultValue?: string | string[];
    multiSelect?: boolean;
    clearable?: boolean;
  },
): ViewNode {
  const defaultValue = options.defaultValue;
  return field("Dropdown", options, {
    DefaultValue:
      defaultValue === undefined
        ? undefined
        : Array.isArray(defaultValue)
          ? defaultValue
          : [defaultValue],
    Options: selectOptions(options.choices),
    MultiSelect: options.multiSelect,
    Clearable: options.clearable,
  });
}

/** Radio buttons: one choice from several. */
export function RadioGroup(options: FieldOptions & { choices: SelectOption[] | string }): ViewNode {
  return field("RadioGroup", options, { Options: selectOptions(options.choices) });
}

/** Checkboxes: any number of choices. */
export function CheckboxGroup(
  options: FieldOptions & { choices: SelectOption[] | string },
): ViewNode {
  return field("CheckboxGroup", options, { Options: selectOptions(options.choices) });
}

/** A date field. */
export function DatePicker(options: FieldOptions): ViewNode {
  return field("DatePicker", options);
}

/** A time field. */
export function TimePicker(options: FieldOptions): ViewNode {
  return field("TimePicker", options);
}

/** An on/off switch. */
export function Toggle(options: FieldOptions): ViewNode {
  return field("Toggle", options);
}
