/**
 * STATE MACHINE: DockSchema (output schema disclosures in the running-agents dock)
 *
 * NodeSchemaDisclosure (one agent row with an output_schema):
 *   [COLLAPSED] (default) "▸ output schema · N fields" -- click --> [EXPANDED]
 *   [EXPANDED]  SchemaRows (main's OutputChip rows): name, type, required;
 *               values filled in once the agent is terminal (amber if failed)
 *
 * ForEachResultsDisclosure (one for_each cluster):
 *   [COLLAPSED] "▸ output schema · N fields · k results" -- click --> [EXPANDED]
 *   [EXPANDED]  results table: one column per schema field, one row per
 *               finished child (schema-only rows while none finished)
 *
 * Renders nothing when no schema is known.
 */
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { OutputSchema, TreeNode } from '../../hooks';
import { formatFieldType, formatValue, isTerminalNode } from '../subAgentTree.helpers';
import { SchemaRows } from '../subAgentTree/OutputChip';

function schemaOf(node: TreeNode): OutputSchema | null {
  return node.outputSchema?.fields?.length ? node.outputSchema : null;
}

function outputOf(node: TreeNode): Record<string, unknown> | undefined {
  if (!isTerminalNode(node)) return undefined;
  if (node.status === 'FAILED') {
    return node.failureContext?.partial_structured_response ?? node.structuredOutput;
  }
  return node.structuredOutput;
}

function Toggle({
  open,
  label,
  prefix,
  onToggle,
}: {
  open: boolean;
  label: string;
  prefix: string;
  onToggle: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1 py-0.5">
      <span className="shrink-0 whitespace-pre select-none text-gray-400 dark:text-gray-600">
        {prefix}
      </span>
      <button
        type="button"
        className="min-w-0 truncate text-left text-xs text-muted-foreground hover:text-foreground"
        onClick={onToggle}
        aria-expanded={open}
        data-testid="dock-schema-toggle"
      >
        {open ? '▾' : '▸'} {label}
      </button>
    </div>
  );
}

export function NodeSchemaDisclosure({ node, prefix }: { node: TreeNode; prefix: string }) {
  const [open, setOpen] = useState(false);
  const schema = schemaOf(node);
  if (!schema) return null;
  const output = outputOf(node);
  const count = schema.fields.length;
  return (
    <div className="min-w-0" data-testid="dock-node-schema">
      <Toggle
        open={open}
        prefix={prefix}
        label={`output schema · ${count} field${count === 1 ? '' : 's'}${output ? ' · result' : ''}`}
        onToggle={() => setOpen((value) => !value)}
      />
      {open && (
        <div className="min-w-0 break-words pb-1 pl-6 text-xs">
          <SchemaRows
            schema={schema}
            output={output}
            isPartial={node.status === 'FAILED'}
            showRequired
          />
        </div>
      )}
    </div>
  );
}

function ResultsTable({ schema, rows }: { schema: OutputSchema; rows: TreeNode[] }) {
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs" data-testid="dock-results-table">
        <thead>
          <tr className="border-b border-border/60">
            {schema.fields.map((field) => (
              <th key={field.name} className="py-1 pr-3 align-bottom font-medium">
                {field.name.replace(/_/g, ' ')}
                <span className="block text-[10px] font-normal text-muted-foreground">
                  {formatFieldType(field.type)} · {field.required ? 'required' : 'optional'}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((node) => {
            const output = outputOf(node) ?? {};
            return (
              <tr
                key={node.agentId}
                className={cn(
                  'border-b border-border/30 last:border-0',
                  node.status === 'FAILED' && 'text-amber-600 dark:text-amber-400',
                )}
              >
                {schema.fields.map((field) => {
                  const value = output[field.name];
                  return (
                    <td key={field.name} className="break-words py-1 pr-3 align-top">
                      {value === undefined || value === null ? '—' : formatValue(value, field.type)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ForEachResultsDisclosure({ roots }: { roots: TreeNode[] }) {
  const [open, setOpen] = useState(false);
  const schema = roots.map(schemaOf).find((value): value is OutputSchema => value !== null);
  if (!schema) return null;
  const finished = roots.filter((node) => outputOf(node) !== undefined);
  const count = schema.fields.length;
  return (
    <div className="min-w-0" data-testid="dock-for-each-schema">
      <Toggle
        open={open}
        prefix=""
        label={`output schema · ${count} field${count === 1 ? '' : 's'} · ${finished.length} result${finished.length === 1 ? '' : 's'}`}
        onToggle={() => setOpen((value) => !value)}
      />
      {open && (
        <div className="min-w-0 pb-1 pl-5">
          {finished.length > 0 ? (
            <ResultsTable schema={schema} rows={finished} />
          ) : (
            <div className="text-xs">
              <SchemaRows schema={schema} showRequired />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
