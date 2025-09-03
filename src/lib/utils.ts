import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function isEarlyAccessEnabled(): boolean {
  // Temporarily force Early Access on regardless of query params
  return true;
}
