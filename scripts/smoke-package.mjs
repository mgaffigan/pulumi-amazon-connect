/**
 * Smoke-tests the built package the way a consumer loads it.
 *
 * The unit suite imports `src` through a bundler, which tolerates import cycles by hoisting. Real ESM
 * does not: a cycle between `components` and `jsx-runtime` throws `Cannot access '<symbol>' before
 * initialization`, but only when the JSX subpath is the first thing loaded — which is exactly what
 * `jsxImportSource` makes happen in a consumer's build and never happens in ours. That bug shipped once.
 *
 * Run after `npm run build`. Imports below are ordered deliberately; do not reorder them.
 */

import assert from "node:assert/strict";

const { jsx } = await import("../dist/view/jsx-runtime.js");
const { Button, Container, TextBox, defineView, shape } = await import("../dist/index.js");

// The tree the JSX transform produces, written out longhand so this file needs no compile step.
const view = defineView({
  title: "Smoke",
  actions: ["Continue"],
  inputs: shape(),
  body: ({ inputs, actions }) =>
    jsx(Container, {
      children: [
        jsx(TextBox, { variant: "h2", children: [["Hello ", inputs.customerName]] }),
        jsx(Button, { action: actions.Continue, children: "Continue" }),
      ],
    }),
});

const container = view.Template.Body[0];
assert.equal(container.Type, "Container");
assert.deepEqual(view.Actions, ["Continue"]);
assert.deepEqual(container.Content[0].Content, ["Hello ", "$.customerName"]);
assert.deepEqual(container.Content[1].Content, ["Continue"]);
assert.equal(container.Content[1].Props.Action, "Continue");

console.log("package smoke test passed");
