import type { PhoneCallMetadata } from '../../types';
import { RecordingPlayer } from './RecordingPlayer';

/**
 * Expanded-details panel shown under the header for finished calls. Renders
 * the recording player, summary, extracted structured data, and transcript
 * (each conditionally based on what the call metadata contains).
 */
export function PhoneCallDetails({ phoneCall }: { phoneCall: PhoneCallMetadata }) {
  return (
    <div className="border-t p-3 space-y-3">
      {phoneCall.recordingUrl && <RecordingPlayer recordingUrl={phoneCall.recordingUrl} />}

      {phoneCall.summary && (
        <DetailSection label="Summary">
          <p className="text-sm font-medium">{phoneCall.summary}</p>
        </DetailSection>
      )}

      {phoneCall.structuredData && Object.keys(phoneCall.structuredData).length > 0 && (
        <DetailSection label="Extracted Data">
          <pre className="text-xs bg-muted/50 p-2 rounded overflow-x-auto">
            {JSON.stringify(phoneCall.structuredData, null, 2)}
          </pre>
        </DetailSection>
      )}

      {phoneCall.transcript && (
        <DetailSection label="Transcript">
          <div className="text-sm whitespace-pre-wrap bg-muted/30 p-2 rounded max-h-48 overflow-y-auto">
            {phoneCall.transcript}
          </div>
        </DetailSection>
      )}
    </div>
  );
}

function DetailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {label}
      </div>
      {children}
    </div>
  );
}
