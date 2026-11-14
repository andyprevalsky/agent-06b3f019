/**
 * Git branch name rule shared by every repo default-branch input (projects and
 * GitHub repo connections): trimmed, bounded, no leading '-', no '..' or '//',
 * no trailing '.' or '/'.
 */
import { z } from 'zod';

export const githubBranchSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+(?<![./])$/, 'invalid branch name');
