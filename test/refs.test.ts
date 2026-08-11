/**
 * The ambient reference surface.
 *
 * Every path here is a hand-written string that Connect resolves at runtime, and a typo reads empty
 * rather than failing at deploy — so the paths are asserted against the documented ones.
 *
 * @see https://docs.aws.amazon.com/connect/latest/adminguide/connect-attrib-list.html
 */

import { describe, expect, it } from "vitest";
import { isRef, type Ref, segmentAttr, system } from "../src/index.js";

/** Flattens `system` to `dotted.key` → JSONPath, so a whole group is checked in one expectation. */
function paths(node: unknown, prefix = ""): Record<string, string> {
  if (isRef(node)) return { [prefix]: node.path };
  if (typeof node !== "object" || node === null) return {};

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node)) {
    Object.assign(out, paths(value, prefix === "" ? key : `${prefix}.${key}`));
  }
  return out;
}

describe("system", () => {
  it("reads the contact's own identity and endpoints", () => {
    expect(paths(system)).toMatchObject({
      contactId: "$.ContactId",
      initialContactId: "$.InitialContactId",
      previousContactId: "$.PreviousContactId",
      initiationMethod: "$.InitiationMethod",
      channel: "$.Channel",
      instanceArn: "$.InstanceARN",
      awsRegion: "$.AwsRegion",
      languageCode: "$.LanguageCode",
      customerId: "$.CustomerId",
      textToSpeechVoiceId: "$.TextToSpeechVoiceId",
      storedCustomerInput: "$.StoredCustomerInput",
      tags: "$.Tags",
      "customerEndpoint.address": "$.CustomerEndpoint.Address",
      "customerEndpoint.type": "$.CustomerEndpoint.Type",
      "customerEndpoint.displayName": "$.CustomerEndpoint.DisplayName",
      "systemEndpoint.address": "$.SystemEndpoint.Address",
      "systemEndpoint.type": "$.SystemEndpoint.Type",
      "systemEndpoint.displayName": "$.SystemEndpoint.DisplayName",
      "additionalEmailRecipients.ccList": "$.AdditionalEmailRecipients.CcList",
      "additionalEmailRecipients.toList": "$.AdditionalEmailRecipients.ToList",
      "queue.name": "$.Queue.Name",
      "queue.arn": "$.Queue.ARN",
      "queue.outboundCallerId.address": "$.Queue.OutboundCallerId.Address",
      "queue.outboundCallerId.type": "$.Queue.OutboundCallerId.Type",
      "task.contactId": "$.Task.ContactId",
      "task.name": "$.Name",
      "task.description": "$.Description",
    });
  });

  it("reads the agent and the participants' capabilities", () => {
    expect(paths(system)).toMatchObject({
      "agent.userName": "$.Agent.UserName",
      "agent.firstName": "$.Agent.FirstName",
      "agent.lastName": "$.Agent.LastName",
      "agent.arn": "$.Agent.ARN",
      "capabilities.agent.screenShare": "$.Capabilities.Agent.ScreenShare",
      "capabilities.agent.video": "$.Capabilities.Agent.Video",
      "capabilities.customer.screenShare": "$.Capabilities.Customer.ScreenShare",
      "capabilities.customer.video": "$.Capabilities.Customer.Video",
    });
  });

  it("reads telephony metadata under the carrier's own header names", () => {
    expect(paths(system.media)).toEqual({
      initialMessage: "$.Media.InitialMessage",
      "sip.chargeInfo": "$.Media.Sip.Headers.P-Charge-Info",
      "sip.from": "$.Media.Sip.Headers.From",
      "sip.to": "$.Media.Sip.Headers.To",
      "sip.isupOli": "$.Media.Sip.Headers.ISUP-OLI",
      "sip.jip": "$.Media.Sip.Headers.JIP",
      "sip.hopCounter": "$.Media.Sip.Headers.Hop-Counter",
      "sip.originatingSwitch": "$.Media.Sip.Headers.Originating-Switch",
      "sip.originatingTrunk": "$.Media.Sip.Headers.Originating-Trunk",
      "sip.callForwardingIndicator": "$.Media.Sip.Headers.Call-Forwarding-Indicator",
      "sip.callingPartyAddress": "$.Media.Sip.Headers.Calling-Party-Address",
      "sip.calledPartyAddress": "$.Media.Sip.Headers.Called-Party-Address",
      "sip.siprecMetadata": "$.Media.Sip.SiprecMetadata",
    });
  });

  it("reads the customer audio stream and the Q in Connect session", () => {
    expect(paths(system.mediaStreams)).toEqual({
      "customer.audio.streamArn": "$.MediaStreams.Customer.Audio.StreamARN",
      "customer.audio.startTimestamp": "$.MediaStreams.Customer.Audio.StartTimestamp",
      "customer.audio.stopTimestamp": "$.MediaStreams.Customer.Audio.StopTimestamp",
      "customer.audio.startFragmentNumber": "$.MediaStreams.Customer.Audio.StartFragmentNumber",
    });
    expect(system.wisdom.sessionArn.path).toBe("$.Wisdom.SessionArn");
  });

  it("reads what a Lex bot reported beyond the intent", () => {
    expect(paths(system.lex)).toEqual({
      intentName: "$.Lex.IntentName",
      intentConfidenceScore: "$.Lex.IntentConfidence.Score",
      dialogState: "$.Lex.DialogState",
      "sentiment.label": "$.Lex.SentimentResponse.Label",
      "sentiment.scores.positive": "$.Lex.SentimentResponse.Scores.Positive",
      "sentiment.scores.negative": "$.Lex.SentimentResponse.Scores.Negative",
      "sentiment.scores.mixed": "$.Lex.SentimentResponse.Scores.Mixed",
      "sentiment.scores.neutral": "$.Lex.SentimentResponse.Scores.Neutral",
    });

    expect(system.lex.slot("accountNumber").path).toBe("$.Lex.Slots.accountNumber");
    expect(system.lex.sessionAttribute("tier").path).toBe("$.Lex.SessionAttributes.tier");
    expect(paths(system.lex.alternativeIntent("Billing"))).toEqual({
      intentName: "$.Lex.AlternativeIntents.Billing.IntentName",
      confidenceScore: "$.Lex.AlternativeIntents.Billing.IntentConfidence.Score",
      slots: "$.Lex.AlternativeIntents.Billing.Slots",
    });
  });

  it("brackets the colon-namespaced segment attributes", () => {
    expect(paths(system.segment)).toMatchObject({
      subtype: "$.SegmentAttributes['connect:Subtype']",
      direction: "$.SegmentAttributes['connect:Direction']",
      emailSubject: "$.SegmentAttributes['connect:EmailSubject']",
      sesSpamVerdict: "$.SegmentAttributes['connect:X-SES-SPAM-VERDICT']",
      "customerAuthentication.status":
        "$.SegmentAttributes['connect:CustomerAuthentication']['Status']",
      "customerAuthentication.method":
        "$.SegmentAttributes['connect:CustomerAuthentication']['AuthenticationMethod']",
    });
  });

  it("keys a reference by its user-defined name", () => {
    expect(paths(system.reference("caseUrl"))).toEqual({
      value: "$.References.caseUrl.Value",
      type: "$.References.caseUrl.Type",
    });
    expect(() => system.reference("case.url")).toThrow(/not valid in a JSONPath/);
  });

  it("interpolates into a string parameter as its path", () => {
    expect(`Calling from ${system.customerEndpoint.address}`).toBe(
      "Calling from $.CustomerEndpoint.Address",
    );
  });

  it("exposes only paths Connect can resolve", () => {
    for (const [key, path] of Object.entries(paths(system))) {
      expect(path, key).toMatch(/^\$\.[A-Za-z]/);
    }
  });
});

describe("segmentAttr", () => {
  it("brackets a predefined attribute of your own", () => {
    expect(segmentAttr("priority").path).toBe("$.SegmentAttributes['priority']");
  });

  it("carries the value type for a comparison", () => {
    const expiry: Ref<Record<string, string>> = segmentAttr<Record<string, string>>("expiry");
    expect(expiry.path).toBe("$.SegmentAttributes['expiry']");
  });

  it("rejects a key that would break out of the quoted segment", () => {
    expect(() => segmentAttr("")).toThrow(/must not be empty/);
    expect(() => segmentAttr("it's")).toThrow(/not valid inside a quoted JSONPath segment/);
    expect(() => segmentAttr("a]b")).toThrow(/not valid inside a quoted JSONPath segment/);
  });
});
