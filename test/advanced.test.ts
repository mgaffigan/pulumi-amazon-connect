/**
 * Voice ID, outbound, routing criteria, and the rest of the later action set.
 *
 * As elsewhere, every expectation was settled by publishing to a real instance. This group produced an
 * unusual number of corrections, because the AWS reference gets two action *type names* wrong here and
 * lists display labels where the service wants wire values.
 */

import { describe, expect, it } from "vitest";
import {
  checkOutboundCallStatus,
  checkVoiceId,
  completeOutboundCall,
  disconnect,
  endFlow,
  type FlowJson,
  getMetricData,
  play,
  setContactData,
  setMediaProcessing,
  setRoutingCriteria,
  startOutboundChat,
  startVoiceIdStream,
} from "../src/index.js";
import { recordFlow } from "../src/testing/index.js";

const root = { onError: () => disconnect() };

function record(flow: () => void): FlowJson {
  return recordFlow(flow, root);
}

function actionOf(flow: FlowJson, type: string) {
  const match = flow.Actions.find((a) => a.Type === type);
  expect(match, `no ${type} action emitted`).toBeDefined();
  return match as FlowJson["Actions"][number];
}

describe("action type names the reference gets wrong", () => {
  it("emits UpdateContactRoutingCriteria, not UpdateRoutingCriteria", () => {
    // The reference page is titled `UpdateRoutingCriteria`, which the service rejects outright.
    const flow = record(() => {
      setRoutingCriteria({
        steps: [{ require: [{ name: "Language", value: "Spanish", minimumLevel: 4 }] }],
      });
      disconnect();
    });

    const types = flow.Actions.map((a) => a.Type);
    expect(types).toContain("UpdateContactRoutingCriteria");
    expect(types).not.toContain("UpdateRoutingCriteria");
  });
});

describe("routing criteria", () => {
  it("emits proficiency as a float with the only supported operator", () => {
    const flow = record(() => {
      setRoutingCriteria({
        steps: [
          {
            require: [
              { name: "Language", value: "Spanish", minimumLevel: 4 },
              { name: "Skill", value: "Billing", minimumLevel: 2 },
            ],
            expiresAfterSeconds: 30,
          },
          { require: [{ name: "Language", value: "Spanish", minimumLevel: 1 }] },
        ],
      });
      disconnect();
    });

    const parameters = actionOf(flow, "UpdateContactRoutingCriteria").Parameters as {
      RoutingCriteria: { Steps: Array<Record<string, unknown>> };
    };
    const [first, second] = parameters.RoutingCriteria.Steps;

    expect(first).toEqual({
      Expression: {
        // Several requirements are AND-ed; there is no OR, so alternatives become separate steps.
        AndExpression: [
          {
            AttributeCondition: {
              Name: "Language",
              Value: "Spanish",
              ProficiencyLevel: "4.0",
              ComparisonOperator: "NumberGreaterOrEqualTo",
            },
          },
          {
            AttributeCondition: {
              Name: "Skill",
              Value: "Billing",
              ProficiencyLevel: "2.0",
              ComparisonOperator: "NumberGreaterOrEqualTo",
            },
          },
        ],
      },
      Expiry: { DurationInSeconds: "30" },
    });
    // The last step has no expiry, so it stands until the contact is answered.
    expect(second).not.toHaveProperty("Expiry");
  });

  it("rejects a step with no requirements", () => {
    expect(() =>
      record(() => {
        setRoutingCriteria({ steps: [{ require: [] }] });
      }),
    ).toThrow(/at least one attribute requirement/);
  });
});

describe("checkVoiceId", () => {
  it("uses the wire values, not the labels the reference prints", () => {
    // "Not enrolled" and "High risk" are display labels; the service wants them without spaces.
    const flow = record(() => {
      checkVoiceId({ check: "enrollmentStatus", onEnrolled: () => play("in") });
      disconnect();
    });

    const operands = actionOf(flow, "CheckVoiceId").Transitions.Conditions?.map(
      (c) => c.Condition.Operands[0],
    );
    expect(operands).toEqual(["Enrolled", "NotEnrolled", "OptedOut"]);
  });

  it("offers each check only its own outcomes", () => {
    const fraud = record(() => {
      checkVoiceId({ check: "fraudDetection", onHighRisk: () => play("risk") });
      disconnect();
    });

    const operands = actionOf(fraud, "CheckVoiceId").Transitions.Conditions?.map(
      (c) => c.Condition.Operands[0],
    );
    expect(operands).toEqual(["HighRisk", "LowRisk", "Inconclusive"]);
    expect(actionOf(fraud, "CheckVoiceId").Parameters).toEqual({
      CheckVoiceIdOption: "fraudDetection",
    });
  });

  it("emits StartVoiceIdStream with no parameters", () => {
    const flow = record(() => {
      startVoiceIdStream();
      disconnect();
    });
    expect(actionOf(flow, "StartVoiceIdStream").Parameters).toEqual({});
  });
});

describe("setContactData", () => {
  it("uses upper-case booleans, unlike every other action", () => {
    const flow = record(() => {
      setContactData({
        voiceId: {
          enabled: true,
          authenticationThreshold: 90,
          authenticationResponseTime: 7,
          fraudThreshold: 50,
        },
      });
      disconnect();
    });

    expect(actionOf(flow, "UpdateContactData").Parameters).toEqual({
      IsVoiceIdStreamingEnabled: "TRUE",
      IsVoiceAuthenticationEnabled: "TRUE",
      IsFraudDetectionEnabled: "TRUE",
      VoiceAuthenticationThreshold: "90",
      VoiceAuthenticationResponseTime: "7",
      FraudDetectionThreshold: "50",
      TargetContact: "Current",
    });
  });

  it("omits the thresholds when Voice ID is off, because Connect rejects them", () => {
    const flow = record(() => {
      setContactData({ voiceId: { enabled: false } });
      disconnect();
    });

    const parameters = actionOf(flow, "UpdateContactData").Parameters;
    expect(parameters).toEqual({
      IsVoiceIdStreamingEnabled: "FALSE",
      IsVoiceAuthenticationEnabled: "FALSE",
      IsFraudDetectionEnabled: "FALSE",
      TargetContact: "Current",
    });
  });

  it("rejects an action that would set nothing", () => {
    expect(() =>
      record(() => {
        setContactData({});
      }),
    ).toThrow(/at least one field/);
  });
});

describe("outbound", () => {
  it("branches on every answering outcome", () => {
    const flow = recordFlow(
      () => {
        checkOutboundCallStatus({ onAnswered: () => play("hello") });
        endFlow();
      },
      { onError: () => endFlow(), endWith: "EndFlowExecution" },
    );

    const operands = actionOf(flow, "CheckOutboundCallStatus").Transitions.Conditions?.map(
      (c) => c.Condition.Operands[0],
    );
    expect(operands).toEqual(["CallAnswered", "VoicemailBeep", "VoicemailNoBeep", "NotDetected"]);
  });

  it("nests the caller ID override under CallerId", () => {
    const flow = recordFlow(
      () => {
        completeOutboundCall({ callerIdNumber: "+15555550100" });
        endFlow();
      },
      { onError: () => endFlow(), endWith: "EndFlowExecution" },
    );

    expect(actionOf(flow, "CompleteOutboundCall").Parameters).toEqual({
      CallerId: { Number: "+15555550100" },
    });
  });

  it("fixes the SMS endpoint types, since Connect supports no others", () => {
    const flow = record(() => {
      startOutboundChat({
        fromPhoneNumberArn: "arn:aws:connect:us-east-1:123456789012:phone-number/abc",
        toPhoneNumber: "+15555550123",
        flowArn: "arn:aws:connect:us-east-1:123456789012:instance/i/contact-flow/f",
        initialMessage: "hi",
        relateToCurrentContact: true,
      });
      disconnect();
    });

    expect(actionOf(flow, "StartOutboundChatContact").Parameters).toMatchObject({
      SourceEndpoint: { Type: "CONNECT_PHONENUMBER_ARN" },
      DestinationEndpoint: { Type: "TELEPHONE_NUMBER" },
      ContactSubtype: "connect:SMS",
      InitialSystemMessage: { Content: "hi" },
      RelatedContact: "CURRENT",
    });
  });
});

describe("media processing and metrics", () => {
  it("always emits ChatProcessorSettings, which Connect requires", () => {
    const flow = record(() => {
      setMediaProcessing({ lambdaArn: "arn:aws:lambda:us-east-1:123456789012:function:p" });
      disconnect();
    });

    expect(actionOf(flow, "UpdateContactMediaProcessing").Parameters).toEqual({
      ChatProcessor: {
        ProcessingEnabled: "True",
        LambdaProcessorARN: "arn:aws:lambda:us-east-1:123456789012:function:p",
        ChatProcessorSettings: { DeliverUnprocessedMessages: "False" },
      },
    });
  });

  it("passes the channel filter through and declares no metric type", () => {
    // GetMetricData loads every metric, so unlike checkQueueMetric it names none.
    const flow = record(() => {
      getMetricData({ channel: "Voice" });
      disconnect();
    });

    expect(actionOf(flow, "GetMetricData").Parameters).toEqual({ QueueChannel: "Voice" });
  });
});

describe("terminal action by flow type", () => {
  it("synthesizes EndFlowExecution where a disconnect is rejected", () => {
    // Whisper and hold flows reject DisconnectParticipant, so a run-off-the-end branch cannot use it.
    const flow = recordFlow(
      () => {
        play("whispering");
      },
      { onError: () => endFlow(), endWith: "EndFlowExecution" },
    );

    expect(flow.Actions.map((a) => a.Type)).toContain("EndFlowExecution");
    expect(flow.Actions.map((a) => a.Type)).not.toContain("DisconnectParticipant");
  });
});
