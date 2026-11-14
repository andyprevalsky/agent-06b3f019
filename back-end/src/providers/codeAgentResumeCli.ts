import { codeAgentCliEnvs } from './codeAgentModels';
import { resumeLaunchCliSettings } from './codeAgentResumeConfigStore';
import type { ClaudeCodeSessionOptions } from './codeSessionLaunchOptions';
import { compatibleResumeCliSettings } from './codeAgentResumeConfig';

/** Resolve launch settings once, preserving the same spawn's last recorded configuration. */
export async function codeAgentResumeCliEnvs(
  provider: 'claude' | 'codex',
  agentId: string,
  options: Pick<
    ClaudeCodeSessionOptions,
    'leaseOwner' | 'cliSettings' | 'codeSession' | 'resumeConfig'
  >
) {
  const settings = await resumeLaunchCliSettings(
    agentId,
    provider,
    options.leaseOwner ?? options.codeSession?.leaseOwner,
    compatibleResumeCliSettings(
      provider,
      options.resumeConfig?.source_code_provider,
      options.cliSettings
    )
  );
  return codeAgentCliEnvs(provider, agentId, settings);
}
