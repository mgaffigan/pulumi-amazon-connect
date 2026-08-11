/**
 * A fragment library living in its own module.
 *
 * It imports the same free functions a flow does and knows nothing about being recorded — which is
 * the property the composition tests exist to prove.
 */

import { attr, collectInput, play, type Ref, setAttributes, withScope } from "../../src/index.js";
import message from "./message.js";

export function greet(name: string): void {
  play(`Hello from ${name}.`);
}

/** Takes parameters and returns a typed ref, like any ordinary function. */
export function askForAccount(promptText: string): Ref<string> {
  return withScope("account", () => {
    const entered = collectInput({ text: promptText, timeoutSeconds: 5, maxLength: 8 });
    setAttributes({ accountNumber: entered });
    return attr<string>("accountNumber");
  });
}

/** Does its build-time work up front, which is what an async fragment has to do instead. */
export function greetFromBuildTimeData(): void {
  play(message);
}

/** Not supported: recording is synchronous, so this must fail loudly rather than misorder actions. */
export async function greetAsynchronously(): Promise<void> {
  await Promise.resolve();
  play("this never gets recorded");
}
