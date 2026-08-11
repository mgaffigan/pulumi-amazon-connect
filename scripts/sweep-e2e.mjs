/**
 * Deletes any `zz-e2e-*` flows left behind in a Connect instance.
 *
 * The end-to-end suite cleans up after itself, including after a failed assertion, but a killed
 * process or a network drop can still leave one. Run this to be sure:
 *
 *   CONNECT_E2E_INSTANCE_ID=<instance-id> npm run e2e:sweep
 *
 * Covers both flows and views, since both suites create resources.
 */

import {
  ConnectClient,
  DeleteContactFlowCommand,
  DeleteViewCommand,
  ListContactFlowsCommand,
  ListViewsCommand,
} from "@aws-sdk/client-connect";

const instanceId = process.env.CONNECT_E2E_INSTANCE_ID;
const region = process.env.AWS_REGION ?? process.env.CONNECT_E2E_REGION ?? "us-east-1";
const PREFIX = "zz-e2e-";

if (!instanceId) {
  console.error("Set CONNECT_E2E_INSTANCE_ID to the instance to sweep.");
  process.exit(1);
}

const client = new ConnectClient({ region });

const flows = [];
let nextToken;
do {
  const page = await client.send(
    new ListContactFlowsCommand({ InstanceId: instanceId, NextToken: nextToken }),
  );
  flows.push(...(page.ContactFlowSummaryList ?? []));
  nextToken = page.NextToken;
} while (nextToken);

const views = [];
nextToken = undefined;
do {
  const page = await client.send(
    new ListViewsCommand({ InstanceId: instanceId, NextToken: nextToken }),
  );
  views.push(...(page.ViewsSummaryList ?? []));
  nextToken = page.NextToken;
} while (nextToken);

const staleFlows = flows.filter((f) => f.Name?.startsWith(PREFIX));
// Only customer-managed views can be deleted; the AWS-managed ones are not ours to touch.
const staleViews = views.filter((v) => v.Name?.startsWith(PREFIX) && v.Type !== "AWS_MANAGED");

if (staleFlows.length === 0 && staleViews.length === 0) {
  console.log(`No ${PREFIX}* flows or views in ${instanceId}. Nothing to sweep.`);
  process.exit(0);
}

for (const flow of staleFlows) {
  await client.send(
    new DeleteContactFlowCommand({ InstanceId: instanceId, ContactFlowId: flow.Id }),
  );
  console.log(`deleted flow ${flow.Name}`);
}
for (const view of staleViews) {
  await client.send(new DeleteViewCommand({ InstanceId: instanceId, ViewId: view.Id }));
  console.log(`deleted view ${view.Name}`);
}
console.log(`Swept ${staleFlows.length} flow(s) and ${staleViews.length} view(s).`);
