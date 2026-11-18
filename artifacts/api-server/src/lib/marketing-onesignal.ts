export type MarketingChannelRecipient = {
  id: number;
  phone: string | null;
  marketingConsent: number;
  smsConsent: number;
};

const E164_PHONE = /^\+[1-9]\d{7,14}$/;

export function isSmsMarketingEligible(recipient: Pick<MarketingChannelRecipient, "phone" | "smsConsent">) {
  return recipient.smsConsent === 1 && !!recipient.phone && E164_PHONE.test(recipient.phone.trim());
}

export function buildSmsMarketingPhoneNumbers(recipients: readonly MarketingChannelRecipient[]) {
  return recipients
    .filter(isSmsMarketingEligible)
    .map((recipient) => recipient.phone!.trim());
}

export function buildPushMarketingMemberIds(recipients: readonly MarketingChannelRecipient[]) {
  return recipients.filter((recipient) => recipient.marketingConsent === 1).map((recipient) => recipient.id);
}
