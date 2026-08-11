/**
 * What a Lambda actually receives.
 *
 * A flow does not invoke a handler with its parameters. It sends a `ContactFlowEvent`, and the
 * parameters are one small part of it — so that is what the handler is given, whole. The library's job
 * here is only to type it: `Details.Parameters` carries the call site's input type, and everything
 * Connect sends alongside it is reachable and typed rather than hidden behind a convenience view.
 *
 * The payload below is a real one, captured from a Guide contact.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import type { ConnectHandler, ContactFlowEvent } from "../src/index.js";

const captured = {
  Details: {
    ContactData: {
      Attributes: { Document: "DMS123456", DocumentLink: "dms:///DMS123456" },
      AwsRegion: "us-east-1",
      Channel: "CHAT",
      ContactId: "89426906-bb03-4558-b7ae-cb71a933be9c",
      CustomerEndpoint: null,
      CustomerId: null,
      Description: "Please complete the initial review",
      InitialContactId: "89426906-bb03-4558-b7ae-cb71a933be9c",
      InitiationMethod: "API",
      InstanceARN:
        "arn:aws:connect:us-east-1:422331085735:instance/798b054f-23ed-4cab-8063-0724acf07b30",
      LanguageCode: "en-US",
      MediaStreams: { Customer: { Audio: {} } },
      Name: "RPH1 for John Smith - 4 Rxs",
      PreviousContactId: "89426906-bb03-4558-b7ae-cb71a933be9c",
      Queue: null,
      References: {},
      RelatedContactId: "736c7ea2-3ba3-42e9-8001-9abc2dbf48a2",
      SegmentAttributes: {
        "connect:Subtype": {
          ValueArn: null,
          ValueInteger: null,
          ValueList: null,
          ValueMap: null,
          ValueString: "connect:Guide",
        },
      },
      SystemEndpoint: null,
      Tags: { "aws:connect:instanceId": "798b054f-23ed-4cab-8063-0724acf07b30" },
    },
    Parameters: { phone: "+15555550123" },
  },
  Name: "ContactFlowEvent",
} as unknown as ContactFlowEvent<{ phone: string }>;

describe("the ContactFlowEvent a handler receives", () => {
  it("types the parameters the flow passed", async () => {
    const handler = async (event: ContactFlowEvent<{ phone: string }>) => ({
      got: event.Details.Parameters.phone,
    });

    expect(await handler(captured)).toEqual({ got: "+15555550123" });
  });

  it("reaches everything else Connect sent, typed", () => {
    const contact = captured.Details.ContactData;

    // Attributes set earlier in the flow, and the fields the AWS reference does not list.
    expect(contact.Attributes.Document).toBe("DMS123456");
    expect(contact.Channel).toBe("CHAT");
    expect(contact.InitiationMethod).toBe("API");
    expect(contact.AwsRegion).toBe("us-east-1");
    expect(contact.Tags?.["aws:connect:instanceId"]).toBe("798b054f-23ed-4cab-8063-0724acf07b30");
    expect(contact.SegmentAttributes?.["connect:Subtype"]?.ValueString).toBe("connect:Guide");
    // Null rather than absent, which is why these are nullable.
    expect(contact.CustomerEndpoint).toBeNull();
    expect(contact.Queue).toBeNull();
    expect(captured.Name).toBe("ContactFlowEvent");
  });

  it("is an ordinary Lambda handler", () => {
    // Nothing wraps it, so what is deployed is what was written. `context` is Lambda's own.
    const handler: ConnectHandler<{ phone: string }, { tier: string }> = async (event, context) => {
      expectTypeOf(event).toEqualTypeOf<ContactFlowEvent<{ phone: string }>>();
      expectTypeOf(event.Details.Parameters).toEqualTypeOf<{ phone: string }>();
      expectTypeOf(context.awsRequestId).toEqualTypeOf<string>();
      return { tier: "gold" };
    };

    expectTypeOf(handler).parameters.toMatchTypeOf<
      [ContactFlowEvent<{ phone: string }>, unknown]
    >();
  });
});
