import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

// People / Network
export interface Person {
  id: string;
  userId: string;
  firstName: string;
  lastName: string;
  messagesExchanged: number;
  age?: number | null;
  location?: string | null;
  profession?: string | null;
  company?: string | null;
  title?: string | null;
  industry?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
  linkedinUrl?: string | null;
  instagramHandle?: string | null;
  facebookUrl?: string | null;
  twitterHandle?: string | null;
  relation?: string | null;
  communicationFrequency?: string | null;
  relationshipQuality?: string | null;
  contactStatus?: string | null;
  currentBandwidth?: string | null;
  networkOrientation?: string | null;
  totalOnlineReach?: number | null;
  estimatedNetWorthUsd?: number | null;
  estimatedWorldPowerRanking?: number | null;
  notes?: string | null;
  skills?: unknown;
  interests?: unknown;
  embedding?: unknown;
  emailAddresses?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PeoplePaginatedResponse {
  people: Person[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// Get paginated people in user's network
export async function getPeople(
  page = 1,
  limit = 50,
  options?: { sort?: string; sortDirection?: 'asc' | 'desc'; search?: string },
): Promise<PeoplePaginatedResponse> {
  const headers = getAuthHeaders();

  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (options?.sort) params.set('sort', options.sort);
  if (options?.sortDirection) params.set('sortDirection', options.sortDirection);
  if (options?.search) params.set('search', options.search);

  const response = await fetch(`${API_BASE_WITH_PATH}/people?${params}`, {
    headers,
  });

  if (!response.ok) {
    throw new Error('Failed to fetch people');
  }

  return await response.json();
}
