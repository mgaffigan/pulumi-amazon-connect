/**
 * The action set beyond the first milestone.
 *
 * Every expectation here was checked by publishing the emitted flow to a real Connect instance, so
 * the shapes are what the service accepts rather than what the reference documents — the two differ
 * more often than not.
 */

import { describe, expect, it } from "vitest";
import {
  attr,
  checkHoursOfOperation,
  checkQueueMetric,
  checkStaffing,
  collectInput,
  connectToLexBot,
  createCallbackContact,
  createTask,
  dequeueAndTransferToQueue,
  disconnect,
  endFlowModule,
  external,
  type FlowJson,
  flowDistribute,
  flowIf,
  invokeFlowModule,
  play,
  playIteratively,
  resumeContact,
  setCallbackNumber,
  setEventFlow,
  setPreviousParticipantState,
  setRecordingAndAnalytics,
  setRecordingBehavior,
  setRoutingBehavior,
  setVoice,
  startMediaStreaming,
  stopMediaStreaming,
  system,
  tagContact,
  transferToAgent,
  transferToThirdParty,
  untagContact,
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

function errorsOf(flow: FlowJson, type: string): string[] {
  return (actionOf(flow, type).Transitions.Errors ?? []).map((e) => e.ErrorType).sort();
}

describe("checkHoursOfOperation", () => {
  it("always emits both the True and False conditions", () => {
    // Connect requires a condition for each and no others, so an omitted branch still gets one.
    const flow = record(() => {
      checkHoursOfOperation({ ifOpen: () => play("open") });
      disconnect();
    });

    const conditions = actionOf(flow, "CheckHoursOfOperation").Transitions.Conditions ?? [];
    expect(conditions.map((c) => c.Condition.Operands[0])).toEqual(["True", "False"]);
  });

  it("omits HoursOfOperationId when defaulting to the contact's queue", () => {
    const flow = record(() => {
      checkHoursOfOperation({ ifOpen: () => play("open") });
      disconnect();
    });
    expect(actionOf(flow, "CheckHoursOfOperation").Parameters).toEqual({});
  });
});

describe("metric checks", () => {
  it("emits the only comparison Connect allows on agent metrics", () => {
    // Agent metrics accept NumberGreaterThan 0 and nothing else, which is why checkStaffing has no
    // threshold parameter.
    const flow = record(() => {
      checkStaffing({ ifAny: () => play("someone's here") });
      disconnect();
    });

    const action = actionOf(flow, "CheckMetricData");
    expect(action.Parameters).toEqual({ MetricType: "NumberOfAgentsAvailable" });
    expect(action.Transitions.Conditions?.[0]?.Condition).toEqual({
      Operator: "NumberGreaterThan",
      Operands: ["0"],
    });
    // The reference says this error applies only to queue-depth metrics; the service requires it here.
    expect(errorsOf(flow, "CheckMetricData")).toEqual(["NoMatchingCondition", "NoMatchingError"]);
  });

  it("maps queue metric comparisons to numeric operators", () => {
    const flow = record(() => {
      checkQueueMetric({
        metric: "OldestContactInQueueAgeSeconds",
        when: [{ op: "greaterThan", value: 300, run: () => play("busy") }],
        otherwise: () => play("quiet"),
      });
      disconnect();
    });

    expect(actionOf(flow, "CheckMetricData").Transitions.Conditions?.[0]?.Condition).toEqual({
      Operator: "NumberGreaterThan",
      Operands: ["300"],
    });
  });

  it("rejects targeting a queue and an agent at once", () => {
    expect(() =>
      record(() => {
        checkStaffing({ queue: "q", agent: "a" });
      }),
    ).toThrow(/either `queue` or `agent`/);
  });
});

describe("flowDistribute", () => {
  it("converts percentages into cumulative thresholds", () => {
    // Connect draws a number and takes the first condition that exceeds it, so 10/60/30 becomes
    // 10/70/100 on the wire.
    const flow = record(() => {
      flowDistribute({
        branches: [
          { percent: 10, run: () => play("a") },
          { percent: 60, run: () => play("b") },
          { percent: 30, run: () => play("c") },
        ],
      });
      disconnect();
    });

    const conditions = actionOf(flow, "DistributeByPercentage").Transitions.Conditions ?? [];
    expect(conditions.map((c) => c.Condition.Operands[0])).toEqual(["10", "70", "100"]);
    expect(conditions.every((c) => c.Condition.Operator === "NumberLessThan")).toBe(true);
  });

  it("rejects shares summing past 100", () => {
    expect(() =>
      record(() => {
        flowDistribute({
          branches: [
            { percent: 60, run: () => play("a") },
            { percent: 60, run: () => play("b") },
          ],
        });
      }),
    ).toThrow(/sum to 120/);
  });
});

describe("transferToThirdParty", () => {
  it("declares the failure outcomes only when the flow keeps control", () => {
    const continues = record(() => {
      transferToThirdParty({
        phoneNumber: "+15555550123",
        connectionTimeoutSeconds: 30,
        continueFlowExecution: true,
        onTimeout: () => play("no answer"),
      });
      disconnect();
    });
    expect(errorsOf(continues, "TransferParticipantToThirdParty")).toEqual([
      "CallFailed",
      "ConnectionTimeLimitExceeded",
      "NoMatchingError",
    ]);

    const handsOff = record(() => {
      transferToThirdParty({
        phoneNumber: "+15555550123",
        connectionTimeoutSeconds: 30,
        continueFlowExecution: false,
      });
      disconnect();
    });
    // Handing the call over leaves no branch to take, and Connect rejects the action if these are
    // declared anyway.
    expect(errorsOf(handsOff, "TransferParticipantToThirdParty")).toEqual(["NoMatchingError"]);
  });

  it("always emits ContinueFlowExecution", () => {
    const flow = record(() => {
      transferToThirdParty({
        phoneNumber: "+15555550123",
        connectionTimeoutSeconds: 30,
        continueFlowExecution: false,
        dtmfDigits: attr("dialCode"),
      });
      disconnect();
    });

    expect(actionOf(flow, "TransferParticipantToThirdParty").Parameters).toEqual({
      ThirdPartyPhoneNumber: "+15555550123",
      ThirdPartyConnectionTimeLimitSeconds: "30",
      ContinueFlowExecution: "False",
      ThirdPartyDTMFDigits: "$.Attributes.dialCode",
    });
  });
});

describe("contact actions", () => {
  it("sets one event hook per action", () => {
    // Connect permits only a single entry in the EventHooks map.
    const flow = record(() => {
      setEventFlow("CustomerQueue", "flow-1");
      setEventFlow("CustomerHold", "flow-2");
      disconnect();
    });

    const hooks = flow.Actions.filter((a) => a.Type === "UpdateContactEventHooks");
    expect(hooks).toHaveLength(2);
    expect(hooks[0]?.Parameters).toEqual({ EventHooks: { CustomerQueue: "flow-1" } });
    expect(hooks[1]?.Parameters).toEqual({ EventHooks: { CustomerHold: "flow-2" } });
  });

  it("stops recording with an empty participant list", () => {
    const flow = record(() => {
      setRecordingBehavior({ participants: [] });
      disconnect();
    });
    expect(actionOf(flow, "UpdateContactRecordingBehavior").Parameters).toEqual({
      RecordingBehavior: { RecordedParticipants: [] },
    });
  });

  it("declares in-flight redaction failures for chat only", () => {
    // The outcome exists only on chat; Connect rejects it on a voice action.
    const voice = record(() => {
      setRecordingAndAnalytics({
        channel: "voice",
        recording: { participants: ["Agent", "Customer"] },
        analytics: { language: "en-US", modes: ["RealTime"] },
      });
      disconnect();
    });
    expect(errorsOf(voice, "UpdateContactRecordingAndAnalyticsBehavior")).toEqual([
      "ChannelMismatch",
      "NoMatchingError",
    ]);

    const chat = record(() => {
      setRecordingAndAnalytics({
        channel: "chat",
        analytics: { language: "en-US", modes: ["ContactLens"] },
      });
      disconnect();
    });
    expect(errorsOf(chat, "UpdateContactRecordingAndAnalyticsBehavior")).toContain(
      "InFlightRedactionConfigurationFailed",
    );
  });

  it("puts voice analytics under VoiceBehavior and chat under ChatBehavior", () => {
    const chat = record(() => {
      setRecordingAndAnalytics({
        channel: "chat",
        analytics: { language: "en-US", modes: ["ContactLens"], sentiment: true },
      });
      disconnect();
    });

    const parameters = actionOf(chat, "UpdateContactRecordingAndAnalyticsBehavior").Parameters;
    expect(parameters).toHaveProperty("ChatBehavior");
    expect(parameters).not.toHaveProperty("VoiceBehavior");
  });

  it("declares only the two specific callback-number failures", () => {
    // This action has no generic error vertex at all.
    const flow = record(() => {
      setCallbackNumber(system.storedCustomerInput);
      disconnect();
    });
    expect(errorsOf(flow, "UpdateContactCallbackNumber")).toEqual([
      "CallbackNumberNotDialable",
      "InvalidCallbackNumber",
    ]);
  });

  it("emits callback timing as strings", () => {
    const flow = record(() => {
      createCallbackContact({
        initialDelaySeconds: 60,
        retryDelaySeconds: 600,
        maximumAttempts: 3,
      });
      disconnect();
    });
    expect(actionOf(flow, "CreateCallbackContact").Parameters).toEqual({
      InitialCallDelaySeconds: "60",
      RetryDelaySeconds: "600",
      MaximumConnectionAttempts: "3",
    });
  });

  it("accepts only the three participant states Connect defines", () => {
    const flow = record(() => {
      setPreviousParticipantState("AgentOnHold");
      disconnect();
    });
    expect(actionOf(flow, "UpdatePreviousContactParticipantState").Parameters).toEqual({
      PreviousContactParticipantState: "AgentOnHold",
    });
  });

  it("rejects setting both routing adjustments at once", () => {
    expect(() =>
      record(() => {
        setRoutingBehavior({ queuePriority: 1, queueTimeAdjustmentSeconds: 600 });
      }),
    ).toThrow(/exactly one of/);
  });

  it("renders task attributes as strings", () => {
    const flow = record(() => {
      createTask({
        name: "Follow up",
        flowId: "flow-1",
        attributes: { phone: system.customerEndpoint.address },
      });
      disconnect();
    });
    expect(actionOf(flow, "CreateTask").Parameters).toEqual({
      Name: "Follow up",
      ContactFlowId: "flow-1",
      Attributes: { phone: "$.CustomerEndpoint.Address" },
    });
  });
});

describe("completeness gaps found by probing the service", () => {
  it("supports the KeyExists operator the reference's table omits", () => {
    // Confirmed accepted with exactly one operand. Its companion `Exists`, which the console offers
    // behind a feature flag, is rejected — so it is not exposed.
    const payload = external<{ tier: string }>("customer");
    const flow = record(() => {
      flowIf(
        { op: "keyExists", left: payload, right: "tier" },
        { ifTrue: () => play("has a tier"), ifFalse: () => play("no tier") },
      );
      disconnect();
    });

    expect(actionOf(flow, "Compare").Transitions.Conditions?.[0]?.Condition).toEqual({
      Operator: "KeyExists",
      Operands: ["tier"],
    });
  });

  it("encrypts collected input when a key is supplied", () => {
    const flow = record(() => {
      collectInput({
        text: "Card number?",
        timeoutSeconds: 6,
        maxLength: 16,
        encryption: { keyId: "key-1", publicKey: "-----BEGIN PUBLIC KEY-----" },
      });
      disconnect();
    });

    expect(actionOf(flow, "GetParticipantInput").Parameters).toMatchObject({
      InputEncryption: { EncryptionKeyId: "key-1", Key: "-----BEGIN PUBLIC KEY-----" },
    });
  });

  it("rejects encryption without maxLength validation", () => {
    // Connect only accepts InputEncryption alongside CustomValidation.
    expect(() =>
      record(() => {
        collectInput({
          text: "Card number?",
          timeoutSeconds: 6,
          phoneNumber: { format: "E164" },
          encryption: { keyId: "key-1", publicKey: "pem" },
        });
      }),
    ).toThrow(/encryption requires maxLength/);
  });

  it("requires the third-party connection time limit", () => {
    // The reference marks it optional; Connect rejects the action without it, so the type requires it.
    const flow = record(() => {
      transferToThirdParty({
        phoneNumber: "+15555550123",
        connectionTimeoutSeconds: 30,
        continueFlowExecution: false,
      });
      disconnect();
    });

    expect(actionOf(flow, "TransferParticipantToThirdParty").Parameters).toMatchObject({
      ThirdPartyConnectionTimeLimitSeconds: "30",
    });
  });
});

describe("contact settings", () => {
  it("emits the Polly voice, engine, and style", () => {
    // The reference names these parameters but not their values. Engines are Polly's own lower-case
    // names; the style is `Conversational`, which the reference misspells as "Coversational".
    const flow = record(() => {
      setVoice({ voice: "Danielle", engine: "neural", style: "Conversational" });
      disconnect();
    });

    expect(actionOf(flow, "UpdateContactTextToSpeechVoice").Parameters).toEqual({
      TextToSpeechVoice: "Danielle",
      TextToSpeechEngine: "neural",
      TextToSpeechStyle: "Conversational",
    });
  });

  it("uses the type name UntagContact, not UnTagContact", () => {
    // Both the title and body of the AWS reference page spell it `UnTagContact`; the service rejects
    // that as an unknown action type.
    const flow = record(() => {
      untagContact(["campaign"]);
      disconnect();
    });

    expect(flow.Actions.map((a) => a.Type)).toContain("UntagContact");
    expect(flow.Actions.map((a) => a.Type)).not.toContain("UnTagContact");
    expect(actionOf(flow, "UntagContact").Parameters).toEqual({ TagKeys: ["campaign"] });
  });

  it("renders tag values but keeps untag keys literal", () => {
    const flow = record(() => {
      tagContact({ tier: attr("tier"), campaign: "spring" });
      disconnect();
    });

    expect(actionOf(flow, "TagContact").Parameters).toEqual({
      Tags: { tier: "$.Attributes.tier", campaign: "spring" },
    });
  });

  it("streams only the customer's audio, in both directions by default", () => {
    // Connect supports no other participant type or media type, so neither is a parameter.
    const flow = record(() => {
      startMediaStreaming();
      disconnect();
    });

    expect(actionOf(flow, "UpdateContactMediaStreamingBehavior").Parameters).toEqual({
      MediaStreamingState: "Enabled",
      Participants: [{ ParticipantType: "Customer", MediaDirections: ["From", "To"] }],
      MediaStreamType: "Audio",
    });
  });

  it("emits the same action type for stopping the stream", () => {
    const flow = record(() => {
      stopMediaStreaming({ directions: ["From"] });
      disconnect();
    });

    const parameters = actionOf(flow, "UpdateContactMediaStreamingBehavior").Parameters as {
      MediaStreamingState: string;
      Participants: Array<{ MediaDirections: string[] }>;
    };
    expect(parameters.MediaStreamingState).toBe("Disabled");
    expect(parameters.Participants[0]?.MediaDirections).toEqual(["From"]);
  });

  it("emits parameterless actions with an empty object", () => {
    const flow = record(() => {
      resumeContact();
      disconnect();
    });
    expect(actionOf(flow, "ResumeContact").Parameters).toEqual({});
  });

  it("rejects empty tag input", () => {
    expect(() =>
      record(() => {
        tagContact({});
      }),
    ).toThrow(/at least one tag/);
    expect(() =>
      record(() => {
        untagContact([]);
      }),
    ).toThrow(/at least one tag key/);
  });
});

describe("iterative messaging", () => {
  it("emits one Messages entry per message and branches on interruption", () => {
    const flow = record(() => {
      playIteratively({
        messages: [{ ssml: "<speak>hold</speak>" }, { text: "thanks for waiting" }],
        interruptFrequencySeconds: 60,
        onInterrupted: () => play("an agent is joining"),
      });
      disconnect();
    });

    const action = actionOf(flow, "MessageParticipantIteratively");
    expect(action.Parameters).toEqual({
      Messages: [{ SSML: "<speak>hold</speak>" }, { Text: "thanks for waiting" }],
      InterruptFrequencySeconds: "60",
    });
    expect(action.Transitions.Conditions?.[0]?.Condition.Operands).toEqual(["MessagesInterrupted"]);
  });

  it("rejects an empty message list", () => {
    expect(() =>
      record(() => {
        playIteratively({ messages: [] });
      }),
    ).toThrow(/at least one message/);
  });
});

describe("lex bots", () => {
  it("branches on intent names with Equals", () => {
    const flow = record(() => {
      connectToLexBot({
        text: "How can I help?",
        bot: { name: "MainBot", region: "us-east-1", alias: "$LATEST" },
        on: { Billing: () => play("billing"), Pharmacy: () => play("pharmacy") },
      });
      disconnect();
    });

    const action = actionOf(flow, "ConnectParticipantWithLexBot");
    expect(action.Parameters).toEqual({
      Text: "How can I help?",
      LexBot: { Name: "MainBot", Region: "us-east-1", Alias: "$LATEST" },
    });
    expect(action.Transitions.Conditions?.map((c) => c.Condition.Operands[0])).toEqual([
      "Billing",
      "Pharmacy",
    ]);
  });
});

describe("terminal and module actions", () => {
  it("emits transferToAgent, endFlowModule as terminal", () => {
    const agent = record(() => {
      transferToAgent();
    });
    expect(actionOf(agent, "TransferContactToAgent").Transitions).toEqual({});

    const module = record(() => {
      endFlowModule();
    });
    expect(actionOf(module, "EndFlowModuleExecution").Transitions).toEqual({});
  });

  it("passes the flow module id through unchanged", () => {
    const flow = record(() => {
      invokeFlowModule("a51ac753-bfd4-4be1-9a87-f3cf367c9f4c:$LATEST");
      disconnect();
    });
    expect(actionOf(flow, "InvokeFlowModule").Parameters).toEqual({
      FlowModuleId: "a51ac753-bfd4-4be1-9a87-f3cf367c9f4c:$LATEST",
    });
    expect(errorsOf(flow, "InvokeFlowModule")).toEqual(["NoMatchingCondition", "NoMatchingError"]);
  });

  it("names the destination explicitly when dequeuing", () => {
    const flow = record(() => {
      dequeueAndTransferToQueue({ queue: "queue-1" });
      disconnect();
    });
    expect(actionOf(flow, "DequeueContactAndTransferToQueue").Parameters).toEqual({
      QueueId: "queue-1",
    });
    expect(errorsOf(flow, "DequeueContactAndTransferToQueue")).toEqual([
      "NoMatchingError",
      "QueueAtCapacity",
    ]);
  });
});
