import type {
  AgentForPropagation,
  CredentialInventoryEntry,
  CredentialRef,
  MessageForClassification,
} from './credentialPropagationClassifier';

function markdownFence(value: string, language = ''): string {
  return `\`\`\`${language}\n${value.replace(/```/g, '\\`\\`\\`')}\n\`\`\``;
}

function jsonMarkdown(value: unknown): string {
  return markdownFence(JSON.stringify(value, null, 2), 'json');
}

function messageEvidenceMarkdown(messages: MessageForClassification[]): string {
  if (messages.length === 0) return '_No browser-run messages were recorded._';

  return messages
    .map((message, index) =>
      [
        `## Message ${index + 1}`,
        '',
        `Role: ${message.role}`,
        `Timestamp: ${message.timestamp ?? 'not present'}`,
        '',
        '### Content',
        markdownFence(message.text || '_empty_'),
        '',
        '### Metadata',
        jsonMarkdown(message.metadata ?? null),
      ].join('\n')
    )
    .join('\n\n');
}

export function buildCredentialClassifierSystemPrompt(): string {
  return [
    'You classify credential outcomes after a browser automation run.',
    '',
    '# Expected Input',
    '',
    'The user message is markdown with these sections:',
    '- Task: the root goal, browser-run terminal status, and terminal message.',
    '- Credential Inventory: every credential available to classify, with database ids and labels when known.',
    '- Full Message Evidence: all browser-run messages in chronological order, including assistant reasoning, tool messages, and metadata.',
    '',
    '# Credential Semantics',
    '',
    'A credential kind=password is a saved browser password. The browser agent sees a secret ref such as `pwd:user@example.com@site#credential-id` in its auth options. When the agent types that ref into a password field, the browser tool decrypts it, submits the real password to the page, and records the database credential id in message metadata as `credential_ref`.',
    '',
    '# Classification Rules',
    '',
    '- Classify each credential independently.',
    '- `auth_failed`: this exact credential was submitted and the site rejected it, expired it, or returned a clear invalid/incorrect credential error.',
    '- `unused`: the credential was available but was never typed, submitted, applied, or otherwise relied on.',
    '- `task_level`: the credential may have been used, but the run failed for navigation, looping, missing submit, max iterations, verifier mismatch, unavailable guest path, or another non-credential reason.',
    '- `unknown`: evidence is insufficient to distinguish credential failure from task-level failure.',
    '- Never mark all credentials failed just because the browser task failed.',
    '- Repeatedly typing the same saved password without a clear rejected-login error is usually `task_level`, not `auth_failed`.',
    '- If a credential is typed but no submit/action follows, do not classify it as `auth_failed`.',
    '',
    'Return JSON only matching the provided schema.',
  ].join('\n');
}

export function buildCredentialClassifierUserPrompt({
  agent,
  messages,
  credentialRefs: _credentialRefs,
  credentialInventory,
}: {
  agent: AgentForPropagation;
  messages: MessageForClassification[];
  credentialRefs: CredentialRef[];
  credentialInventory: CredentialInventoryEntry[];
}): string {
  return [
    '# Task',
    jsonMarkdown({
      goal: agent.goal,
      status: agent.status,
      terminalMessage: agent.statusMessage,
    }),
    '',
    '# Credential Inventory',
    jsonMarkdown(credentialInventory),
    '',
    '# Full Message Evidence',
    messageEvidenceMarkdown(messages),
  ].join('\n');
}
