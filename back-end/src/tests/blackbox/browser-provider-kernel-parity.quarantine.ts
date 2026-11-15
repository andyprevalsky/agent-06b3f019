/** browser-provider live probe: only the Kernel parity call is quarantined; every other live case
 * in the domain still fails the gate. Bound to the domain unit the runner reports. */
import { quarantine } from '../helpers/quarantine';

export const quarantinedKernelParity = (fn: () => Promise<void>) => {
  const kernelParityUnit = 'browser-provider';
  return quarantine(
    {
      since: '2026-11-15',
      repair: 'https://boxes.dev/thread/ph7af24jetqdjbjrdfqhnf9f6x8j8mqc',
      error:
        'FAIL live Kernel provider parity: /rotate-proxy 500: {"error":"page.goto: Timeout 30000ms exceeded.',
      evidence:
        '.context/deploy-pipeline/attempts/4/final/live-probes (PR2250 FLAKY 4294219f; Kernel residential proxy rotate navigation timeout, passed on rerun)',
    },
    fn,
    { unit: kernelParityUnit }
  );
};
