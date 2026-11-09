import { constants } from 'node:os';

export type ChildTermination = {
  exitCode: number;
  label: string;
  signal: NodeJS.Signals | null;
};

/** Node reports a signalled child as `code === null`, so keep the signal rather than a bare 128. */
export function describeChildTermination(
  code: number | null,
  signal: NodeJS.Signals | null
): ChildTermination {
  if (signal !== null) {
    return { exitCode: 128 + constants.signals[signal], label: `signal ${signal}`, signal };
  }
  const exitCode = code ?? 1;
  return { exitCode, label: `exit code ${exitCode}`, signal: null };
}
