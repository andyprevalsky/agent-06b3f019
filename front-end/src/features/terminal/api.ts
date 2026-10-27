/**
 * Terminal feature — API / data-fetching layer.
 *
 * Thin wrappers around shared API functions. Hooks call these;
 * components never call them directly.
 */

import {
  getAllAgents,
  getAgent,
  createAgent as createAgentAPI,
  postMessage as postMessageAPI,
  uploadAttachment as uploadAttachmentAPI,
  resumeAgent as resumeAgentAPI,
  pauseAgent as pauseAgentAPI,
  checkAndRespondToAttentionRequest as checkAttentionAPI,
  fetchAncestors as fetchAncestorsAPI,
  findBlueprintByGoal as findBlueprintAPI,
  submitBlueprintFeedback as submitFeedbackAPI,
  type CreateAgentPayload,
  type FilePointer,
  type BlueprintFeedback,
  type MessageTarget,
} from '@/lib/api';

// ── Agent list ────────────────────────────────────────────────────────────

export async function fetchAgents() {
  return getAllAgents();
}

// ── Agent detail ──────────────────────────────────────────────────────────

export async function fetchAgentDetail(agentId: string) {
  return getAgent(agentId);
}

// ── Agent creation ────────────────────────────────────────────────────────

export async function createAgent(payload: CreateAgentPayload) {
  return createAgentAPI(payload);
}

// ── Messaging ─────────────────────────────────────────────────────────────

export async function postMessage(
  agentId: string,
  message: string,
  attachments?: FilePointer[],
  target?: MessageTarget,
) {
  return postMessageAPI(agentId, message, attachments, target);
}

export async function uploadAttachment(file: File, onProgress?: (progress: number) => void) {
  return uploadAttachmentAPI(file, onProgress);
}

// ── Agent lifecycle ───────────────────────────────────────────────────────

export async function resumeAgent(agentId: string) {
  return resumeAgentAPI(agentId);
}

export async function pauseAgent(agentId: string) {
  return pauseAgentAPI(agentId);
}

// ── Attention requests ────────────────────────────────────────────────────

export async function checkAndRespondToAttention(agentId: string, message: string) {
  return checkAttentionAPI(agentId, message, message);
}

// ── Ancestors ─────────────────────────────────────────────────────────────

export async function fetchAncestors(agentId: string) {
  return fetchAncestorsAPI(agentId);
}

// ── Blueprint feedback ────────────────────────────────────────────────────

export async function findBlueprintByGoal(goal: string) {
  return findBlueprintAPI(goal);
}

export async function submitBlueprintFeedback(
  blueprintId: string,
  feedback: BlueprintFeedback & { agentId: string },
) {
  return submitFeedbackAPI(blueprintId, feedback);
}
