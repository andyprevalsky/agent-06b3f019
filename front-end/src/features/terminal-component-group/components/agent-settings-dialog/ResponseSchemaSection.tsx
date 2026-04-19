/**
 * Renders the agent's output schema fields (name, type, required flag, description).
 * Shows a placeholder while the schema is still being generated.
 */

import { FileJson } from 'lucide-react';
import { Label } from '@/components/ui/label';
import type { AgentDetail } from '../../hooks';
import { formatFieldType } from './helpers';

interface ResponseSchemaSectionProps {
  agent: AgentDetail;
}

export default function ResponseSchemaSection({ agent }: ResponseSchemaSectionProps) {
  const fields = agent.response_schema?.fields ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <FileJson className="h-4 w-4 text-muted-foreground" />
        <Label>Output Schema</Label>
      </div>

      {fields.length > 0 ? (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
          {fields.map((field, idx) => (
            <div key={idx} className="text-sm">
              <div className="flex items-center gap-2">
                <code className="font-mono text-xs bg-background px-1.5 py-0.5 rounded">
                  {field.name}
                </code>
                <span className="text-muted-foreground text-xs">
                  {formatFieldType(field.type)}
                </span>
                {field.required && (
                  <span className="text-[10px] text-amber-600 dark:text-amber-500 font-medium">
                    required
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5 pl-1">{field.description}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground italic">Schema generating...</p>
      )}
    </div>
  );
}
