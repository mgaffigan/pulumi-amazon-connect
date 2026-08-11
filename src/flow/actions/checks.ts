/**
 * Flow-control actions that branch on something they look up.
 *
 * Each produces a result its own conditions test, rather than a value the flow can read. The result
 * is never a `Ref` — there is no JSONPath for "was the queue open" — so these actions take their
 * branches inline.
 */

import type { FlowFragment } from "../recorder.js";
import { type ResourceRef, renderResource } from "../refs.js";
import { NO_MATCHING_CONDITION, NO_MATCHING_ERROR } from "../types.js";
import { compact, type OutcomeHandler, type ResultBranch, recordAction } from "./action.js";

export interface HoursOfOperationOptions {
  /**
   * Which hours of operation to check. Defaults to the ones attached to the contact's target queue.
   */
  hoursOfOperationId?: ResourceRef;
  /** Runs when the hours of operation are currently open. */
  ifOpen?: FlowFragment;
  /** Runs when they are closed. */
  ifClosed?: FlowFragment;
  onError?: OutcomeHandler;
}

/**
 * Branches on whether an hours-of-operation schedule is currently open.
 *
 * ```ts
 * checkHoursOfOperation({
 *   ifOpen: () => transferToQueue(),
 *   ifClosed: () => play("We're closed. Please call back during business hours."),
 * });
 * ```
 *
 * Connect requires a condition for both `True` and `False` and no others, so both branches are
 * always emitted — an omitted one simply continues with the rest of the flow.
 */
export function checkHoursOfOperation(options: HoursOfOperationOptions = {}): void {
  recordAction({
    type: "CheckHoursOfOperation",
    hint: "check-hours",
    parameters: compact({
      HoursOfOperationId:
        options.hoursOfOperationId === undefined
          ? undefined
          : renderResource(options.hoursOfOperationId),
    }),
    conditions: [
      { operands: ["True"], ...(options.ifOpen === undefined ? {} : { handler: options.ifOpen }) },
      {
        operands: ["False"],
        ...(options.ifClosed === undefined ? {} : { handler: options.ifClosed }),
      },
    ],
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

/**
 * Agent-count metrics.
 *
 * Connect permits exactly one comparison on these — `NumberGreaterThan 0` — so they answer "is there
 * anybody?" and nothing more. {@link checkStaffing} is shaped around that.
 */
export type StaffingMetric =
  | "NumberOfAgentsAvailable"
  | "NumberOfAgentsStaffed"
  | "NumberOfAgentsOnline";

/** Queue-depth metrics, which accept the full range of numeric comparisons. */
export type QueueMetric = "OldestContactInQueueAgeSeconds" | "NumberOfContactsInQueue";

interface MetricTarget {
  /** Defaults to the contact's target queue. */
  queue?: ResourceRef;
  /** An agent queue to read instead of a standard queue. Mutually exclusive with `queue`. */
  agent?: ResourceRef;
}

function metricParameters(metric: string, target: MetricTarget) {
  if (target.queue !== undefined && target.agent !== undefined) {
    throw new Error("A metric check takes either `queue` or `agent`, not both.");
  }
  return compact({
    MetricType: metric,
    QueueId: target.queue === undefined ? undefined : renderResource(target.queue),
    AgentId: target.agent === undefined ? undefined : renderResource(target.agent),
  });
}

export interface CheckStaffingOptions extends MetricTarget {
  /** Defaults to `NumberOfAgentsAvailable`. */
  metric?: StaffingMetric;
  /** Runs when at least one agent matches the metric. */
  ifAny?: FlowFragment;
  /** Runs when none do. */
  otherwise?: FlowFragment;
  onError?: OutcomeHandler;
}

/**
 * Branches on whether any agents are available, staffed, or online.
 *
 * ```ts
 * checkStaffing({
 *   ifAny: () => transferToQueue(),
 *   otherwise: () => play("Nobody is available right now."),
 * });
 * ```
 *
 * There is no threshold parameter because Connect does not support one: agent metrics accept only
 * `NumberGreaterThan 0`. For a real threshold, read the queue depth with {@link checkQueueMetric}.
 */
export function checkStaffing(options: CheckStaffingOptions = {}): void {
  recordAction({
    type: "CheckMetricData",
    hint: "check-staffing",
    parameters: metricParameters(options.metric ?? "NumberOfAgentsAvailable", options),
    conditions: [
      {
        operator: "NumberGreaterThan",
        operands: ["0"],
        ...(options.ifAny === undefined ? {} : { handler: options.ifAny }),
      },
    ],
    ...(options.otherwise === undefined ? {} : { fallthrough: options.otherwise }),
    // The reference claims NoMatchingCondition applies only to the queue-depth metrics; the service
    // requires it on the agent metrics too.
    requiredErrors: [NO_MATCHING_ERROR, NO_MATCHING_CONDITION],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

/** A numeric comparison against a queue metric's value. */
export interface MetricBranch {
  op: "lessThan" | "lessOrEqual" | "greaterThan" | "greaterOrEqual" | "equals";
  value: number;
  run: FlowFragment;
}

export interface CheckQueueMetricOptions extends MetricTarget {
  metric: QueueMetric;
  /** Tested in order; the first match wins. */
  when: MetricBranch[];
  /** Runs when no comparison matched. */
  otherwise?: FlowFragment;
  onError?: OutcomeHandler;
}

const METRIC_OPERATORS = {
  equals: "Equals",
  lessThan: "NumberLessThan",
  lessOrEqual: "NumberLessOrEqualTo",
  greaterThan: "NumberGreaterThan",
  greaterOrEqual: "NumberGreaterOrEqualTo",
} as const;

/**
 * Branches on how deep or how stale the queue is.
 *
 * ```ts
 * checkQueueMetric({
 *   metric: "OldestContactInQueueAgeSeconds",
 *   when: [{ op: "greaterThan", value: 300, run: offerCallback }],
 *   otherwise: () => transferToQueue(),
 * });
 * ```
 *
 * The age metric is in seconds, as its name says.
 */
export function checkQueueMetric(options: CheckQueueMetricOptions): void {
  if (options.when.length === 0) {
    throw new Error("checkQueueMetric requires at least one comparison in `when`.");
  }

  recordAction({
    type: "CheckMetricData",
    hint: "check-queue-metric",
    parameters: metricParameters(options.metric, options),
    conditions: options.when.map(
      (branch): ResultBranch => ({
        operator: METRIC_OPERATORS[branch.op],
        operands: [String(branch.value)],
        handler: branch.run,
      }),
    ),
    ...(options.otherwise === undefined ? {} : { fallthrough: options.otherwise }),
    // Connect supports NoMatchingCondition only on the queue-depth metrics, which is why this is
    // here and absent from checkStaffing.
    requiredErrors: [NO_MATCHING_ERROR, NO_MATCHING_CONDITION],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

export interface GetMetricDataOptions extends MetricTarget {
  /** Limits the metrics to one channel. Omit for all channels. */
  channel?: "Voice" | "Chat";
  onError?: OutcomeHandler;
}

/**
 * Loads the full set of real-time queue metrics onto the flow's run data.
 *
 * ```ts
 * getMetricData({ queue: salesQueueArn });
 * ```
 *
 * Where {@link checkQueueMetric} reads one metric and branches in a single action, this loads them all
 * and branches separately — useful when several decisions depend on the same snapshot.
 *
 * Reading the values back is deliberately not wrapped: the flow-language reference says only that they
 * become "available on the flow run data" without naming the paths, and a wrong path would silently
 * read empty at runtime rather than fail at deploy. Once you have confirmed the path for the metric
 * you need, reach for it with `makeRef("$.Metrics...")`.
 */
export function getMetricData(options: GetMetricDataOptions = {}): void {
  recordAction({
    type: "GetMetricData",
    hint: "get-metric-data",
    parameters: compact({
      ...metricParameters("", options),
      MetricType: undefined,
      QueueChannel: options.channel,
    }),
    requiredErrors: [NO_MATCHING_ERROR],
    outcomes: { [NO_MATCHING_ERROR]: options.onError },
  });
}

/** One share of a percentage split. */
export interface DistributionBranch {
  /** Whole percent of contacts to send down this branch. */
  percent: number;
  run: FlowFragment;
}

export interface DistributeOptions {
  branches: DistributionBranch[];
  /** Runs for whatever percentage is left over. */
  otherwise?: FlowFragment;
}

/**
 * Splits traffic by percentage, for A/B routing.
 *
 * ```ts
 * flowDistribute({
 *   branches: [
 *     { percent: 10, run: newExperience },
 *     { percent: 90, run: currentExperience },
 *   ],
 * });
 * ```
 *
 * Connect draws a number and takes the first condition whose threshold exceeds it, so the emitted
 * operands are *cumulative* — 10 and 90 become `NumberLessThan 10` and `NumberLessThan 100`. Shares
 * summing to less than 100 leave the remainder to `otherwise`.
 */
export function flowDistribute(options: DistributeOptions): void {
  if (options.branches.length === 0) {
    throw new Error("flowDistribute requires at least one branch.");
  }
  for (const branch of options.branches) {
    if (!Number.isInteger(branch.percent) || branch.percent <= 0 || branch.percent > 100) {
      throw new Error(
        `Distribution percentages must be integers between 1 and 100, received ${branch.percent}.`,
      );
    }
  }

  let cumulative = 0;
  const conditions: ResultBranch[] = options.branches.map((branch) => {
    cumulative += branch.percent;
    return {
      operator: "NumberLessThan" as const,
      operands: [String(cumulative)],
      handler: branch.run,
    };
  });

  if (cumulative > 100) {
    throw new Error(`Distribution percentages sum to ${cumulative}, which exceeds 100.`);
  }

  recordAction({
    type: "DistributeByPercentage",
    hint: "distribute",
    parameters: {},
    conditions,
    ...(options.otherwise === undefined ? {} : { fallthrough: options.otherwise }),
    // The only outcome this action documents; the leftover percentage arrives here.
    requiredErrors: [NO_MATCHING_CONDITION],
  });
}
