/**
 * Typed references to a view's input data.
 *
 * A view declares its inputs by referencing them: a property or content item whose entire value is
 * `$.Something` becomes a required input, and Connect derives the view's `InputSchema` from those
 * references. Writing those strings by hand is the easiest thing to get wrong in a view — a typo
 * silently becomes a *different* input, which the flow then never supplies.
 *
 * So the reference is produced from a declared type instead. `inputs.customerName` is the string
 * `"$.customerName"`, typed, and a misspelling is a compile error.
 */

/**
 * A reference to one input.
 *
 * It is a real string, so it drops straight into any component property or content slot, and carries
 * the input's type as a phantom so `showView`'s data can be checked against it.
 */
export type InputRef<T = string> = string & { readonly __input?: T };

/**
 * What a view's inputs may be.
 *
 * Any object type, so a plain `interface` works without needing an index signature.
 */
export type ViewInputs = object;

/** Typed references for every declared input. */
export type InputRefs<In> = { readonly [K in keyof In & string]: InputRef<In[K]> };

/**
 * Builds the reference object for a declared input type.
 *
 * A proxy, because the input names exist only in the type — there is no runtime list to enumerate.
 * Each access returns a plain string rather than another proxy, so the value serializes correctly and
 * behaves like the string it is.
 */
export function inputRefs<In extends ViewInputs>(): InputRefs<In> {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        assertInputName(property);
        return `$.${property}`;
      },
      has() {
        return true;
      },
    },
  ) as InputRefs<In>;
}

/**
 * A reference to a nested input, e.g. `ref("customer.name")`.
 *
 * The escape hatch for paths {@link inputRefs} cannot express: property access returns a plain string,
 * so it cannot be chained. Nothing checks the path, which is exactly why the flat form is preferred.
 */
export function ref<T = string>(path: string): InputRef<T> {
  for (const segment of path.split(".")) assertInputName(segment.replace(/\[\d*\]$/, ""));
  return `$.${path}` as InputRef<T>;
}

/**
 * Input names become part of a JSONPath, and Connect's own schema restricts them to word characters,
 * so a name with a dot or a space would silently reference something else.
 */
function assertInputName(name: string): void {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(
      `Input name ${JSON.stringify(name)} must be letters, digits or underscores. ` +
        'For a nested path use ref("customer.name").',
    );
  }
}

/**
 * Typed names for a view's output fields.
 *
 * A form field reports its value back to the flow under its `name`, so the name is half of the view's
 * output contract and the flow reads `$.Views.ViewResultData.<name>`. `fields.notes` is the string
 * `"notes"`, checked against the declared output type, so a field the flow reads and a field the view
 * renders cannot drift apart.
 */
export type FieldRefs<Out> = { readonly [K in keyof Out & string]: K };

/**
 * Builds the field-name object for a declared output type, recording which names were used.
 *
 * The record is what lets {@link defineView} reject a field whose name bypassed this object: the
 * output names exist only in the type, so a literal string is otherwise unfalsifiable.
 */
export function fieldRefs<Out>(used: Set<string>): FieldRefs<Out> {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        assertInputName(property);
        used.add(property);
        return property;
      },
      has() {
        return true;
      },
    },
  ) as FieldRefs<Out>;
}
