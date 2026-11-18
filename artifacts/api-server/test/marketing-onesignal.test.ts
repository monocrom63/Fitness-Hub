import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPushMarketingMemberIds,
  buildSmsMarketingPhoneNumbers,
  isSmsMarketingEligible,
  requiresPaidMarketingPlan,
  type MarketingChannelRecipient,
} from "../src/lib/marketing-onesignal";

test("only SMS-bearing sends require the Fiudia marketing subscription", () => {
  assert.equal(requiresPaidMarketingPlan("push"), false);
  assert.equal(requiresPaidMarketingPlan("sms"), true);
  assert.equal(requiresPaidMarketingPlan("both"), true);
});

test("SMS marketing needs its own consent and a valid international number", () => {
  const recipients: MarketingChannelRecipient[] = [
    { id: 1, phone: "+491701234567", marketingConsent: 1, smsConsent: 0 },
    { id: 2, phone: "+491701234568", marketingConsent: 0, smsConsent: 1 },
    { id: 3, phone: "01701234569", marketingConsent: 1, smsConsent: 1 },
    { id: 4, phone: "+491701234570", marketingConsent: 1, smsConsent: 1 },
  ];

  assert.deepEqual(buildSmsMarketingPhoneNumbers(recipients), ["+491701234568", "+491701234570"]);
  assert.equal(isSmsMarketingEligible(recipients[0]), false);
  assert.equal(isSmsMarketingEligible(recipients[1]), true);
});

test("push marketing continues to use the existing marketing consent", () => {
  const recipients: MarketingChannelRecipient[] = [
    { id: 1, phone: "+491701234567", marketingConsent: 1, smsConsent: 0 },
    { id: 2, phone: "+491701234568", marketingConsent: 0, smsConsent: 1 },
  ];

  assert.deepEqual(buildPushMarketingMemberIds(recipients), [1]);
});
