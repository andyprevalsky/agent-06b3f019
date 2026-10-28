export type AgentSpeed = 'standard' | 'fast' | 'ultrafast';

export function agentSpeedForLevel(level: 'normal' | 'fast' | 'ultra'): AgentSpeed {
  return { normal: 'standard', fast: 'fast', ultra: 'ultrafast' }[level] as AgentSpeed;
}
