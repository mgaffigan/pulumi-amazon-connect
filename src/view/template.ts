/**
 * Assembling a view template from a component tree.
 *
 * The wire format is `{ Head, Body }`: `Head` carries the title and layout configuration, `Body` the
 * tree. Every node needs a stable `_id`, and every action a component can raise has to appear in the
 * view's `Actions` list — both are derived here rather than left to the author.
 *
 * `InputSchema` is deliberately not produced: Connect computes it from the `$.` references in the
 * template, and returns it from `CreateView`. Reading it back is how you confirm the view's inputs are
 * what you meant.
 */

import {
  flattenChildren,
  type ItemChildren,
  isViewItemNode,
  type JsxChildren,
  type TextContent,
  type ViewChild,
  type ViewConfiguration,
  type ViewNode,
} from "./components.js";
import type { Shape, ViewOutput } from "./connectView.js";
import { type FieldRefs, fieldRefs, type InputRefs, inputRefs, type ViewInputs } from "./inputs.js";

export interface ViewHead {
  Title: string;
  /** Required by the validator, even when empty. */
  Configuration: ViewConfiguration;
}

export interface ViewTemplate {
  Head: ViewHead;
  Body: ViewNode[];
}

export interface ViewContent {
  /** Serialized on the way to `CreateView`, which takes the template as a JSON string. */
  Template: ViewTemplate;
  /** Every action the view can raise. */
  Actions: string[];
}

/**
 * Components whose `Name` becomes a key in what the view submits back.
 *
 * `Table` belongs here: a named table reports the selected rows, which the flow reads positionally as
 * `$.Views.ViewResultData.<Name>.0.<column>`. Its name is optional, unlike a form field's.
 */
const FIELD_TYPES = new Set([
  "Table",
  "FormInput",
  "TextArea",
  "Dropdown",
  "RadioGroup",
  "CheckboxGroup",
  "DatePicker",
  "TimePicker",
  "Toggle",
]);

/** Collects form field names, which is what a submitted view reports back. */
function collectFields(nodes: ViewNode[], found: string[]): void {
  for (const node of nodes) {
    if (FIELD_TYPES.has(node.Type)) {
      const name = node.Props.Name;
      if (typeof name === "string") found.push(name);
    }
    collectFields(elements(node.Content), found);
  }
}

/**
 * What a view's builder is handed.
 *
 * Both halves exist to stop the two things a view gets wrong silently: a mistyped input reference
 * becomes a different input the flow never supplies, and a mistyped action becomes a branch the flow
 * never handles. Neither is possible through these.
 */
export interface ViewContext<In extends ViewInputs, Out extends ViewOutput, A extends string> {
  /** `inputs.customerName` is the reference `"$.customerName"`, checked against the declared type. */
  inputs: InputRefs<In>;
  /** `actions.Skip` is the string `"Skip"`, checked against the declared list. */
  actions: { readonly [K in A]: K };
  /**
   * `fields.notes` is the field name `"notes"`, checked against the declared output type.
   *
   * Naming a field through this is what keeps the view and the flow in agreement: the flow reads
   * `$.Views.ViewResultData.notes` from the same declaration.
   */
  fields: FieldRefs<Out>;
}

export interface DefineViewOptions<
  In extends ViewInputs,
  Out extends ViewOutput,
  A extends string,
> {
  title: string;
  /**
   * Every action this view raises.
   *
   * Declared rather than inferred so the builder gets a checked object, and so the list handed to
   * Connect has a stable order. Assembly fails if the tree raises an action that is not declared, or
   * declares one nothing raises.
   *
   * Optional: a view that only displays something raises nothing, and needs no list.
   */
  actions?: readonly A[];
  /**
   * The data the view expects, as a type.
   *
   * Produces the typed `inputs` references. Pass `shape<MyInputs>()`; there is no runtime value.
   */
  inputs?: Shape<In>;
  /**
   * The data the view submits back, as a type.
   *
   * Produces the typed `fields` names, and carries through to `connectView` so the flow reads the
   * submitted values as typed references. Declaring it also makes assembly reject a field whose name
   * did not come from `fields`.
   */
  outputs?: Shape<Out>;
  /**
   * Layout for the whole view, e.g. `{ Layout: { Columns: ["10", "2"] } }`.
   *
   * The same shape a component takes, since `Head.Configuration` and a node's are one definition in
   * the service's schema.
   */
  configuration?: ViewConfiguration;
  /**
   * The component tree. Receives the typed inputs, actions and field names.
   *
   * One component, or a list of them for a body with several top-level components. The list may nest
   * and may hold the gaps a `cond && <X/>` leaves behind, since a `.map` or a fragment produces both;
   * a body that flattens to nothing is an error, as a view needs something to show.
   */
  body: (context: ViewContext<In, Out, A>) => ViewNode | Array<ItemChildren<ViewNode>>;
}

/**
 * Components whose content may hold other components at the top level of `Body`.
 *
 * Elsewhere in the tree anything nests, but a top-level node is validated strictly: a `Button` holding
 * a `TextBox` is rejected at the top level and accepted one level down. Every AWS-managed view's body is
 * a single container for this reason.
 */
const TOP_LEVEL_CONTAINERS = new Set(["Container", "Section", "Form"]);

/** Only element children carry ids, actions and nested props; text content does not. */
function elements(content: ViewChild[]): ViewNode[] {
  return content.filter((c): c is ViewNode => typeof c === "object" && c !== null);
}

/**
 * Rejects `$.` references embedded inside longer strings.
 *
 * A property whose whole value is `$.Something` declares an input, and Connect lists it in the derived
 * `InputSchema`. The same reference inside a longer string declares nothing and renders literally — so
 * `"Hello $.CustomerName"` reaches the customer with the `$.CustomerName` still in it. Confirmed by
 * publishing: the embedded form produced an empty input schema.
 *
 * Interpolation is still possible: pass the literal text and the reference as *separate* content items,
 * which Connect joins while still declaring the input.
 */
/** Props nest — table columns, attribute items, layout — so every string in the subtree is checked. */
function checkValue(value: unknown, where: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      checkValue(entry, `${where}[${index}]`);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) checkValue(nested, `${where}.${key}`);
    return;
  }
  if (typeof value !== "string") return;

  const index = value.indexOf("$.");
  if (index === -1) return;
  if (value.startsWith("$.#")) {
    throw new Error(
      `${where} uses a "$.#" integration reference, which must be declared in the view's Head. ` +
        "Integrations are not supported by this library yet.",
    );
  }
  if (index !== 0 || /\s/.test(value)) {
    throw new Error(
      `${where} embeds a "$." reference inside a longer string: ${JSON.stringify(value)}. ` +
        "Connect only treats a reference as an input when it is the entire value; embedded in text " +
        "it renders literally. Split it into separate content items instead, such as " +
        '["Hello ", "$.CustomerName"].',
    );
  }
}

/**
 * Rejects an item pseudo-node no parent folded in.
 *
 * `<GroupButton>` describes one entry of a `ButtonGroup`'s `Items`, so a `GroupButton` still in the tree
 * means it was written somewhere that list is not — and `"GroupButton"` is not a component Connect
 * knows, so publishing would report an unknown component with no hint as to why.
 */
function checkItemNodes(nodes: ViewNode[], path: string, title: string): void {
  for (const node of nodes) {
    const here = `${path}/${node.Type}`;
    if (isViewItemNode(node)) {
      throw new Error(
        `View "${title}" has a <${node.Type}> at ${here}, outside the ${node._itemOf} it belongs to. ` +
          `<${node.Type}> is one entry of that component's list rather than a component of its own.`,
      );
    }
    checkItemNodes(elements(node.Content), here, title);
  }
}

/** The key pattern from the component library's schema generator: `^--[a-z0-9\-]+$`. */
const STYLE_KEY = /^--[a-z0-9-]+$/;

/**
 * Rejects a `Configuration.Style` key Connect's validator would.
 *
 * Worth catching here rather than at publish: the service returns `InvalidParameterException`, and
 * the `AWS::Connect::View` CloudFormation handler retries that forever instead of failing, so the
 * only symptom is `pulumi up` sitting on `creating (…s)` with nothing in the log.
 */
function checkStyle(style: unknown, where: string): void {
  if (style === undefined || typeof style === "string") return;
  if (style === null || typeof style !== "object") return;
  for (const key of Object.keys(style)) {
    if (STYLE_KEY.test(key)) continue;
    throw new Error(
      `${where}.Style has the key ${JSON.stringify(key)}, which Connect rejects. Style takes ` +
        "component custom properties only — lower-case, digits and hyphens after a `--` prefix, " +
        'such as { "--container-padding-top": "0" }. A plain CSS property is not one.',
    );
  }
}

function checkReferences(nodes: ViewNode[], path: string): void {
  for (const node of nodes) {
    const here = `${path}/${node.Type}`;
    for (const [key, value] of Object.entries(node.Props)) checkValue(value, `${here}.${key}`);
    // Layout takes references too — a column count can come from the flow.
    if (node.Configuration !== undefined) {
      checkValue(node.Configuration, `${here}.Configuration`);
      checkStyle(node.Configuration.Style, `${here}.Configuration`);
    }
    node.Content.forEach((item: ViewChild, index: number) => {
      if (typeof item !== "object") checkValue(item as TextContent, `${here}.Content[${index}]`);
    });
    checkReferences(elements(node.Content), here);
  }
}

/** Collects every action name the tree raises, from `Action` props and from table/button items. */
function collectActions(nodes: ViewNode[], found: Set<string>): void {
  for (const node of nodes) {
    const action = node.Props.Action;
    if (typeof action === "string" && action.length > 0) found.add(action);

    // A Table's row action is a property of its own: clicking a cell in an action column raises it.
    const tableAction = node.Props.TableAction;
    if (typeof tableAction === "string" && tableAction.length > 0) found.add(tableAction);

    // ButtonGroup and Table carry their own action names inside item arrays.
    for (const value of Object.values(node.Props)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (item !== null && typeof item === "object") {
          const nested = (item as { Action?: unknown }).Action;
          if (typeof nested === "string" && nested.length > 0) found.add(nested);
        }
      }
    }

    collectActions(elements(node.Content), found);
  }
}

/**
 * Assigns each node a stable `_id` from its position in the tree.
 *
 * Position rather than a counter, so inserting a node does not renumber its siblings' subtrees — the
 * same reasoning as flow identifiers.
 */
function assignIds(nodes: ViewNode[], prefix: string): void {
  nodes.forEach((node, index) => {
    const id = `${prefix}${node.Type.toLowerCase()}-${index}`;
    node._id = id;
    assignIds(elements(node.Content), `${id}-`);
  });
}

/**
 * A view built by {@link defineView}, carrying the types it was declared with.
 *
 * The phantom `inputs` and `outputs` are why `connectView({ viewId, view })` needs no redeclaration:
 * the input data, the submitted values and the action list all come from here, so the template and the
 * flow that shows it cannot disagree.
 */
export interface DefinedView<In extends ViewInputs, Out extends ViewOutput, A extends string>
  extends ViewContent {
  /** The declared action names, as a literal tuple. */
  actions: readonly A[];
  /** Form field names found in the tree: the keys a submitted view reports back. */
  fields: string[];
  /** Type witness for the declared inputs. Carries no data. */
  readonly inputs: Shape<In>;
  /** Type witness for the declared outputs. Carries no data. */
  readonly outputs: Shape<Out>;
}

/**
 * Builds a view's content from a component tree.
 *
 * ```ts
 * interface PatientSearchInputs {
 *   customerName: string;
 * }
 *
 * const patientSearch = defineView({
 *   title: "Patient search",
 *   actions: ["Next", "Back"],
 *   inputs: shape<PatientSearchInputs>(),
 *   body: ({ inputs, actions }) =>
 *     Container({}, [
 *       TextBox("Patient search", { variant: "h2" }),
 *       TextBox(["Hello ", inputs.customerName]),
 *       Button({ action: actions.Next, variant: "primary" }, [TextBox("Continue")]),
 *       Button({ action: actions.Back }, [TextBox("Back")]),
 *     ]),
 * });
 * ```
 *
 * `inputs.customerName` is the reference string, so a mistyped input is a compile error rather than a
 * different input the flow never supplies. `actions.Next` is likewise checked against the declared
 * list.
 *
 * @throws if the tree and the declared action list disagree, which is otherwise a runtime dead end for
 * whoever hits the missing branch.
 */
export function defineView<
  In extends ViewInputs = Record<string, never>,
  Out extends ViewOutput = Record<string, never>,
  const A extends string = never,
>(options: DefineViewOptions<In, Out, A>): DefinedView<In, Out, A> {
  const declaredActions = options.actions ?? [];
  const usedFields = new Set<string>();
  const built = options.body({
    inputs: inputRefs<In>(),
    // Each declared name maps to itself, so `actions.Skip` is checked and cannot drift from the list.
    actions: Object.fromEntries(declaredActions.map((a) => [a, a])) as { [K in A]: K },
    fields: fieldRefs<Out>(usedFields),
  });
  // Flattened rather than wrapped: a fragment or an array-returning component is typed as one element
  // (see `JSX.Element`) but produces several, so the body arrives arbitrarily nested — and the same
  // flattening drops the `false` a `cond && <X/>` at the top level leaves behind.
  const flattened = flattenChildren(built as JsxChildren);

  if (flattened.length === 0) {
    throw new Error("A view needs at least one component in its body.");
  }

  // Text at the top level would publish as a `Body` entry with no `Type`, which Connect rejects with
  // nothing to go on. It only becomes reachable through a fragment, whose contents are unchecked text.
  const declaredBody = flattened.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(
        `View "${options.title}" has text at the top level of its body: ${JSON.stringify(item)}. ` +
          "A view's body is a list of components; put the text inside one, such as TextBox.",
      );
    }
    return item;
  });

  // Deep-copy so a component tree can be reused across views without ids leaking between them.
  const body = structuredClone(declaredBody);
  checkItemNodes(body, "", options.title);
  assignIds(body, "");
  checkReferences(body, "");
  // The head declares inputs the same way the body does — every AWS-managed view's `Style` arrives
  // as `$.Style` — so the same rule about embedded references applies to it.
  if (options.configuration !== undefined) {
    checkValue(options.configuration, "Head.Configuration");
    checkStyle(options.configuration.Style, "Head.Configuration");
  }

  const raised = new Set<string>();
  collectActions(body, raised);
  const declared = new Set<string>(declaredActions);

  const undeclared = [...raised].filter((a) => !declared.has(a));
  if (undeclared.length > 0) {
    throw new Error(
      `View "${options.title}" raises undeclared action(s): ${undeclared.join(", ")}. ` +
        "Add them to `actions` so the flow can handle them.",
    );
  }

  const unused = [...declared].filter((a) => !raised.has(a));
  if (unused.length > 0) {
    throw new Error(
      `View "${options.title}" declares action(s) nothing raises: ${unused.join(", ")}. ` +
        "Remove them, or wire them to a component.",
    );
  }

  for (const node of body) {
    if (TOP_LEVEL_CONTAINERS.has(node.Type)) continue;
    if (elements(node.Content).length === 0) continue;
    throw new Error(
      `View "${options.title}" has a top-level ${node.Type} holding other components. Connect validates ` +
        "the top level of a view's body strictly and rejects that; wrap the body in a Container.",
    );
  }

  const fields: string[] = [];
  collectFields(body, fields);
  const duplicates = fields.filter((name, index) => fields.indexOf(name) !== index);
  if (duplicates.length > 0) {
    // Two fields sharing a name collide in the submitted data, and the later one wins silently.
    throw new Error(
      `View "${options.title}" has duplicate form field name(s): ${[...new Set(duplicates)].join(", ")}.`,
    );
  }

  if (options.outputs !== undefined) {
    const strayFields = fields.filter((name) => !usedFields.has(name));
    if (strayFields.length > 0) {
      // A literal name cannot be checked against the declared output type, so the flow would read
      // `$.Views.ViewResultData.<typo>` and get nothing, with no error anywhere.
      throw new Error(
        `View "${options.title}" names field(s) that did not come from the declared outputs: ` +
          `${strayFields.join(", ")}. Use the \`fields\` object, e.g. \`name: fields.${strayFields[0]}\`, ` +
          "so the name is checked against the output type the flow reads.",
      );
    }
  }

  return {
    Template: {
      Head: { Title: options.title, Configuration: options.configuration ?? {} },
      Body: body,
    },
    // Declared order, so the emitted list is stable rather than discovery-ordered.
    Actions: [...declaredActions],
    actions: declaredActions,
    fields,
    inputs: options.inputs ?? (EMPTY_SHAPE as Shape<In>),
    outputs: options.outputs ?? (EMPTY_SHAPE as Shape<Out>),
  };
}

/** Stands in for an undeclared shape; shapes carry no runtime data in either case. */
const EMPTY_SHAPE = Object.freeze({}) as unknown as Shape<unknown>;

/** Serializes content the way `CreateView` expects, with the template as a JSON string. */
export function toViewInputContent(content: ViewContent): { Template: string; Actions: string[] } {
  return { Template: JSON.stringify(content.Template), Actions: content.Actions };
}
