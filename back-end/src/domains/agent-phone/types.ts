export interface AgentPhoneSmsMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  channel: string;
  receivedAt: Date;
  credentialId: string;
  credentialPhone: string;
}
