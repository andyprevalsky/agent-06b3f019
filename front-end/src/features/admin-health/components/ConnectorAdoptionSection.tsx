/**
 * STATE MACHINE: ConnectorAdoptionSection (presentational)
 *
 * AdminHealthData.connectorAdoption
 *   -> six ordered subtype cards
 *      -> connection rate + distinct connected users / eligible users
 *
 * The endpoint owns deduplication and the verified-user denominator; this
 * component only formats the returned point-in-time adoption snapshot.
 */

import type { AdminHealthConnectorAdoption } from '../types';

function formatPercent(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(value);
}

export default function ConnectorAdoptionSection({
  adoption,
}: {
  adoption: AdminHealthConnectorAdoption;
}) {
  return (
    <section
      aria-labelledby="connector-adoption-title"
      className="rounded-lg border border-border/60 bg-background/65 p-5"
    >
      <div>
        <h3 id="connector-adoption-title" className="font-semibold">
          Connector Adoption
        </h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          People in the app with at least one active connection in each onboarding subtype.
        </p>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {adoption.subtypes.map((subtype) => (
          <article key={subtype.id} className="rounded-md border border-border/60 bg-muted/20 p-4">
            <p className="text-xs font-medium text-muted-foreground">{subtype.label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">
              {formatPercent(subtype.connectionRate)}
            </p>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-foreground"
                style={{ width: `${Math.min(100, subtype.connectionRate * 100)}%` }}
              />
            </div>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              {subtype.connectedUsers} of {adoption.eligibleUserCount} people in app connected
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
