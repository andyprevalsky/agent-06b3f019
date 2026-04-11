export interface UsageData {
  total: number;
  used: number;
  remaining: number;
  tier: number | null;
}

export interface ModelStats {
  model: string;
  tokens: number;
  percentage: number;
}
