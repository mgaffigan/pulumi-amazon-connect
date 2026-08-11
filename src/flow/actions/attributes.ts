/**
 * Reading and writing the values that stand in for a flow's variables.
 *
 * Contact attributes travel with the contact across transfers; flow attributes are scoped to the
 * current flow. Prefer flow attributes for scratch values — they are not written to the contact
 * record, so they neither leak into reporting nor count against contact attribute limits.
 */

import { assertValidAttributeKey, type Ref, renderValue } from "../refs.js";
import { NO_MATCHING_ERROR } from "../types.js";
import { compact, type OutcomeHandler, recordAction } from "./action.js";

/** Values assignable to an attribute: a literal, or a reference resolved at runtime. */
export type AttributeValue = string | number | boolean | Ref<unknown>;

export interface SetAttributesOptions {
  /** `Current` writes the running contact; `Related` writes the contact it was created from. */
  target?: "Current" | "Related";
  onError?: OutcomeHandler;
}

/**
 * Writes contact attributes, which survive transfers to other flows.
 *
 * ```ts
 * setAttributes({ tier: customer.tier, greeted: "true" });
 * ```
 *
 * Connect applies the whole set atomically: either every attribute is written or none is.
 */
export function setAttributes(
  attributes: Record<string, AttributeValue>,
  options: SetAttributesOptions = {},
): void {
  const entries = Object.entries(attributes);
  if (entries.length === 0) {
    throw new Error("setAttributes requires at least one attribute.");
  }
  for (const [key] of entries) assertValidAttributeKey(key);

  recordAction({
    type: "UpdateContactAttributes",
    hint: "set-attributes",
    parameters: compact({
      Attributes: Object.fromEntries(entries.map(([k, v]) => [k, renderValue(v)])),
      TargetContact: options.target ?? "Current",
    }),
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

/**
 * Writes flow attributes, which are discarded when this flow ends.
 *
 * ```ts
 * setFlowAttributes({ attempts: "1" });
 * ```
 *
 * Read them back with `flowAttr("attempts")`.
 */
export function setFlowAttributes(attributes: Record<string, AttributeValue>): void {
  const entries = Object.entries(attributes);
  if (entries.length === 0) {
    throw new Error("setFlowAttributes requires at least one attribute.");
  }
  for (const [key] of entries) assertValidAttributeKey(key);

  recordAction({
    type: "UpdateFlowAttributes",
    hint: "set-flow-attributes",
    parameters: {
      FlowAttributes: Object.fromEntries(
        entries.map(([k, v]) => [k, { Type: "String", Value: renderValue(v) }]),
      ),
    },
    // The reference says this action has no errors; the service requires one.
    requiredErrors: [NO_MATCHING_ERROR],
  });
}
