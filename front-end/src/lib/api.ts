import { supabase } from './supabase';

// API Configuration
// Default to localhost for development, can be overridden with VITE_BACKEND_API_URL
const API_BASE_URL = import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001';
const API_BASE_WITH_PATH = API_BASE_URL.endsWith('/api') ? API_BASE_URL : `${API_BASE_URL}/api`;

// Helper function to get auth headers
async function getAuthHeaders() {
  const session = await supabase.auth.getSession();
  const token = session.data.session?.access_token;
  
  if (!token) {
    throw new Error('Not authenticated');
  }

  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

// Types
export interface Agent {
  agent_id: string;
  goal: string;
  progress: number;
  status: 'STARTING_UP' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'FAILED';
  status_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentDetail extends Agent {
  verifier: {
    type: 'FLOAT_LLM_JUDGE';
    llm_judge_prompt: string;
  } | null;
  tools: Tool[];
}

export interface Tool {
  id: string;
  name: string;
  description: string | null;
}

export interface Message {
  message_id: string;
  timestamp: string;
  text: string;
  role: 'SYSTEM' | 'AGENT' | 'USER' | 'TOOL' | 'STATUS';
}

export interface CreateAgentPayload {
  goal: string;
  tool_ids: string[];
  verifier: {
    type: 'FLOAT_LLM_JUDGE';
    llm_judge_prompt: string;
  };
}

// API Functions

// Get all agents
export async function getAllAgents(): Promise<Agent[]> {
  const headers = await getAuthHeaders();
  
  const response = await fetch(`${API_BASE_WITH_PATH}/agents`, {
    headers,
  });

  if (!response.ok) {
    throw new Error('Failed to fetch agents');
  }

  const data = await response.json();
  return data.agents;
}

// Get agent details with messages
export async function getAgent(agentId: string, cursor?: string): Promise<{
  agent: AgentDetail;
  messages: Message[];
  pagination: {
    next_cursor: string | null;
    has_more: boolean;
  };
}> {
  const headers = await getAuthHeaders();
  const url = cursor 
    ? `${API_BASE_WITH_PATH}/agents/${agentId}?cursor=${cursor}`
    : `${API_BASE_WITH_PATH}/agents/${agentId}`;
  
  const response = await fetch(url, {
    headers,
  });

  if (!response.ok) {
    throw new Error('Failed to fetch agent');
  }

  return await response.json();
}

// Create a new agent
export async function createAgent(payload: CreateAgentPayload): Promise<Agent> {
  const headers = await getAuthHeaders();
  
  const response = await fetch(`${API_BASE_WITH_PATH}/agents`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create agent');
  }

  return await response.json();
}

// Post a message to an agent
export async function postMessage(agentId: string, message: string): Promise<Message> {
  const headers = await getAuthHeaders();
  
  const response = await fetch(`${API_BASE_WITH_PATH}/agents/${agentId}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to post message');
  }

  return await response.json();
}

// Delete an agent
export async function deleteAgent(agentId: string): Promise<void> {
  const headers = await getAuthHeaders();
  
  const response = await fetch(`${API_BASE_WITH_PATH}/agents/${agentId}`, {
    method: 'DELETE',
    headers,
  });

  if (!response.ok) {
    throw new Error('Failed to delete agent');
  }
}

// Format LLM judge prompt
export async function formatLLMJudgePrompt(text: string): Promise<string> {
  const headers = await getAuthHeaders();
  
  const response = await fetch(`${API_BASE_WITH_PATH}/format-llm-judge-prompt`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const error = await response.json();
    // Show more detailed error if available
    const errorMessage = error.details || error.error || 'Failed to format prompt';
    throw new Error(errorMessage);
  }

  const data = await response.json();
  return data.text;
}

// Get all available tools
export async function getTools(): Promise<Tool[]> {
  const headers = await getAuthHeaders();
  
  const response = await fetch(`${API_BASE_WITH_PATH}/tools`, {
    headers,
  });

  if (!response.ok) {
    throw new Error('Failed to fetch tools');
  }

  const data = await response.json();
  return data.tools;
}

