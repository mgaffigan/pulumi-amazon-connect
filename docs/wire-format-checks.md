# Wire-format checks

The emitted JSON has been verified three ways, in increasing order of authority:

1. Against the [AWS flow-language reference](https://docs.aws.amazon.com/connect/latest/devguide/flow-language-actions.html).
2. Against a real 118-action production flow, exported with `describe-contact-flow`.
3. Against the live `CreateContactFlow` API, which performs full server-side validation.

Where they disagreed, the service won — which happened often enough to be the main finding of this
document. Every correction below caused a rejection until it was fixed, and each is pinned by a test in
`test/conformance.test.ts`, `test/actions.test.ts`, or `test/advanced.test.ts`.

Three of them are wrong *action type names*, which no amount of care with parameters would have caught:
`UnTagContact` is really `UntagContact`, `UpdateRoutingCriteria` is really `UpdateContactRoutingCriteria`,
and `Wait` takes `TimeLimitSeconds` rather than the documented `TimeoutSeconds`.

To re-verify after changing the emitter:

```sh
# full server-side validation; a successful create means the JSON is accepted
aws connect create-contact-flow --instance-id <id> --name zz-check \
  --type CONTACT_FLOW --content file://flow.json --region us-east-1
aws connect delete-contact-flow --instance-id <id> --contact-flow-id <id>
```

Pass `--debug` and grep for `problems` — the CLI otherwise prints an empty error message and hides
the list of specific failures.

## Corrected against the live API

The reference documents each of these incorrectly. Every row was a rejection from
`CreateContactFlow`.

| Action | Reference says | Service requires |
| --- | --- | --- |
| `Wait` | `TimeoutSeconds` | **`TimeLimitSeconds`** — the documented name is rejected outright |
| `UpdateFlowAttributes` | "Errors: None" | must declare **`NoMatchingError`** |
| `UpdateFlowAttributes` | garbled parameter shape | `{ "<key>": { "Type": "String", "Value": "<v>" } }` |
| `GetParticipantInput` (store mode) | lists `InputTimeLimitExceeded` | must **not** declare it |
| `Loop` | conditions only | also requires a **`NextAction`** — Connect rejects any non-terminal action without one |
| `CheckMetricData` | `NoMatchingCondition` only for queue-depth metrics | required on the agent metrics too |
| `UpdatePreviousContactParticipantState` | — | values are `AgentOnHold`/`CustomerOnHold`/`OffHold`; there is no plain `OnHold` |
| `TransferParticipantToThirdParty` | `ContinueFlowExecution` reads optional | **required** |
| `UpdateContactRecordingAndAnalyticsBehavior` | one error list | `InFlightRedactionConfigurationFailed` is **chat only**; a voice action is rejected with it |
| `UnTagContact` (page title and body) | — | the action type is **`UntagContact`**, lower-case `t`; the documented spelling is rejected as an unknown action type |
| `UpdateContactTextToSpeechVoice` | parameter names only, and "Coversational" | styles are `None`/**`Conversational`**/`Newscaster`; engines are Polly's lower-case names (`standard`, `neural`, `long-form`, `generative`) |
| `UpdateRoutingCriteria` (page title) | — | the action type is **`UpdateContactRoutingCriteria`**; the documented name is rejected as unknown |
| `CheckVoiceId` results | "Not enrolled", "High risk", "Opted out" | those are display labels; the wire values have no spaces (`NotEnrolled`, `HighRisk`, `OptedOut`) |
| `UpdateContactData` | `References` for external references | rejected as an unknown property, as are the `Reference` the service names in its own error text and the undocumented `SegmentAttribute` |
| `UpdateContactData` | Voice ID fields all optional | the three switches must be set together, the three thresholds are **required** when on and **rejected** when off |
| `UpdateContactData` | fields all optional | at least one is required; an empty action is rejected |
| `UpdateContactMediaProcessing` | `ChatProcessorSettings` reads optional | **required** |
| `TransferParticipantToThirdParty` | — | `ThirdPartyPhoneNumber` and `CallerId.Number` are validated against numbers actually claimed on the instance |

Two of these became type-level guarantees rather than runtime checks:

- **`CheckMetricData` operators depend on the metric.** Agent counts accept only
  `NumberGreaterThan 0`; queue-depth metrics accept the full numeric range. Hence two functions —
  `checkStaffing` (no threshold parameter, because Connect has none) and `checkQueueMetric` — mirroring
  Connect's own "Check staffing" and "Check queue status" blocks.
- **`TransferParticipantToThirdParty` outcomes depend on `ContinueFlowExecution`.** Handing the call
  over (`false`) leaves no branch to take, and Connect rejects `CallFailed` /
  `ConnectionTimeLimitExceeded` on such an action. `ThirdPartyOptions` is a discriminated union, so
  those handlers only exist on the `true` variant.

`UpdateContactEventHooks` permits exactly one entry in its `EventHooks` map, so `setEventFlow` sets one
event per call.

### An empty string is never a valid parameter value

Rejected everywhere, in a flow and a module alike, and not specific to any action:

| Probe | Result |
| --- | --- |
| `ShowView` with `ViewData: { a: "" }` | **rejected** — `Invalid Action property value. Path: 0.Parameter` |
| `UpdateContactAttributes` with an empty attribute | **rejected** — `Empty value in Parameters.Attributes` |
| `MessageParticipant` with empty text | **rejected** — reads as no text supplied at all |
| the same values as `" "` | accepted, so this is emptiness rather than falsiness |

`findProblems` reports these against the authoring code, naming the action and the property path,
because the service's own message names neither — `Path: 0.Parameter` is the whole of it — and the
offending value is usually a variable that happened to be empty rather than a literal. The check walks
`Parameters` recursively, so an empty string nested inside `ViewData` is found too.

### …and never a valid condition operand either

The same rule reaches a `Condition`, which lives in `Transitions` rather than `Parameters` and so is
reported differently:

| Probe | Result |
| --- | --- |
| `Compare` against `Operands: [""]` | **rejected** — `Invalid branch. Path: 2.Evaluate` |
| the same operand as `" "` | accepted, same emptiness rule as above |

`Evaluate` is the block's console name and `2` its index in `Actions`; the message says nothing about
which branch or why. It is worth its own check because the remedy is different: there is no
comparison against blank in the flow language, so an empty operand is never a value to fill in.
Whatever produces the compared value has to return a sentinel — `"none"`, `"ok"` — and the flow
compares against that. A Lambda that returns `undefined` for a field is the usual way to arrive here,
since the key is dropped from the response entirely and the natural test for it is `== ""`.

## Completeness review

The corrections above came from things this library emitted being *rejected*. A separate pass asked the
opposite question — what does the service accept that the library does not emit? — by publishing
minimal probe flows containing one candidate at a time. Unknown property names come back as
`Invalid Action property name`, so the real parameter set can be enumerated directly.

**Confirmed absent, so the existing shapes are complete:**

- **There are no compound condition operators.** `And`, `Or`, `Not`, `All`, `Any`, `Contains` and
  `Exists` are all rejected as invalid operator values, and `Equals` rejects a second operand. The
  reference's claim that operands "may be Condition objects" nested "no more than five deep" describes
  a capability `Compare` does not have. The eight unary comparisons plus `KeyExists` are the whole set.
- **`ComparisonValue` must be a JSONPath with a leaf.** A bare namespace root (`$.External`) and a
  literal (`"gold"`) are both rejected; nested paths (`$.External.customer.tier`) are fine. This is why
  `flowIf` takes a `Ref` and never a literal on the left.
- **`CheckHoursOfOperation` has only `True`/`False`.** No override branches, no `CheckOverride`
  parameter.
- **`Wait` has only the two documented events.** `LambdaReturned` and `AsyncLambdaCompletion` are
  rejected.
- **No `LanguageCode` on `UpdateContactTextToSpeechVoice`**, and no `TextType` on `MessageParticipant`.
- **No `ThirdPartyCallerId`** on a third-party transfer.

**Confirmed present but missing from the library, now implemented:**

| Action | Undocumented capability |
| --- | --- |
| `Compare` | **`KeyExists`** operator, one operand — absent from the reference's operator table |
| `GetParticipantInput` | **`InputEncryption`** (documented, previously unimplemented); requires `CustomValidation`, rejected with phone-number validation |
| `MessageParticipant` | **`SkipWhenDTMFBufferEnabled`** — every console export carries it |
| `ConnectParticipantWithLexBot` | **`LexSessionAttributes`** |
| `UpdateContactRecordingBehavior` | **`AnalyticsBehavior`** — same action sets Contact Lens, in a different shape from `UpdateContactRecordingAndAnalyticsBehavior` |
| `InvokeLambdaFunction` | **`InvocationType: "ASYNCHRONOUS"`** — returns no refs, since nothing reaches `$.External` |
| `Wait` | **`ContinueExecution`** mode: requires `MinimumWaitTimeSeconds` and exactly a `Continue` and `WaitCompleted` branch. Absent from the reference entirely. Structure verified; **runtime semantics are not** |

Also corrected: **`ThirdPartyConnectionTimeLimitSeconds` is required**, though the reference marks it
optional. The type now requires it, so the omission is a compile error rather than a deploy failure.

### On recovering values the reference omits

Two of the rows above involve enum values the reference either does not list (Polly engines) or
misspells (`Coversational`). Those were narrowed down to candidate names, then **confirmed by
publishing** — `CreateContactFlow` accepting the action is the evidence, and it is the only evidence
this document treats as authoritative. Nothing is taken on the strength of a name appearing somewhere.

The same rule applies to the action-type spelling: `UntagContact` is recorded here because the service
accepts it and rejects `UnTagContact`, not because of where the spelling was first spotted.

The `UpdateFlowAttributes` shape had been an open question: the reference renders it with unbalanced
quotes and no published example resolves it. Connect's validator answered it by complaining about a
missing `Value`.

The store-mode `GetParticipantInput` finding is why `collectInput` has no `onTimeout` option and
`getDigit` does — the two modes genuinely differ, and the type now reflects that.

## Source corpus

Shapes were recovered from **60 flows across two Connect instances** — every contact flow and flow
module in a production instance and a sandbox one, including AWS's own sample flows. That corpus is
what the action coverage was chosen from: types were implemented in order of how many real flows use
them.

The 118-action flow below is the largest single one, and this library's `findProblems` passes it with
zero problems. It covers `UpdateContactAttributes` (52), `Compare` (21), `InvokeLambdaFunction` (17),
`ShowView` (17), `MessageParticipant` (7), and `DisconnectParticipant` (4).

Downloading the corpus again:

```sh
aws connect list-contact-flows --instance-id <id> --query 'ContactFlowSummaryList[].[Id,ContactFlowType,Name]' --output text
aws connect describe-contact-flow --instance-id <id> --contact-flow-id <id> --query ContactFlow.Content --output text
```

Flow content from a production instance carries real ARNs, account ids, and prompt text, so it is kept
out of this repo — the tests encode the structural findings with synthetic values instead.

## Confirmed against a real console export

- **Every scalar in `Parameters` is a string.** Not one non-string scalar appears in the export;
  timeouts and counts are quoted. This caught a real defect — `showView` emitted
  `InvocationTimeLimitSeconds` as a number.
- **`Compare`'s else branch.** The console emits `NextAction` *and* an `Errors[NoMatchingCondition]`
  entry, both naming the same identifier — exactly what this library emits. Several conditions may
  also share one `NextAction`.
- **`ShowView.ViewResource` carries only `Id`.** The version is a qualifier on the ARN
  (`.../view/<id>:$LATEST`), not the separate `Version` field the reference shows. `ViewData` is
  always present, `{}` when empty.
- **`ShowView` declares three outcomes**: `NoMatchingCondition`, `NoMatchingError`,
  `TimeLimitExceeded`.
- **`InvokeLambdaFunction` carries `InvocationType: "SYNCHRONOUS"`**, which the reference lists as
  optional but the console always emits.
- **Layout metadata is lower camel case**: `entryPointPosition` and `position`, not the capitalized
  forms in the reference's example. Console exports also carry `isFriendlyName` per action. Since
  the console is what reads this data, capitalized keys would leave every block stacked at the
  origin.
- **`UpdateContactAttributes`** is exactly `{ Attributes, TargetContact }`.
- **Terminal actions** carry `Parameters: {}` and `Transitions: {}`.
- **`$.Views.ViewResultData.<field>`** is how a flow reads a view submission, including positional
  table cells (`.PatientTable.0.pat_id`). Exposed as the typed reference tree returned by
  `ConnectView.show()`. The field name is the component's `Name`, which is why `defineView`
  derives those names from the declared output type.
- **The action the participant chose is reported twice.** `ShowView` branches on it —
  `Conditions[].Condition.Operands: ["Back"]` with no `ComparisonValue`, unlike every other
  conditional action, confirmed from a console-exported flow with 17 `ShowView` actions — *and* it is
  readable as `$.Views.Action`. 
- **`MessageParticipant` carries `SkipWhenDTMFBufferEnabled: "false"`** in console exports. Not in
  the reference and not required, so this library omits it.

## Flow-type constraints

Which actions are legal depends on the flow type, and two of these bite the emitter rather than the
author:

- **Whisper and hold flows reject `DisconnectParticipant`.** A branch that runs off the end still
  needs a real target, so the synthesized terminal has to be `EndFlowExecution` there. `ContactFlow`
  picks it from the flow type; `recordFlow` takes an `endWith` option.
- **`EndFlowExecution` is only valid in whisper and queue flows**, so it cannot be the default.
- **`CompleteOutboundCall` is rejected in `CONTACT_FLOW`** — it belongs in an outbound whisper flow,
  before the number is dialled.
- **A third-party transfer's failure outcomes are rejected in an agent transfer flow**, though the
  same action accepts them in an inbound flow.

## Deployment findings

- **Associating a Lambda is sufficient; a separate permission is not needed.**
  `AssociateLambdaFunction` adds its own `lambda:InvokeFunction` statement to the function's resource
  policy, with `Sid: connect-<instanceId>` and a source condition scoped to the instance ARN.
  `ContactFlow` originally created an explicit `aws.lambda.Permission` as well; it was pure
  duplication. Verified by deleting it and confirming the association's statement remained.
- **A flow published from this library round-trips byte-identically.** Every action came back from
  `describe-contact-flow` with the same `Parameters` and `Transitions` that were sent.

## Confirmed against the reference only

Not yet exercised end to end, but unambiguous in the docs:

- **`TransferContactToQueue` takes no parameters.** The queue comes from the contact's target queue,
  set separately by `UpdateContactTargetQueue`. This is why `transferToQueue({ queue })` emits *two*
  actions.
- **`GetParticipantInput` branch mode** permits only `Equals` against a single character.
- **`InvokeLambdaFunction` timeout is 1-8 seconds**, enforced by the `InvocationTimeout` type.

## Flow modules

Module content goes to `CreateContactFlowModule`, which validates against a **different schema** than
`CreateContactFlow` — the first thing it checks is a field the flow API has never heard of:

```
InvalidRequestException: JSON field is missing or null for field name: settings
```

- **A module's content requires a top-level `Settings` object**: `{ InputParameters,
  OutputParameters, Transitions }`. A flow's content must not have one. The emitter keys this off the
  terminal action, which is the same thing that already distinguishes the two resources.
- **The module attribute namespace is `$.Modules`** (plural), per the [attribute
  list](https://docs.aws.amazon.com/connect/latest/adminguide/connect-attrib-list.html): `$.Modules.Input`
  is the input object *inside* the module, and in the caller `$.Modules.Result` is the branch name the
  module returned (a string) and `$.Modules.ResultData` is the output object. All three are overwritten
  by each invocation and are absent from contact records.

### The contract is not in the content

Recovered from two console-built modules — one declaring an input, an output and two custom branches,
one declaring nothing — plus the flow that invokes both.

**The content-level `Settings` block is boilerplate.** Both modules carry it byte-identically:
empty `InputParameters`, empty `OutputParameters`, and a fixed pair
`{ "DisplayName": "Success", "ReferenceName": "Success", "Description": "" }` / the same for `Error`.
The module with `branch_1` and `branch_2` does *not* mention them here. So these names promise a
contract the field does not carry, and the emitter simply reproduces what the console writes.

**The real contract is a `Settings` string on the resource**, lower camel case, JSON Schema draft-4
inside, alongside a separate `ExternalInvocationConfiguration` for module-as-tool:

```json
{
  "input":       { "schema": { "type": "object", "properties": { "new_property_0": { "type": "string" } } } },
  "resultData":  { "schema": { "type": "object", "properties": { "new_property_0": { "type": "string" } } } },
  "transitions": { "results": [ { "name": "branch_1", "description": "" }, { "name": "branch_2", "description": "" } ] }
}
```

A module with no contract has `Settings: "{}"`. Note `resultData`, matching the caller-side
`$.Modules.ResultData` rather than the "output" the console labels it.

**This is why the provider has to change.** `CreateContactFlowModule` takes `Settings` and
`ExternalInvocationConfiguration` as top-level API parameters, and the classic `aws` provider's
`ContactFlowModule` exposes neither — it has only `content`, `name`, `description` and `tags`. The
`aws-native` resource has `settings`, `externalInvocationConfiguration`, and sibling
`ContactFlowModuleVersion` and `ContactFlowModuleAlias` resources. Same reason `ConnectView` already
reaches for `aws-native`: the classic provider cannot express the resource.

**Call site.** `InvokeFlowModule` carries the input as a flat object of strings under `Input`,
present only when there is one, and takes a custom branch as an ordinary `Conditions` entry —
`Equals` against the branch name, operand only, exactly as `ShowView` reports the action the
participant chose. `NoMatchingCondition` and `NoMatchingError` are declared either way:

```json
{
  "Type": "InvokeFlowModule",
  "Parameters": {
    "FlowModuleId": "cdf9ab66-…:$LATEST",
    "Input": { "new_property_0": "input 1", "new_property_1": "input 2" }
  },
  "Transitions": {
    "NextAction": "…",
    "Conditions": [ { "NextAction": "…", "Condition": { "Operator": "Equals", "Operands": ["branch_1"] } } ],
    "Errors": [ { "NextAction": "…", "ErrorType": "NoMatchingCondition" }, { "NextAction": "…", "ErrorType": "NoMatchingError" } ]
  }
}
```

**Return.** `EndFlowModuleExecution` carries the output as a flat object of strings under
`ResultData`, and `Parameters: {}` when there is none.

**The branch a return selects is `Result`.** Recovered by publishing one candidate at a time:
`Transition`, `TransitionName`, `ReferenceName`, `Branch`, `BranchName`, `ResultName`, `Name`,
`Results` and `Output` are all rejected, `Result` alone is accepted. It sits beside `ResultData`, and
the two are independent — either, both, or neither.

### What the service validates

Both halves of the contract are enforced at publish time, on both sides, which is worth knowing
because it means a mistake is a deploy failure rather than a runtime surprise:

| Probe | Result |
| --- | --- |
| `Result` naming a declared branch | accepted |
| `Result` naming an undeclared branch | **rejected** |
| `Result` on a module whose `Settings` is `{}` | **rejected** — there is no implicit branch |
| `Result: "Success"`, the name in the content block | **rejected** — confirming that block is inert |
| `Result` omitted though branches are declared | accepted — selecting one is optional |
| `ResultData` key present in `resultData.schema` | accepted |
| `ResultData` key absent from the schema | **rejected** |
| `ResultData: {}` against a schema with properties | accepted — properties are optional unless `required` |
| `ResultData` with no schema declared at all | **rejected** |
| caller `Input` key declared in `input.schema` | accepted |
| caller `Input` key not in the schema | **rejected**, by `CreateContactFlow` |
| caller `Input` omitted entirely | accepted |
| caller condition on an undeclared branch name | **rejected**, by `CreateContactFlow` |

So `CreateContactFlow` validates the call site against the *module's* declared contract — a
cross-resource check, and the reason authoring both halves in one program can catch these at compile
time instead.

**A declared type governs the JSON type, which is the one place the all-strings rule does not hold.**
Everywhere else in a flow, every scalar in `Parameters` is a string. Under a `{"type":"number"}`
schema, `{"n": 7}` is accepted and `{"n": "7"}` is **rejected**. Values in `Input` and `ResultData`
are therefore emitted in their declared JSON type, not stringified.

**A JSONPath reference is only legal where the declared type is `string`.** A reference is a string on
the wire, so the schema validator sees one: `"$.Attributes.count"` is accepted against
`{"type":"string"}` and rejected against `{"type":"number"}` or `{"type":"boolean"}`. There is
therefore no way to pass a dynamic value into a non-string field, which is why `ModuleInput` admits a
`Ref` only on string fields — a compile error rather than a deploy failure. Nested objects are
accepted.

Two smaller findings from the same round:

- **A module's `Status` is lower-case `published`**, where a contact flow's is `PUBLISHED`.
- **`aws-native` reports only `contactFlowModuleArn`**, no separate id output, and `InvokeFlowModule`
  wants the bare id — so the id is the ARN's last segment.

All of the above is now emitted and verified end to end: `test/e2e/publish.e2e.test.ts` publishes a
module declaring an input, an output and two branches, then publishes a flow that invokes it — which
is the only way to know the two halves agree, since the service checks them against each other.

## Views

View content is validated far more strictly than flow content: `CreateView` with
`Status: PUBLISHED` runs the template through AJV and returns structured errors, including
`additionalProperties` violations naming the offending property. That made the component library
recoverable rather than guessable — throw a candidate prop set at a component and the response names
every one it does not accept.

Findings, each confirmed by publishing:

- **`Head.Configuration` is required**, even as an empty object.
- **`Button` has no `Label`** — the label is its content. `SubmitButton` does take one, and requires it.
- **`TextBox` has no `Text` property.** The text is the component's content. This one the service cannot
  catch: the component schema does not seal `Props`, so a `Text` property is accepted and silently
  dropped, and the view renders empty. Found only by reading the published component schema.
- **Several components take lower-case properties** — `Header` (`variant`, `description`), `Alert`
  (`type`, `level`, `heading`, `dismissible`), and `Container` (`header`, `footer`) — while most take
  PascalCase. A prop sieve reports "nothing accepted" for these, because every candidate was tried in
  the wrong casing.
- **`Card` requires `Id`.**
- **A `$.` reference declares an input only when it is an entire value** — of a property, or of one item
  of a component's content. Embedded in a longer string it declares nothing and renders literally, which
  would show `$.CustomerName` to a customer. Confirmed both ways: whole-value references appear in the
  derived `InputSchema` as required inputs, the embedded form yields an empty schema.
- **Interpolation is a content list.** `["Hello ", "$.CustomerName"]` renders as one sentence *and*
  declares the input; the same text as a single string does neither. `defineView` rejects the embedded
  form and points at the list.
- **`$.#Name` is an integration reference**, not an input, and must be declared in the view's `Head`
  ("integrations used in the view body are not included in the view head").
- **`InputSchema` is derived, not supplied.** `CreateView` accepts only `{ Actions, Template }` and
  computes the schema, so reading it back is how you confirm a view's inputs are what you meant.
- **Icon and glyph names are closed enums**, validated on publish — a typo is a deploy-time rejection
  rather than a blank space. Same for `FontSize`, `FontWeight`, `TextAlign`, `Variant`, `InputType`,
  `ColumnWidth`, `LinkType` and button spacing.
- **A bare `$.X` on `TextBox.Text` returns `InternalServiceException`** rather than a validation error.
  Data references belong on the data components (`AttributeBar`, `AttributeSection`, `Table`).

### Mutating a deployed view

`AlreadyExists` on a `pulumi up` reads like a broken update, so this was checked against the real
service both ways — Cloud Control (the path `ConnectView` takes through `aws-native`) and the Connect
API directly.

- **Every edit to a view is an in-place update.** `AWS::Connect::View` declares no
  `createOnlyProperties`, so Cloud Control patches `Template`, `Actions`, `Description` *and* `Name`
  on the live resource; `UpdateViewContent` and `UpdateViewMetadata` keep the id and the ARN, which is
  what lets a flow go on referencing the view. A `pulumi up` over a changed `defineView` reports
  `~ updated [diff: ~actions,description,template]` and re-running it is a no-op, so the emitted
  template round-trips without drift.
- **`AlreadyExists` is only ever raised by a create.** The service rejects a *second* view claiming a
  live view's name — `DuplicateResourceException: View name already exists for the instance`, which
  Cloud Control surfaces as `operation CREATE failed with "AlreadyExists"`. Since a view's name
  defaults to the Pulumi resource name and nothing auto-names it, anything that makes Pulumi *create*
  rather than update collides: renaming the resource or moving it under a different parent (the new
  resource is created before the old one is deleted), two stacks deploying to one instance, or an
  orphan left in the instance by an interrupted `up` — recover that one with `pulumi import`, or
  delete the view and let Pulumi create it again.
- **A name is reserved only while the view lives.** `DeleteView` frees it immediately, with no
  soft-delete window, for both `SAVED` and `PUBLISHED` views — so a destroy/up cycle, or a rerun of
  the end-to-end suite, can reuse a name.

`test/e2e/views.e2e.test.ts` holds all three as one test: update, rename, duplicate-name rejection,
then delete and recreate under the freed name.

### Recovered from the AWS-managed views

A separate pass took the six views Connect ships in every instance and asked whether this library could
emit them (`test/awsManagedViews.test.ts` reproduces After Contact Work and compares the result to
`describe-view`). Each row below was a genuine gap. Two sources settled them: the templates and derived
input schemas the service returns for its own views, and the schema generators in the
[component library](https://d3irlmavjxd3d8.cloudfront.net/)'s shipped bundle, which are the same
functions the validator runs.

- **`Configuration` is a sibling of `Props`, not one of them**, and it is on the *base* component
  definition — `{ Layout: { Columns, Align }, Style }`, `additionalProperties: false` — so every
  component takes one, and `Head.Configuration` is the same definition. AWS's After Contact Work view
  puts `{ Layout: { Align: "right" } }` on its `Form` and `{ Align: "left", Columns: "12" }` on each
  `Section`; there was previously no way to emit either.
- **`Configuration.Style` takes component custom properties, not CSS.** The generator in the bundle is
  `Style = w({ oneOf: [ { type: "object", patternProperties: { "^--[a-z0-9\-]+$": { type: "string" } },
  additionalProperties: false }, { type: "string" } ] })`, with `w` adding the usual reference branch.
  So the keys are lower-case, digits and hyphens after `--`, and they are *named tokens the component's
  own CSS reads* — `padding-top: var(--container-padding-top, …)`, `color: var(--textbox-color)`. There
  is no generic styling here: `{ padding: "0" }` is rejected, and setting a container's padding means
  `--container-padding-top`/`-right`/`-bottom`/`-left`. Connect's view designer emits exactly this and
  never the string branch; treat the bare-string branch as dead — it validates and nothing consumes it.
  Enforced by `checkStyle` rather than the type, since `^--[a-z0-9\-]+$` is not a template literal type.
  Worth enforcing: the service rejects a bad key with `InvalidParameterException`, and
  `AWS::Connect::View`'s CloudFormation handler retries that on a ~60s loop instead of failing, so the
  only symptom is `pulumi up` sitting on `creating (108s)` with nothing in the log. Read the real error
  with `aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=CreateView`.
- **`Dropdown.DefaultValue` is an array**, `{ type: "array" }` in the schema, regardless of
  `MultiSelect`. The scalar this library emitted was invalid, and AWS's own view emits a one-element
  array. It comes back as an array too: the sample flow reads
  `$.Views.ViewResultData.Category.0`.
- **A `ButtonGroup` item is a whole `Button`** — `Label` plus the full button prop set — plus
  `FormAction: "submit" | "none"`, defaulting to `"none"`. That is the entire submit mechanism of the
  After Contact Work view, which has no `SubmitButton` in it.
- **Boolean props accept `boolean`, `"true"`/`"false"`, or a reference** — every one is that same
  `anyOf`. So the stringified form this library used to emit was valid, but AWS's own views emit real
  booleans and `Required` was already unstringified, so the library now emits booleans throughout.
- **An AWS-managed view is referenced by a bare version number**, not a `$`-prefixed one:
  `arn:aws:connect:us-east-1:aws:view/after-contact-work:1`, from AWS's own sample flow, against
  `:$LATEST` for a customer-managed view. `showView` was prefixing every version, producing `:$1`.
- **`ShowView.ViewData` carries structured data, not only scalars.** An AWS-managed view's entire
  content arrives this way — the Cards view's `Cards` is a list of objects with a nested `Detail` — and
  the emitter was stringifying each value, so anything but a scalar became `"[object Object]"`.
  Top-level scalars are still quoted, as every console-exported parameter is; nested values keep their
  JSON types, which is how the views' own input schemas and AWS's documented input examples are written.
- **A field's schema has no `Disabled`**, and it is sealed: `{ Label, Name, DefaultValue, HelperText,
  Required }`, with `Label` and `Name` both required. This library emits a `Disabled` for every field
  type and marks `label` optional, neither of which the schema allows. Not yet changed — no published
  probe has been run against it, and it is a breaking type change.
- **`SubmitButton`'s `Props` are not sealed**, unlike `Button`'s, and `TextArea` also takes a
  `MaxLength`.

### Recovered from the Table's derived input schema

`Table` is the one component the validator does not know: its `Props` are not sealed and a literal
`Columns` list is accepted whatever it contains, so publishing proves nothing about it. Nor does the
component library's bundled validator help — the copy it ships predates the component and has no
`Table` in its enums at all, so the docs site's own "Schema" tab for it is empty.

What does know the shape is the *input-schema derivation*. Point a property at a reference and Connect
writes out the schema of what that reference must contain, and rejects a reference on a property it does
not know. So `Columns: "$.Cols"`, `Actions: "$.Acts"` and the rest recover the whole component, and
`test/e2e/views.e2e.test.ts` pins it that way.

- **A column is `{ Label, Id, Type, EditableType, Options }`**, sealed, with **`Label` and `Id` both
  required** — and the heading is `Label`. This library emitted `Header`, which the *renderer* ignores:
  a column headed that way publishes cleanly and renders blank. `Type` is `"text" | "number" |
  "action"`, `EditableType` is `"input" | "select"`, and `Options` is required exactly when
  `EditableType` is `"select"` (an `if`/`then` in the schema).
- **`Table.Actions` is a `ButtonGroup`'s items**, not the `{ Label, Action }` pair this library emitted:
  the same sealed set of `Label`, `Action`, `Variant`, `FormAction`, `IconName`, `IconAlign`, `Href`,
  `Disabled` and `Loading`, defaulting to `Variant: "normal"`, `FormAction: "none"`,
  `IconAlign: "left"`. The component renders them by handing them to a `ButtonGroup`, which is why
  `<GroupButton>` serves both.
- **`TableAction` is the per-row branch**, a property rather than an item — the action a cell in a
  `Type: "action"` column raises, carrying that row as the submitted data. It was missing entirely.
  Absent, the component raises the literal name `"TableAction"`, so this library requires it once a
  column is an action column and `defineView` collects it like any other action name.
- **A row may carry `_Configuration: { EditableDisabled: [...] }`** alongside its values — sealed, and
  `EditableDisabled` required within it — naming the columns that row will not let the agent edit.
- **`Description` and `ItemsPerPage` are real properties**, and `Variant` on a button accepts `"link"`
  as well as `"primary"` and `"normal"`.

The one property whose reference is *not* accepted is an unknown one: `Zzz: "$.Bogus"` fails where
`Zzz: "x"` publishes cleanly. That asymmetry is what makes the derivation usable as a prop sieve.

The five composite components are not exposed as components. Their properties are all references in the
views AWS publishes, so a template built around one would be a copy of a view that already exists —
they are reached through `awsCardsView` and friends instead, which declare the input and output types.
The published reference and the service disagree about the Form view in two places: the reference's
input example uses `Type: "TimeInput"` and its output example a `Submit` action, where the schema has
`TimePicker` and the resource's `Actions` are `Back`, `Next` and `Step`.

### The top level of a body is validated strictly

A node at the top level of `Template.Body` may not hold other components unless it is a container. The
same nesting one level down is accepted:

| Template | Result |
| --- | --- |
| `Body: [Button, Content: ["Go"]]` | accepted |
| `Body: [Button, Content: [TextBox]]` | rejected — `Content/items must be string`, `must be number`, … |
| `Body: [Container, Content: [Button, Content: [TextBox]]]` | accepted |

Every AWS-managed view's body is a single container, which is why this is easy to miss. `defineView`
rejects a top-level non-container holding elements and names the fix.

Note also what the accepted first row means for JSX: `<Button>Go</Button>` puts the bare string `"Go"` in
`Content`, and that is valid everywhere — so the JSX form is the one that always works, while
`Button({}, [TextBox("Go")])` only works nested.

### The Lambda invocation payload

Confirmed by invoking a deployed function with a captured payload, not by reading the reference:

- **A handler receives a `ContactFlowEvent` envelope**, never its parameters alone:
  `{ Details: { ContactData, Parameters }, Name: "ContactFlowEvent" }`. It is passed through untouched
  and typed, so `Details.Parameters` carries the call site's input type.
- **`CustomerEndpoint`, `SystemEndpoint`, `CustomerId` and `Queue` can be `null`.** The reference only
  ever shows them populated; a chat contact created through the API sends all four as null.
- **`ContactData` carries fields the reference omits**: `AwsRegion`, `RelatedContactId`,
  `SegmentAttributes`, `Tags`, `Description`, `LanguageCode`, and a contact-level `Name` distinct from
  the event's.
- **`InitiationMethod` is not limited to the four documented values** — a Guide contact arrives as
  `"API"` — so the type stays open.
- **The documented restriction that `STRING_MAP` values contain "only alphanumeric, dash, and
  underscore characters" is contradicted by AWS's own example** on the same page, which returns
  `"$1000"` and a URL. Not enforced here.

### Why both sources are needed

The [component library docs](https://d3irlmavjxd3d8.cloudfront.net/) publish a complete JSON Schema per
component. That is the authority on what a component *renders*, and it is the only way to catch a
property the service accepts and ignores — `TextBox.Text` being the clearest case, since the schema does
not seal `Props`.

The service is the authority on what a given instance *accepts*, and the two do disagree: `Container`
documents `header`/`footer`, the service also takes `HideBorder`; `Button`'s documented variants are
`primary|normal`, the service's enum also includes `link`. Where they differ, this library follows
whichever is narrower and says so in the type's doc comment.

The docs are also the fastest way to recover a prop set without publishing anything: the storybook's
preview bundle contains the schema *generators*, so
`curl -s https://d3irlmavjxd3d8.cloudfront.net/iframe.html` and then grepping the referenced
`*.iframe.bundle.js` for a component name yields the JSON Schema the validator applies, sealing and all.
That is where the base `Configuration` definition and the `ButtonGroup` item shape above came from.

Components still unexposed — `ExpandableSection`, `HTMLBox` and `Detail` — have documented schemas but
have not been worked through.
