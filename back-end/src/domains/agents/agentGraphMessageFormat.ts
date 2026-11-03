export type GraphMessageKind = 'message' | 'question';

/**
 * LLM-visible framing of an inbound agent message (prompt-scoped text): who
 * sent it and how to answer from the recipient's own tool surface.
 */
export function formatInboundAgentMessage(args: {
  senderLabel: string;
  senderId: string;
  recipientKind: 'agent' | 'code';
  account?: boolean;
  kind: GraphMessageKind;
  text: string;
}): string {
  const what = args.kind === 'question' ? 'Question' : 'Message';
  const reply =
    args.account === true
      ? `Reply using the rose-agents CLI in a code session: rose-agents send ${args.senderId} "<message>" --scope account. Use a stable --id for retries.`
      : args.recipientKind === 'code'
        ? `Reply with: rose-agents send ${args.senderId} "<message>"`
        : args.kind === 'question'
          ? 'Answer with send_message_to_agent; if you cannot, ask your parent the same way (agent_id "parent")'
          : 'Reply with send_message_to_agent if a reply is needed';
  return `[${what} from ${args.senderLabel}, agent_id ${args.senderId}. ${reply}]\n\n${args.text}`;
}
