# Flows

A flow is an ordinary function. This is the reference for authoring one; see the
[README](../README.md) to get started.

## How it works

Running the flow function under a recorder turns the calls it makes into a
block tree, which is linearized into flow-language actions. There is no interpreter and no
restricted subset of the language: normal Node execution and module resolution apply, and whatever
the program calls — including code from an imported package — records into the flow being built.

The recorder is ambient, which is what makes fragments composable. A fragment does not receive a
context object, does not register itself, and does not need to be in the same file as the flow.

### Recording is synchronous

A flow describes a graph rather than running one, so nothing is awaited: actions, `flowIf`, `onError`
and `new ContactFlow` are all synchronous. That is not only tidier — a forgotten `await` on a branch
would have recorded its actions in the wrong order and produced a valid-looking flow that was quietly
wrong, and that failure no longer exists.

Anything genuinely asynchronous happens *before* the flow, and the flow closes over the result:

```ts
const queue = await aws.connect.getQueue({ instanceId, name: "main" });

new ContactFlow("inbound", {
  instanceId,
  flow: () => transferToQueue({ queue: queue.arn }),
  onError: apologizeAndHangUp,
});
```

A Pulumi `Output` needs no await at all — pass it straight in, and it is substituted at deploy time.

TypeScript cannot help here: a `() => Promise<void>` is assignable wherever `() => void` is expected,
so an `async` fragment compiles cleanly. Both ways it can fail are therefore checked at runtime and
throw with an explanation — one when the fragment is handed to the recorder, and one when a dropped
promise resumes and tries to record into a flow that has already finished.

## Composition

A reusable fragment is just an exported function. It can take parameters and return refs:

```ts
// @acme/connect-patterns
import { play, collectInput, setAttributes, attr, withScope, type Ref } from "pulumi-amazon-connect";

export function authenticateCaller(): Ref<string> {
  return withScope("auth", () => {
    const entered = collectInput({
      text: "Enter your account number.",
      timeoutSeconds: 10,
      maxLength: 8,
    });
    setAttributes({ accountNumber: entered });
    return attr<string>("accountNumber");
  });
}
```

`withScope` names the subtree. Identifiers are derived from the structural path through the block
tree rather than from source location, so the same fragment used twice produces two distinct, stable
subtrees, and inserting an action above a scope does not renumber everything inside it.

Fragment libraries can test their own output without a flow or a Pulumi program:

```ts
import { recordFragment } from "pulumi-amazon-connect/testing";

const emitted = recordFragment(() => authenticateCaller());
expect(emitted.Actions.map((a) => a.Type)).toContain("GetParticipantInput");
```

## Errors

Amazon Connect puts two different things in one `Errors` array, and this library separates them.

**Expected outcomes are named parameters.** A timeout or a no-match is a branch of normal operation,
so it belongs to the action, and only appears on actions that actually have it:

```ts
getDigit({
  text: "Press 1 for sales, 2 for support.",
  timeoutSeconds: 5,
  options: { "1": toSales, "2": toSupport },
  onTimeout: () => play("Sorry, I didn't hear anything."),
  onNoMatch: retryMenu,
});
```

**The generic error vertex is a lexical scope**, because one "something went wrong" handler usually
covers a run of actions:

```ts
onError(() => {
  const customer = lookupCustomer({ phone: system.customerEndpoint.address });
  setAttributes({ tier: customer.tier });
}, apologizeAndTransfer);
```

Scopes nest and the innermost wins. A named outcome you leave out falls through to the enclosing
handler, so the emitted JSON always satisfies Connect's "must be defined" rules.

Every flow needs a root `onError`. It is a required parameter rather than a silent default, because
a default would hide a failure until a live contact hit it. Inside the outermost handler there is
nothing left above, so an error there ends the flow — the only remaining destination.

## Jumping

`label` and `goto` create edges a top-to-bottom read does not have. The flow language is a graph, and
some graphs are not a straight line — a retry that re-enters a menu, an error path that resumes mid-flow:

```ts
const menu = label("menu");
getDigit({
  text: "Press 1 to continue, or 2 to hear this again.",
  timeoutSeconds: 5,
  options: { "1": () => goto(done), "2": () => goto(menu) },
  onNoMatch: () => goto(menu),
});
```

A label is an object, not a name. There is nothing to collide, so a fragment that uses one composes
like any other and two copies of it hold two distinct labels.

Declaring a label places it, so a backward jump needs nothing but the declaration. A forward jump names
a label that has to exist before the jump, so declare it above and `here()` where it should land:

```ts
const done = label("done");
flowIf(cond, { ifTrue: () => goto(done) });
play("Only for the other branch.");
done.here();
```

`here()` moves the label rather than adding a second target, and returns it, so `label("menu").here()`
still reads as one step.

The jump is also a method on the label — `done.goto()` is `goto(done)`, and reads better where the
label is already in hand.

**`goto` is a real `throw` of the label.** That is not a trick — it is what makes "execution ceases
here" true rather than merely documented. The recorder catches the label as the end of that block, and
`goto` is typed `never`, so TypeScript reports the statements below a jump as unreachable (turn on
`allowUnreachableCode: false` to make that an error). A construct that recorded a marker and returned
would leave those statements running and contributing nothing.

Two consequences follow from the throw:

- A jump inside a branch unwinds only to that branch, which is exactly the edge you want: the branch
  ends at the jump and everything outside it carries on.
- An *unconditional* jump ends the block it is in, so it cannot reach a `here()` written below it.
  That case is not worth expressing anyway — everything between an unconditional jump and its label is
  dead code you would delete. Forward jumps are conditional by nature.

A label emits no action and costs nothing against the 250-action budget: it names whatever action
follows it. Jumps are resolved once the whole flow is emitted, so a label moved later still works, and
a label belonging to some other recording fails there rather than leaving a dangling transition.

Reach for `flowIf`, `flowSwitch` and `flowLoop` first — they keep the flow readable. This is here for
the cases they cannot express.

## Reading runtime values

A flow has no values, only references to values that will exist when a contact runs. A `Ref<T>` is a
handle on a JSONPath, it interpolates into any string parameter, and its type parameter is what lets
`flowIf` reject a text operator on a numeric ref.

Where a value comes from decides how you reach it:

| Source | How to read it |
| --- | --- |
| Contact and flow attributes | `attr("tier")`, `flowAttr("card")` |
| Segment attributes | `system.segment.subtype`, or `segmentAttr("yourKey")` |
| Ambient contact values | `system.…` |
| A Lambda's response | the refs returned by calling its handle; `external("key")` untyped |
| A view's result | the refs returned by `showView` / `connectView` |
| Real-time metrics | `makeRef("$.Metrics.…")`, deliberately unwrapped — see `getMetricData` |

`system` covers the [documented attribute
list](https://docs.aws.amazon.com/connect/latest/adminguide/connect-attrib-list.html) for everything
Connect populates on the contact rather than through a block:

```ts
system.contactId, system.channel, system.initiationMethod, system.awsRegion, system.languageCode
system.customerEndpoint.address        // and .type, .displayName; same for systemEndpoint
system.queue.name                      // and .arn, .outboundCallerId.address / .type
system.task.contactId                  // TASK channel; .name and .description read $.Name / $.Description
system.agent.userName                  // whisper, hold and transfer-to-agent flows only
system.capabilities.customer.video     // in-app, web and video contacts
system.media.sip.callingPartyAddress   // carrier metadata; any header can arrive empty
system.media.initialMessage            // the first message on a web chat or SMS
system.mediaStreams.customer.audio.streamArn   // after startMediaStreaming
system.lex.intentConfidenceScore       // after a Lex block; also .slot(name), .sentiment.scores.*
system.wisdom.sessionArn               // after createWisdomSession
system.segment.emailSubject            // bracketed: $.SegmentAttributes['connect:EmailSubject']
system.reference("caseUrl").value      // $.References.caseUrl.Value
system.tags                            // object-valued, so `keyExists` works on it
```

Groups that depend on context say so in their doc comment, because reading one where it is not
populated is empty at runtime rather than an error at deploy. Namespaces no action here fills yet —
`$.Customer` (Customer Profiles), `$.Case`, `$.DataTables`, `$.Email`, `$.Loop` — are absent on
purpose; reach them with `makeRef` once you have confirmed the path.

## Referring to other resources

Anything that names another deployed resource — a queue, a peer flow, a view, a flow module, hours of
operation — takes a `ResourceRef`, which is a literal, a contact attribute, a Pulumi input, or a
resource that has an `arn`:

```ts
const queueFlow = new ContactFlow("queue-flow", { instanceId, type: "CUSTOMER_QUEUE", ... });
const salesQueue = new aws.connect.Queue("sales", { ... });

new ContactFlow("inbound", {
  instanceId,
  flow: () => {
    setEventFlow("CustomerQueue", queueFlow.arn);   // an output
    transferToQueue({ queue: salesQueue });         // or the resource itself
  },
  onError: apologizeAndHangUp,
});
```

A peer flow's ARN does not exist while the flow is being recorded, so the emitted JSON holds a deferred
token and `ContactFlow` substitutes the real value once Pulumi resolves it — the same mechanism a
Lambda's ARN has always used. Confirmed against a deployed pair: the published flow carries the peer's
real ARN.

## Lambdas

```ts
const lookupCaller = connectLambda("lookupCaller", {
  timeoutSeconds: 5,
  handler: async (event: ContactFlowEvent<{ phone: string }>): Promise<{ tier: string }> => {
    const { Parameters, ContactData } = event.Details;
    return { tier: (await crm.isVip(Parameters.phone, ContactData.ContactId)) ? "gold" : "standard" };
  },
});

// inside a flow
const caller = lookupCaller({ phone: system.customerEndpoint.address });
setAttributes({ tier: caller.tier });   // caller.tier is Ref<string> -> $.External.tier
```

The handler is a real Lambda handler and nothing wraps it: what Connect sends is what it gets, and
`context` is Lambda's own. Connect invokes with a `ContactFlowEvent`, in which the parameters the flow
passed are only a small part:

```
{ Details: { ContactData: { Attributes, Channel, ContactId, Queue, CustomerEndpoint, ... },
             Parameters: { ...what the call site passed } },
  Name: "ContactFlowEvent" }
```

All this library does is type it — `Details.Parameters` takes the input type from the call, and the
contact block is fully typed — so the shape is visible rather than reduced to whichever fields a
convenience signature happened to expose. The types are pinned against a real captured payload in
[test/lambdaEvent.test.ts](../test/lambdaEvent.test.ts); previously they claimed the handler received
the parameters alone, which type-checked, deployed and previewed cleanly and then handed the handler
the wrong object at contact time.

Constraints the service imposes, all from the
[reference](https://docs.aws.amazon.com/connect/latest/adminguide/connect-lambda-functions.html):

- **`STRING_MAP` means a flat map of strings** — the default, and the return type is constrained to it.
  Use `responseType: "JSON"` for anything nested.
- **A flow cannot reference an array**, whatever the response type. Return an index or a joined string.
- **The response must be under 32 KB**, and the invocation under 8 seconds. Connect retries a failed
  invocation up to 3 times within that budget before taking the error branch.
- **A chain of Lambdas is capped at 20 seconds total.** AWS suggests a prompt between them, since the
  customer hears silence.
- **`$.External` holds only the most recent** Lambda's response. Store anything you need later with
  `setAttributes` before invoking another — reading a stale reference is rejected, as below.

## Results that a later action overwrites

Three places in the contact's run data hold one action's result at a time, and the next action of the
same kind replaces what is there: `$.External` (a Lambda invocation), `$.Views.ViewResultData` (a view)
and `$.StoredCustomerInput` (`collectInput`). The references handed back keep pointing at the same
paths, so without a check they would quietly start reading the newer action's values:

```ts
const caller = lookupCaller({ phone: system.customerEndpoint.address });
const account = lookupAccount({ id: attr("account") });
setAttributes({ tier: caller.tier });   // throws: $.External is lookupAccount's now
```

That is rejected while the flow is being built, wherever the reference is spent — as a parameter, in a
comparison, or interpolated into text. Copy anything you need past the next call:

```ts
const caller = lookupCaller({ phone: system.customerEndpoint.address });
setFlowAttributes({ tier: caller.tier });
const account = lookupAccount({ id: attr("account") });
play(`Tier ${flowAttr("tier")}, balance ${account.balance}.`);
```

Branches are accounted for rather than assumed away. A result stays readable inside the branch that
produced it and in the branch beside it, and stops being readable after the branch converges, since by
then it may or may not have been replaced. A loop body that both reads and replaces a result is
rejected too: it is correct on the first iteration and wrong on every one after it. `goto` is the
exception — a jump can re-enter code with a different action's result in the slot, and that is not
tracked.

## What the flow language cannot do

These are limits of Amazon Connect, not gaps in this library. They are the first things you will hit,
so they are worth reading before you start.

**Comparisons are unary, against a literal.** `Compare` takes one JSONPath and tests it against one
*static* operand. There is no operator that compares two runtime values, so `right` is typed as a
plain literal and passing a `Ref` is a compile error:

```ts
// Compile error: right must be a literal.
flowIf({ op: "equals", left: attr("a"), right: attr("b") }, { ... });
```

To compare two attributes, pass both to a Lambda and branch on what it returns.

**There is no arithmetic.** Nothing in the flow language adds, counts, or concatenates. Anything
computed happens in a Lambda.

**Operators are typed to the value.** `Ref<number>` offers `lessThan`/`greaterOrEqual`/…;
`Ref<string>` offers `startsWith`/`contains`/…; an object-valued ref offers `keyExists`. Using the
wrong one is a compile error rather than a condition that silently never matches.

**There are no `and`/`or` conditions.** Probing the service confirms `And`, `Or` and `Not` are rejected,
and a condition takes exactly one operand — the reference's description of nested condition objects
describes something `Compare` cannot do. Combine tests by chaining `flowIf`s, or decide in a Lambda.

**No native `if`, `try`, or concurrency.** A recorder sees the thunks it is handed, not branches the
JavaScript engine already took. Use `flowIf`/`flowSwitch`/`flowLoop`/`onError`. There is no
concurrency to express either: recording is synchronous and the flow runs one action at a time.

**250 actions per flow, shared by everything inlined.** Fragments inline at each call site, so deep
composition is how you blow the budget. `validate()` reports the count attributed per scope so the
responsible fragment is identifiable. Prefer `flowSwitch` to nested `flowIf`s: N cases cost one
action instead of N. When a fragment genuinely will not fit, move it into a `ContactFlowModule`,
which gets a budget of its own.

## Flow modules

A flow module is a subgraph Connect stores as its own resource, with its own 250-action budget. It
is authored exactly as a flow is — same actions, same `onError` — and differs only in how it ends:
control returns to whatever invoked it rather than the contact ending.

```ts
const authenticate = new ContactFlowModule("authenticate", {
  instanceArn,
  flow: () => {
    const pin = collectInput({ text: "Enter your PIN.", maxLength: 4 });
    setFlowAttributes({ pin });
    endFlowModule();
  },
  onError: () => endFlowModule(),
});

new ContactFlow("inbound", {
  instanceId,
  flow: () => {
    authenticate.invoke({ onError: () => play("We could not verify you.") });
    transferToQueue({ queue: supportQueue });
  },
  onError: () => disconnect(),
});
```

`invoke` embeds a deferred token for the module's id, qualified with `$LATEST` unless
`moduleVersion` says otherwise, so nothing has to be redeclared at the call site. Lambdas the module
invokes are associated with the instance by the module itself.

A branch that runs off the end of a module gets `EndFlowModuleExecution` rather than
`DisconnectParticipant` — neither that nor `EndFlowExecution` is legal inside a module. Attributes
the module sets with `setFlowAttributes` survive the return; a result slot does not, so read a
Lambda's result inside the module that invoked it.

`invokeFlowModule` calls a module this library did not author, by id.

### Modules as functions

A module that only shares actions is a subroutine. Declare a contract and it becomes a function: it
takes an input object, returns an output object, and exits through one of its own named branches.

```ts
const authenticate = new ContactFlowModule("authenticate", {
  instanceArn,
  input: { phone: "string" },
  output: { customerId: "string" },
  branches: ["authenticated", "unauthenticated"],
  flow: ({ input, end }) => {
    const customer = lookup({ phone: input.phone });
    flowIf({ op: "equals", left: customer.found, right: "true" }, {
      ifTrue: () => end({ branch: "authenticated", data: { customerId: customer.id } }),
    });
    end({ branch: "unauthenticated" });
  },
  onError: () => endFlowModule(),
});

// inside a flow
const result = authenticate.invoke({
  data: { phone: system.customerEndpoint.address },
  on: { unauthenticated: () => play("We could not verify you.") },
});
setAttributes({ customerId: result.customerId });
```

`input` and `output` are field maps rather than `shape<T>()` witnesses, because Connect stores them
as JSON Schema and TypeScript types are erased — one declaration produces both the schema on the wire
and the types every call site is checked against. `end` is handed to the body rather than imported,
since it is the only form that knows which branches exist.

Branch handlers are partial, like a view's actions: a branch with no handler continues with whatever
follows the call, so a run of module calls reads as a run of statements.

Three things follow from how the service validates this, and all three are compile errors here:

- **A `Ref` is only legal in a `string` field.** A reference is a `$.`-path string on the wire, so a
  `number` field rejects it — `attr("count")` cannot be passed where `count: "number"` was declared.
- **A key the module did not declare is rejected**, at both ends, by the service as well as the type.
- **A branch the module did not declare is rejected**, including at the call site: `CreateContactFlow`
  checks the caller's conditions against the *module's* declaration.

The contract does not live in the flow content — it is a JSON Schema on the resource, which the
classic `aws` provider cannot express. `ContactFlowModule` is therefore an `aws-native` resource and
takes `instanceArn`, as `ConnectView` does; the instance id it needs for Lambda associations is read
off the end of it.

Inside the module, the input is read from `$.Modules.Input` and the caller reads the output from
`$.Modules.ResultData`. That second one is volatile — the next module invoked overwrites it — so
reading one module's output after invoking another is an error rather than a value that is quietly
wrong, exactly as with a view's result.

Not yet modelled: array and null field types, `required` on a schema (every declared field is
optional on the wire), module versions and aliases, and the module-as-tool
`ExternalInvocationConfiguration`.

## Actions

**Control flow** — `flowIf` · `flowSwitch` · `flowLoop` · `flowDistribute` · `onError` · `withScope`

**Participant** — `play` · `playIteratively` · `getDigit` · `collectInput` · `connectToLexBot` ·
`showView` · `disconnect` · `endFlow`

**Data** — `setAttributes` · `setFlowAttributes` · `connectLambda`

**Routing** — `setQueue` · `transferToQueue` · `dequeueAndTransferToQueue` · `transferToAgent` ·
`transferToThirdParty` · `transferToFlow` · `setRoutingBehavior` · `setRoutingCriteria`

**Checks** — `checkHoursOfOperation` · `checkStaffing` · `checkQueueMetric` · `getMetricData` ·
`checkVoiceId`

**Contact** — `setEventFlow` · `setVoice` · `setRecordingBehavior` · `setRecordingAndAnalytics` ·
`tagContact` · `untagContact` · `startMediaStreaming` · `stopMediaStreaming` ·
`setCallbackNumber` · `createCallbackContact` · `createTask` · `setPreviousParticipantState` ·
`createWisdomSession` · `resumeContact` · `setContactData` · `setMediaProcessing` ·
`startVoiceIdStream` · `setLogging` · `wait`

**Outbound** — `completeOutboundCall` · `checkOutboundCallStatus` · `startOutboundChat`

**Flow modules** — `ContactFlowModule` · `invokeFlowModule` · `endFlowModule`

Coverage was chosen by surveying 60 real flows across two Connect instances and implementing action
types in order of how many flows actually use them. Every one above has been published to a live
instance to confirm the service accepts it.

Still unimplemented: the six Customer Profiles actions and the three Cases actions. Both need a
configured domain on the instance, so they are a focused follow-up rather than a shape exercise.
Each action module is a small uniform shape — parameter type, error set, mapping to `Parameters` — so
adding one is mechanical, and the end-to-end suite is where you prove the service accepts it.

See [views.md](views.md) for `ConnectView`, the typed way to show one.

`setFlowAttributes` has no `onTimeout`-style options and `collectInput` has no `onTimeout` at all,
because Connect rejects a store-mode input that declares one. That and several other corrections came
from validating against the live API rather than the docs — see
[docs/wire-format-checks.md](docs/wire-format-checks.md), which records the four places the published
AWS reference is simply wrong.
