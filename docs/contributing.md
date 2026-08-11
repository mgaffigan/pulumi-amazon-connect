# Contributing

Working on the library itself.

## Checks

```sh
npm install
npm test          # unit, golden-snapshot, and type-level tests — all offline
npm run typecheck # src and examples
npm run lint
npm run build
npm run smoke     # loads the built package as a consumer would; catches ESM cycles
```

`npm test` includes `test/types.test-d.ts`, where each `@ts-expect-error` asserts that something the
flow language cannot express still fails to compile.

### End-to-end tests

`CreateContactFlow` performs full server-side validation, which is the only way to know that emitted
JSON is genuinely correct — the published AWS reference has been wrong about nine shapes, and every one
was caught this way rather than by the docs or the offline tests. So there is a suite that publishes
real flows and deletes them again:

```sh
CONNECT_E2E_INSTANCE_ID=<sandbox-instance-id> npm run test:e2e
```

- **Opt-in.** Without that variable every test skips, so the command is safe to run anywhere and
  `npm test` never touches AWS.
- **Point it at a non-production instance.** It creates flows named `zz-e2e-*` and removes them in an
  `afterAll` that runs even when an assertion fails, but it is still writing to a live contact center.
- Region comes from `AWS_REGION` (or `CONNECT_E2E_REGION`), defaulting to `us-east-1`. The queue and
  reference flow it needs are discovered from the instance, so the instance id is the only thing to
  configure.
- If a run is killed before cleanup, `CONNECT_E2E_INSTANCE_ID=<id> npm run e2e:sweep` deletes any
  leftovers.

The fixtures in [test/e2e/fixtures.ts](test/e2e/fixtures.ts) are grouped by flow type, because Connect
restricts which actions each type allows. Each one declares the action types it proves, and a final
test fails if something declared is never actually emitted — so adding an action module without
proving the service accepts it breaks the build.

Failures report the `problems` list from `InvalidContactFlowException`, naming the action index and
parameter:

```
Error: Amazon Connect rejected core:
  - Invalid Action property name. Path: Actions[13].Parameters.TimeoutSeconds
  - Action is missing required property. Path: Actions[13].Parameters.TimeLimitSeconds
```

That list is why the suite uses the AWS SDK rather than the CLI, which prints an empty error message
and discards the detail.
