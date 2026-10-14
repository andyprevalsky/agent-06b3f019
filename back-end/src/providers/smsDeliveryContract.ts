/** The provider limit applies to the complete SMS body, including tracking URLs. */
export const SMS_MAX_BODY_CHARACTERS = 1600;

export const SMS_DELIVERY_INSTRUCTIONS = `Surge SMS message bodies must be at most ${SMS_MAX_BODY_CHARACTERS} characters in total, including all text, spaces, line breaks, and URLs. Keep messages concise while preserving the facts and links the user needs. If delivery is rejected, read the actual delivery error, correct the message, and retry. A rejected message was not sent; do not claim delivery until the send succeeds.`;
