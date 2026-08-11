/**
 * JSX for view templates.
 *
 * JSX is only a compile-time transform, so Pulumi neither knows nor cares: TypeScript rewrites
 * `<TextBox/>` into a call to {@link jsx}, which produces the same plain component tree the functional
 * API does. Nothing React-related is involved, and no runtime is shipped to Connect.
 *
 * Enable it per project — usually in the tsconfig covering your Pulumi program:
 *
 *     {
 *       "compilerOptions": {
 *         "jsx": "react-jsx",
 *         "jsxImportSource": "pulumi-amazon-connect"
 *       }
 *     }
 *
 * Then author views in `.tsx`:
 *
 *     const view = defineView({
 *       title: "Patient search",
 *       actions: ["Next"],
 *       inputs: shape<{ customerName: string }>(),
 *       body: ({ inputs, actions }) => (
 *         <Container>
 *           <TextBox variant="h2">Patient search</TextBox>
 *           <TextBox>{["Hello ", inputs.customerName]}</TextBox>
 *           <Button action={actions.Next} variant="primary">Continue</Button>
 *         </Container>
 *       ),
 *     });
 *
 * Components keep their functional signatures; this runtime adapts JSX's single-props-object call into
 * them.
 *
 * `<>…</>` works, and so does a helper component that returns an array of nodes: both are flattened
 * where children are collected, so several siblings can come from one element.
 */

import {
  CONTENT_FIRST,
  flattenChildren,
  type JsxChildren,
  type TextContent,
  type ViewChild,
  type ViewNode,
} from "./components.js";

export { CONTENT_FIRST } from "./components.js";

/**
 * A component usable from JSX.
 *
 * The return type admits an array so that a component can emit several siblings — `<>…</>` is one such
 * component ({@link Fragment}), and a helper like `function Rows(): ViewNode[]` is another. Every place
 * children are collected flattens, so an array arrives where the nodes would have been written inline.
 */
export type ViewComponent = ((...args: never[]) => ViewNode | ViewChild[]) & {
  [CONTENT_FIRST]?: boolean;
};

type JsxProps = Record<string, unknown> & { children?: JsxChildren };

/**
 * The JSX factory.
 *
 * TypeScript emits this for every element; it is not called by hand.
 */
export function jsx(type: ViewComponent, props: JsxProps): ViewNode | ViewChild[] {
  const { children, ...rest } = props;
  const content = flattenChildren(children);

  if (type[CONTENT_FIRST] === true) {
    // Content-first components take their text positionally, e.g. TextBox(content, options).
    const call = type as unknown as (c: TextContent | TextContent[], o: unknown) => ViewNode;
    return call(content as TextContent[], rest);
  }

  const call = type as unknown as (o: unknown, c: ViewChild[]) => ViewNode | ViewChild[];
  return call(rest, content);
}

/** Multiple children go through the same factory; TypeScript picks this variant. */
export const jsxs = jsx;

/**
 * `<>...</>`: several siblings where one component is written.
 *
 * A fragment is a component that returns its children, following the same `(options, children)`
 * convention every component here does — {@link jsx} has already flattened them by this point, so there
 * is nothing to do but hand them back. The array is flattened again by whatever collects it, which is
 * what makes a fragment indistinguishable from writing its children in place.
 *
 * It carries no props: `<>` accepts none, and a `<Fragment key=…>` has nothing to key.
 */
export function Fragment(_options: unknown, children: ViewChild[] = []): ViewChild[] {
  return children;
}

/**
 * The JSX type contract TypeScript looks for on the `jsxImportSource` module.
 *
 * `ElementType` restricting to {@link ViewComponent} is what makes `<div>` or a React component a
 * compile error rather than something that fails at publish time.
 */
export namespace JSX {
  /**
   * The type of every JSX expression.
   *
   * A single node rather than `ViewNode | ViewChild[]`, even though a fragment or an array-returning
   * component produces several: TypeScript erases a child's own return type at the tag boundary, so
   * widening this would only make every `<Component/>` possibly-an-array at each use site while
   * changing nothing about what is caught. The arrays are flattened where children are collected, and
   * `defineView` flattens the body, so the difference is invisible to authors.
   */
  export type Element = ViewNode;
  export type ElementType = ViewComponent;
  export interface ElementChildrenAttribute {
    children: Record<string, never>;
  }
  /**
   * No intrinsic elements: there is no `<div>` in a view template.
   *
   * The empty map is load-bearing rather than a placeholder — TypeScript resolves a lowercase tag
   * through this type, so having no keys is what makes `<div>` a compile error.
   */
  // biome-ignore lint/complexity/noBannedTypes: see above; a populated type would permit HTML tags.
  export type IntrinsicElements = {};
}
