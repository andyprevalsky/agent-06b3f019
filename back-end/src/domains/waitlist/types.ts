export interface JoinWaitlistInput {
  name: string;
  email: string;
  variant?: string | null;
}

export interface JoinWaitlistResult {
  success: true;
  message: string;
  alreadyRegistered: boolean;
}
