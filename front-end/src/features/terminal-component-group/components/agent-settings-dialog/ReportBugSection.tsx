/**
 * Report Bug section in AgentSettingsDialog.
 *
 * Admin-only: expands into a description textarea that launches a Cursor
 * cloud agent named "Bug | <short title>" to /rca the Rose agent.
 */

import { Bug, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import type { UseReportBugResult } from './useReportBug';

interface ReportBugSectionProps {
  flow: UseReportBugResult;
}

export default function ReportBugSection({ flow }: ReportBugSectionProps) {
  return (
    <div className="space-y-3 pt-4 border-t border-border/60">
      {!flow.showComposer ? (
        <Button
          type="button"
          onClick={flow.start}
          variant="outline"
          className="w-full"
          data-testid="report-bug-open"
        >
          <Bug className="h-4 w-4 mr-2" />
          Report Bug
        </Button>
      ) : (
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="report-bug-description">Describe the bug</Label>
            <Textarea
              id="report-bug-description"
              data-testid="report-bug-description"
              value={flow.description}
              onChange={(e) => flow.setDescription(e.target.value)}
              placeholder="What went wrong? Include expected vs actual behavior."
              rows={5}
              disabled={flow.isSubmitting}
              className="resize-y min-h-[100px]"
            />
            <p className="text-xs text-muted-foreground">
              Launches a Cursor cloud agent to /rca this agent. Manage it from the Cursor
              dashboard on your phone.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              onClick={flow.cancel}
              variant="outline"
              className="flex-1"
              disabled={flow.isSubmitting}
              data-testid="report-bug-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void flow.submit()}
              className="flex-1"
              disabled={flow.isSubmitting || flow.description.trim() === ''}
              data-testid="report-bug-submit"
            >
              {flow.isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Submitting...
                </>
              ) : (
                <>
                  <Bug className="h-4 w-4 mr-2" />
                  Submit
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
