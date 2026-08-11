/**
 * The development JSX entry point.
 *
 * Bundlers and `"jsx": "react-jsxdev"` import `<source>/jsx-dev-runtime` and call `jsxDEV` with extra
 * debugging arguments. View templates have nothing to debug at runtime — they are plain data — so this
 * discards the extras and defers to the production factory, which keeps a development build producing
 * byte-identical templates.
 */

import type { ViewChild, ViewNode } from "./components.js";
import { jsx, type ViewComponent } from "./jsx-runtime.js";

export { Fragment, jsx, jsxs } from "./jsx-runtime.js";

/** Called by development builds in place of `jsx`; the trailing arguments are ignored. */
export function jsxDEV(
  type: ViewComponent,
  props: Record<string, unknown>,
): ViewNode | ViewChild[] {
  return jsx(type, props);
}
