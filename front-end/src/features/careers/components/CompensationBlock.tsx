/**
 * STATE MACHINE: CompensationBlock
 *
 * This component is stateless.
 *
 * [MOUNTED] --> renders the shared compensation + scope copy
 */

import { COMPENSATION, JOB_TYPE, LOCATION, SCOPE_PITCH, WORK_STYLE } from '../config';

export default function CompensationBlock() {
  return (
    <section className="rounded-lg bg-slate-50 p-6 sm:p-8 space-y-3">
      <h2 className="text-xl font-semibold text-slate-900">Location &amp; Compensation</h2>
      <p className="text-lg font-semibold text-slate-900">{COMPENSATION.totalCash}</p>
      <p className="text-base text-slate-600 leading-relaxed">
        {COMPENSATION.breakdown}. {COMPENSATION.equity}.
      </p>
      <p className="text-base text-slate-600 leading-relaxed">
        {LOCATION} · {WORK_STYLE} · {JOB_TYPE}
      </p>
      <p className="text-base text-slate-600 leading-relaxed">{SCOPE_PITCH}</p>
    </section>
  );
}
