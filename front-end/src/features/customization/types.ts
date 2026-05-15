import type { ReactNode } from 'react';

export interface CustomizationData {
  systemName: string;
  profilePicture: string | null;
  customSystemPrompt: string;
}

export interface SystemCustomizationProps {
  data: CustomizationData;
  onChange: (data: CustomizationData) => void;
  isLoading?: boolean;
  compact?: boolean;
  promptReplacement?: ReactNode;
}
