/**
 * A shared pattern library.
 *
 * This is a separate package from the flow that uses it. Nothing here knows it is being recorded,
 * receives a context object, or imports anything from the consuming stack — it just calls the same
 * exported functions a flow would.
 */

import {
  attr,
  collectInput,
  disconnect,
  flowIf,
  play,
  type Ref,
  setAttributes,
  withScope,
} from "pulumi-amazon-connect";

export interface AuthenticateOptions {
  /** Prompt played before collecting the account number. */
  prompt?: string;
  /** Digits expected in an account number. */
  accountLength?: number;
}

/**
 * Collects an account number and stores it on the contact.
 *
 * Returns a ref to the stored value, so the caller can use it like any other attribute.
 */
export function authenticateCaller(options: AuthenticateOptions = {}): Ref<string> {
  return withScope("auth", () => {
    const entered = collectInput({
      text: options.prompt ?? "Please enter your account number, followed by the pound key.",
      timeoutSeconds: 10,
      maxLength: options.accountLength ?? 8,
    });

    setAttributes({ accountNumber: entered });
    return attr<string>("accountNumber");
  });
}

/** A closing message and hang-up, used as an error handler in more than one place. */
export function apologizeAndHangUp(): void {
  withScope("apology", () => {
    play("Sorry, we're having trouble right now. Please try again later.");
    disconnect();
  });
}

/**
 * Greets by name when one is known, and generically when it is not.
 *
 * The unknown case is a `"none"` sentinel rather than an empty string because Connect has no
 * comparison against blank — it rejects an empty operand outright — so whatever sets `firstName`
 * writes `"none"` when it has no name to write.
 */
export function greetByName(): void {
  withScope("greeting", () => {
    flowIf(
      { op: "equals", left: attr<string>("firstName"), right: "none" },
      {
        ifTrue: () => play("Thanks for calling."),
        ifFalse: () => play(`Welcome back, ${attr("firstName")}.`),
      },
    );
  });
}
