/**
 * A flow module's contract: the input it accepts, the output it returns, and the branches it exits by.
 *
 * A view derives its input schema from its template, and a Lambda gets its types from the handler.
 * A module has neither, so the contract is declared — and it has to be declared *at runtime*, not
 * only as a type, because Connect wants the JSON Schema and TypeScript types are erased. Hence a
 * field map rather than a `shape<T>()` witness: one declaration produces both the schema on the wire
 * and the types every call site is checked against.
 *
 * ```ts
 * input: { phone: "string", attempts: "number" }
 * ```
 *
 * @see docs/wire-format-checks.md — every rule enforced here was recovered by publishing.
 */

import type { Ref } from "./refs.js";

/**
 * The scalar types a field may declare.
 *
 * Connect also documents `Array` and `Null`; neither is exposed yet. Nested objects are, by writing
 * a nested field map.
 */
export type ModuleFieldType = "string" | "number" | "integer" | "boolean";

/** A field map: each key is either a scalar type or a nested field map. */
export interface ModuleSchema {
  readonly [field: string]: ModuleFieldType | ModuleSchema;
}

/** The value type a declared field carries at runtime. */
export type ModuleData<S> = {
  [K in keyof S]: S[K] extends "string"
    ? string
    : S[K] extends "number" | "integer"
      ? number
      : S[K] extends "boolean"
        ? boolean
        : ModuleData<S[K]>;
};

/**
 * What may be passed for each declared field.
 *
 * A `Ref` is legal only where the field is a `string`. The service validates these values against
 * the declared JSON Schema, and a reference is just a string on the wire — so `$.Attributes.count`
 * against a `number` field is rejected at publish time. Making that a compile error is the point of
 * distinguishing the two here.
 */
export type ModuleInput<S> = {
  [K in keyof S]: S[K] extends "string"
    ? string | Ref<string>
    : S[K] extends "number" | "integer"
      ? number
      : S[K] extends "boolean"
        ? boolean
        : ModuleInput<S[K]>;
};

/** A branch a module can return through, beyond the error vertex every action has. */
export type ModuleBranch = string;

export interface ModuleContract {
  input?: ModuleSchema;
  output?: ModuleSchema;
  branches?: readonly ModuleBranch[];
}

/** Connect caps a module at eight custom branches. */
export const MAX_MODULE_BRANCHES = 8;

function isFieldType(value: ModuleFieldType | ModuleSchema): value is ModuleFieldType {
  return typeof value === "string";
}

/** Renders a field map as the JSON Schema draft-4 fragment Connect stores. */
export function jsonSchemaFor(schema: ModuleSchema): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [field, type] of Object.entries(schema)) {
    properties[field] = isFieldType(type) ? { type } : jsonSchemaFor(type);
  }
  return { type: "object", properties };
}

/**
 * Builds the `Settings` string that carries the contract on the resource.
 *
 * Lower camel case, unlike everything else on the wire, and `resultData` rather than the "output"
 * the console labels it — matching the caller-side `$.Modules.ResultData` it fills. A module with no
 * contract gets `"{}"`, which is what the console writes.
 */
export function moduleSettingsJson(contract: ModuleContract): string {
  const branches = contract.branches ?? [];
  if (branches.length > MAX_MODULE_BRANCHES) {
    throw new Error(
      `A flow module may declare at most ${MAX_MODULE_BRANCHES} branches, received ${branches.length}: ` +
        branches.join(", "),
    );
  }
  const duplicate = branches.find((b, i) => branches.indexOf(b) !== i);
  if (duplicate !== undefined) {
    throw new Error(`Flow module branch ${JSON.stringify(duplicate)} is declared twice.`);
  }

  return JSON.stringify({
    ...(contract.input === undefined ? {} : { input: { schema: jsonSchemaFor(contract.input) } }),
    ...(contract.output === undefined
      ? {}
      : { resultData: { schema: jsonSchemaFor(contract.output) } }),
    ...(branches.length === 0
      ? {}
      : { transitions: { results: branches.map((name) => ({ name, description: "" })) } }),
  });
}
