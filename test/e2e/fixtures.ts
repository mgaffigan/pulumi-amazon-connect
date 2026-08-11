/**
 * Flows the end-to-end test publishes to a real Amazon Connect instance.
 *
 * Between them they use every action this library emits. They exist to be *accepted* rather than to
 * be sensible call experiences — `CreateContactFlow` performs full server-side validation, so a
 * successful publish is the only proof that a shape is right. The AWS reference has been wrong about
 * nine shapes so far, each caught here.
 *
 * Actions are grouped by flow type because Connect restricts several of them: `EndFlowExecution` is
 * queue/whisper-only, `TransferContactToQueue` is inbound/transfer-only, and a third-party transfer's
 * failure outcomes are rejected in an agent transfer flow.
 */

import type { ContactFlowType } from "../../src/index.js";
import {
  attr,
  checkHoursOfOperation,
  checkOutboundCallStatus,
  checkQueueMetric,
  checkStaffing,
  checkVoiceId,
  collectInput,
  completeOutboundCall,
  connectToLexBot,
  createCallbackContact,
  createTask,
  createWisdomSession,
  dequeueAndTransferToQueue,
  disconnect,
  endFlow,
  external,
  type FlowFragment,
  flowDistribute,
  flowIf,
  flowLoop,
  flowSwitch,
  getDigit,
  getMetricData,
  goto,
  invokeFlowModule,
  label,
  onError,
  play,
  playIteratively,
  resumeContact,
  setAttributes,
  setCallbackNumber,
  setContactData,
  setEventFlow,
  setFlowAttributes,
  setLogging,
  setMediaProcessing,
  setPreviousParticipantState,
  setQueue,
  setRecordingAndAnalytics,
  setRecordingBehavior,
  setRoutingBehavior,
  setRoutingCriteria,
  setVoice,
  showView,
  startMediaStreaming,
  startOutboundChat,
  startVoiceIdStream,
  stopMediaStreaming,
  system,
  tagContact,
  transferToAgent,
  transferToFlow,
  transferToQueue,
  transferToThirdParty,
  untagContact,
  wait,
  withScope,
} from "../../src/index.js";

/** Real identifiers from the target instance, discovered at test time. */
export interface E2eContext {
  queueArn: string;
  /** Account id, for composing ARNs of resources that need not exist. */
  accountId: string;
  /** Any existing flow, used wherever an action needs to reference one. */
  flowArn: string;
}

/** Whisper and hold flows reject a disconnect, so those fixtures end differently. */
export type FixtureTerminal = "DisconnectParticipant" | "EndFlowExecution";

export interface E2eFixture {
  /** Defaults to a disconnect. */
  endWith?: FixtureTerminal;
  name: string;
  type: ContactFlowType;
  /** Which actions this flow is here to prove. */
  covers: string[];
  build(ctx: E2eContext): FlowFragment;
  onError: FlowFragment;
}

function apologize(): void {
  withScope("apology", () => {
    play("Sorry, something went wrong.");
    disconnect();
  });
}

export const fixtures: E2eFixture[] = [
  {
    name: "core",
    type: "CONTACT_FLOW",
    covers: [
      "MessageParticipant",
      "GetParticipantInput",
      "UpdateContactAttributes",
      "UpdateFlowAttributes",
      "Compare",
      "Loop",
      "Wait",
      "UpdateContactTargetQueue",
      "TransferContactToQueue",
      "UpdateFlowLoggingBehavior",
      "DisconnectParticipant",
    ],
    onError: apologize,
    build: (ctx) => () => {
      setLogging("Enabled");
      play(`Thanks for calling from ${system.customerEndpoint.address}.`);

      withScope("collect", () => {
        setFlowAttributes({ attempts: "1" });
        setAttributes({ greeted: "true" });
      });

      onError(() => {
        flowIf(
          { op: "startsWith", left: attr("accountNumber"), right: "9" },
          {
            ifTrue: () => setAttributes({ tier: "gold" }),
            ifFalse: () => setAttributes({ tier: "standard" }),
          },
        );

        flowSwitch(attr("tier"), {
          cases: [
            { value: "gold", run: () => play("Connecting you now.") },
            { value: "standard", run: () => play("Please hold.") },
          ],
          otherwise: () => play("Let me find someone."),
        });

        flowLoop(2, () => {
          play("Still checking, thanks for your patience.");
          wait(1);
        });

        getDigit({
          text: "Press 1 to hold, or 2 to hang up.",
          timeoutSeconds: 5,
          options: {
            1: () => {
              setQueue({ queue: ctx.queueArn });
              transferToQueue(undefined, { onQueueAtCapacity: () => play("We're full.") });
            },
            2: () => {
              play("Goodbye.");
              disconnect();
            },
          },
          onTimeout: () => play("No input received."),
        });
      }, apologize);

      disconnect();
    },
  },
  {
    name: "inbound-extras",
    type: "CONTACT_FLOW",
    covers: [
      "UpdateContactEventHooks",
      "UpdateContactRecordingBehavior",
      "UpdateContactRecordingAndAnalyticsBehavior",
      "CheckHoursOfOperation",
      "CheckMetricData",
      "DistributeByPercentage",
      "UpdateContactRoutingBehavior",
      "UpdateContactCallbackNumber",
      "CreateCallbackContact",
      "ConnectParticipantWithLexBot",
      "CreateTask",
      "TransferParticipantToThirdParty",
      "ShowView",
    ],
    onError: apologize,
    build: (ctx) => () => {
      setRecordingBehavior({ participants: [] });
      setEventFlow("CustomerQueue", ctx.flowArn);
      setEventFlow("CustomerHold", ctx.flowArn);

      setRecordingAndAnalytics({
        channel: "voice",
        recording: { participants: ["Agent", "Customer"], ivrRecording: "Enabled" },
        analytics: {
          language: "en-US",
          modes: ["RealTime"],
          summaryModes: ["PostContact"],
          sentiment: true,
        },
      });

      checkHoursOfOperation({
        ifOpen: () => {
          checkQueueMetric({
            metric: "OldestContactInQueueAgeSeconds",
            when: [
              {
                op: "greaterThan",
                value: 300,
                run: () => {
                  setCallbackNumber(system.customerEndpoint.address, {
                    onInvalid: () => play("That number won't work."),
                  });
                  createCallbackContact({
                    initialDelaySeconds: 60,
                    retryDelaySeconds: 600,
                    maximumAttempts: 3,
                  });
                  disconnect();
                },
              },
            ],
            otherwise: () => {
              flowDistribute({
                branches: [
                  { percent: 10, run: () => play("You're in the pilot experience.") },
                  { percent: 90, run: () => play("Connecting you now.") },
                ],
              });
              setRoutingBehavior({ queuePriority: 1 });
              transferToQueue({ queue: ctx.queueArn });
            },
          });
        },
        ifClosed: () => {
          withScope("afterhours", () => {
            // A view id that does not exist is fine: Connect validates the shape, not the reference.
            showView({
              viewId: "00000000-0000-0000-0000-000000000000",
              on: { Back: () => play("Going back.") },
            });

            connectToLexBot({
              text: "We're closed. Would you like a callback?",
              bot: { name: "AfterHoursBot", region: "us-east-1", alias: "$LATEST" },
              on: {
                Callback: () => {
                  createTask({
                    name: "After hours callback request",
                    flowId: ctx.flowArn,
                    attributes: { phone: system.customerEndpoint.address },
                  });
                  disconnect();
                },
                Disconnect: () => disconnect(),
              },
              onNoMatch: () => play("I didn't catch that."),
            });

            // Keeping control is what makes the failure outcomes available.
            transferToThirdParty({
              phoneNumber: "+15555550124",
              connectionTimeoutSeconds: 20,
              continueFlowExecution: true,
              onTimeout: () => play("No answer."),
              onCallFailed: () => play("The call failed."),
            });
          });
        },
      });

      disconnect();
    },
  },
  {
    name: "queue",
    type: "CUSTOMER_QUEUE",
    covers: [
      "MessageParticipantIteratively",
      "DequeueContactAndTransferToQueue",
      "EndFlowExecution",
    ],
    onError: apologize,
    build: (ctx) => () => {
      playIteratively({
        messages: [
          { ssml: '<speak>You are on hold <break time="30s"/></speak>' },
          { text: "Thanks for your patience." },
        ],
        interruptFrequencySeconds: 60,
        onInterrupted: () => play("An agent is joining."),
      });

      checkStaffing({
        metric: "NumberOfAgentsAvailable",
        otherwise: () => dequeueAndTransferToQueue({ queue: ctx.queueArn }),
      });

      // Valid only in queue and whisper flows, which is why it is exercised here.
      endFlow();
    },
  },
  {
    name: "transfer",
    type: "AGENT_TRANSFER",
    covers: [
      "UpdatePreviousContactParticipantState",
      "TransferParticipantToThirdParty",
      "TransferContactToAgent",
    ],
    onError: apologize,
    build: () => () => {
      setPreviousParticipantState("AgentOnHold");
      // No failure handlers here: an agent transfer flow rejects those outcomes.
      transferToThirdParty({
        phoneNumber: "+15555550123",
        connectionTimeoutSeconds: 30,
        continueFlowExecution: false,
        dtmfDigits: attr("dialCode"),
      });
      setPreviousParticipantState("OffHold");
      transferToAgent();
    },
  },
  {
    name: "contact-settings",
    type: "CONTACT_FLOW",
    covers: [
      "UpdateContactTextToSpeechVoice",
      "TagContact",
      "UntagContact",
      "UpdateContactMediaStreamingBehavior",
      "CreateWisdomSession",
      "ResumeContact",
      "GetParticipantInput",
      "Wait",
      "Compare",
      "ConnectParticipantWithLexBot",
    ],
    onError: apologize,
    build: () => () => {
      setVoice({ voice: "Danielle", engine: "neural", style: "Conversational" });

      // Undocumented but accepted: prompt-skip control, encrypted input, the KeyExists operator,
      // Lex session attributes, analytics on the recording action, and the Wait continue mode.
      play({ text: "Recording is off for the next step.", skipWhenDtmfBuffered: false });

      setRecordingBehavior({
        participants: ["Agent", "Customer"],
        analytics: {
          language: "en-US",
          voiceModes: ["RealTime"],
          summaryModes: ["PostContact"],
          sentiment: true,
          redaction: true,
        },
      });

      collectInput({
        text: "Enter your card number.",
        timeoutSeconds: 6,
        maxLength: 16,
        encryption: { keyId: "e2e-key", publicKey: "-----BEGIN PUBLIC KEY-----" },
      });

      flowIf(
        { op: "keyExists", left: external<{ tier: string }>("customer"), right: "tier" },
        { ifTrue: () => play("Tier present."), ifFalse: () => play("No tier.") },
      );

      connectToLexBot({
        text: "Anything else?",
        bot: { name: "E2eBot", region: "us-east-1", alias: "$LATEST" },
        sessionAttributes: { source: "e2e" },
        on: { Done: () => play("Thanks.") },
      });

      wait({ seconds: 30, minimumSeconds: 5, onContinue: () => play("Moving on.") });

      tagContact({ campaign: "e2e-verification", tier: attr("tier") });
      untagContact(["campaign"]);

      startMediaStreaming({ directions: ["From", "To"] });
      stopMediaStreaming();

      // An assistant ARN that does not resolve is fine: Connect validates shape, not existence.
      createWisdomSession(
        "arn:aws:wisdom:us-east-1:000000000000:assistant/00000000-0000-0000-0000-000000000000",
      );

      resumeContact();
      disconnect();
    },
  },
  {
    name: "routing-and-voiceid",
    type: "CONTACT_FLOW",
    covers: [
      "GetMetricData",
      "CheckVoiceId",
      "StartVoiceIdStream",
      "UpdateContactData",
      "UpdateContactRoutingCriteria",
      "UpdateContactMediaProcessing",
      "StartOutboundChatContact",
    ],
    onError: apologize,
    build: (ctx) => () => {
      getMetricData({ channel: "Voice" });

      setContactData({ name: "E2E verification", languageCode: "en-US" });

      // Voice ID moves as a complete set: three switches and three thresholds together.
      setContactData({
        voiceId: {
          enabled: true,
          authenticationThreshold: 90,
          authenticationResponseTime: 7,
          fraudThreshold: 50,
        },
      });

      startVoiceIdStream();
      checkVoiceId({
        check: "voiceAuthentication",
        onAuthenticated: () => play("Verified."),
        onNotAuthenticated: () => play("Could not verify."),
        onInconclusive: () => play("Inconclusive."),
      });

      setRoutingCriteria({
        steps: [
          {
            require: [{ name: "Language", value: "Spanish", minimumLevel: 4 }],
            expiresAfterSeconds: 30,
          },
          { require: [{ name: "Language", value: "Spanish", minimumLevel: 2 }] },
        ],
      });

      setMediaProcessing({
        lambdaArn: `arn:aws:lambda:us-east-1:${ctx.accountId}:function:e2e-processor`,
        onChannelMismatch: () => play("Not a chat contact."),
      });

      startOutboundChat({
        fromPhoneNumberArn: `arn:aws:connect:us-east-1:${ctx.accountId}:phone-number/00000000-0000-0000-0000-000000000000`,
        toPhoneNumber: "+15555550123",
        flowArn: ctx.flowArn,
        initialMessage: "Here is the link you asked for.",
      });

      disconnect();
    },
  },
  {
    name: "outbound-whisper",
    type: "OUTBOUND_WHISPER",
    covers: ["CompleteOutboundCall", "CheckOutboundCallStatus"],
    endWith: "EndFlowExecution",
    // A whisper flow cannot disconnect, so its handler ends the flow instead.
    onError: () => {
      play("Sorry, something went wrong.");
      endFlow();
    },
    build: () => () => {
      // Only valid before the outbound number is dialled, which is what a whisper flow precedes.
      completeOutboundCall();
      checkOutboundCallStatus({
        onAnswered: () => play("Hello."),
        onVoicemailBeep: () => endFlow(),
      });
      endFlow();
    },
  },
  {
    name: "module-caller",
    type: "CONTACT_FLOW",
    covers: ["InvokeFlowModule", "TransferToFlow"],
    onError: apologize,
    build: (ctx) => () => {
      invokeFlowModule("00000000-0000-0000-0000-000000000000:$LATEST", {
        onNoMatch: () => play("The module had nothing for us."),
      });
      // Control does not come back from a transfer, so nothing follows it.
      transferToFlow(ctx.flowArn, { onError: () => disconnect() });
    },
  },
  {
    name: "jumps",
    type: "CONTACT_FLOW",
    // No new action types: what this proves is that Connect accepts a graph that is not a straight
    // read — a self-loop back into a menu, and an edge out of a branch into a later point.
    covers: [],
    build: () => () => {
      const done = label("done");
      const menu = label("menu");
      getDigit({
        text: "Press 1 to continue, or 2 to hear this again.",
        timeoutSeconds: 5,
        options: {
          "1": () => goto(done),
          "2": () => goto(menu),
        },
        onNoMatch: () => goto(menu),
      });
      done.here();
      play("Thanks.");
      disconnect();
    },
    onError: apologize,
  },
];
