/**
 * Report Bug section in AgentSettingsDialog.
 *
 * Admin-only: expands into a description textarea that runs the boxes.dev
 * Bug Report automation, titled from the description, to /rca the Rose agent.
 *
 * After launch, keep Open + Copy on screen. Submit never auto-opens boxes.dev
 * and never sends SMS.
 */

import { Bug, Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import type { UseReportBugResult } from './useReportBug';

interface ReportBugSectionProps {
  flow: UseReportBugResult;
}

export default function ReportBugSection({ flow }: ReportBugSectionProps) {
  if (flow.launched !== null) {
    return (
      <div className="space-y-3 pt-4 border-t border-border/60" data-testid="report-bug-launched">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Check className="h-4 w-4 text-emerald-500" />
            boxes.dev agent launched
          </div>
          <p className="text-sm text-foreground/90 break-words">{flow.launched.name}</p>
          <p className="text-xs text-muted-foreground">
            Started a new boxes.dev thread from the Bug Report automation. Tap Open to follow it.
          </p>
          <a
            href={flow.launched.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-xs text-primary underline break-all"
            data-testid="report-bug-url"
          >
            {flow.launched.url}
          </a>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            onClick={() => void flow.copyLink()}
            variant="outline"
            className="flex-1"
            data-testid="report-bug-copy"
          >
            <Copy className="h-4 w-4 mr-2" />
            Copy link
          </Button>
          <Button
            type="button"
            onClick={flow.openLink}
            className="flex-1"
            data-testid="report-bug-open-link"
          >
            <ExternalLink className="h-4 w-4 mr-2" />
            Open in boxes.dev
          </Button>
        </div>
        <Button
          type="button"
          onClick={flow.dismissLaunched}
          variant="ghost"
          className="w-full"
          data-testid="report-bug-dismiss"
        >
          Done
        </Button>
      </div>
    );
  }

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
              Launches a boxes.dev agent to investigate. After it launches you can copy or open the
              link.
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
