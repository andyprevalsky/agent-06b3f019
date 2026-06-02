export function credentialPropagationLlmDisabled(): boolean {
  return process.env.CREDENTIAL_PROPAGATION_DISABLE_LLM === '1';
}
