/**
 * Report Bug panel body for ReportBugDialog (its own control, outside Agent
 * Settings).
 *
 * Admin-only: a description textarea that runs the boxes.dev
 * Bug Report automation, titled from the description, to /rca the Rose agent.
 *
 * Screenshots dragged onto or pasted into the textarea upload immediately and
 * appear in the description as `![name](url)` image links.
 *
 * COMPOSER DROP STATE: [IDLE] --dragover with files--> [DRAG_OVER]
 *   --drop--> attachScreenshots (UPLOADING count > 0 disables Submit)
 *   --dragleave--> [IDLE]
 *
 * After launch, keep Open + Copy on screen. Submit never auto-opens boxes.dev
 * and never sends SMS.
 */

import { useState, type ClipboardEvent, type DragEvent } from 'react';
import { Bug, Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { UseReportBugResult } from './useReportBug';
import { isScreenshotFile } from './useBugReportScreenshots';

interface ReportBugSectionProps {
  flow: UseReportBugResult;
}

function draggingFiles(event: DragEvent<HTMLTextAreaElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

function useScreenshotDropTarget(flow: UseReportBugResult) {
  const [isDragOver, setIsDragOver] = useState(false);
  return {
    isDragOver,
    onDragOver: (event: DragEvent<HTMLTextAreaElement>) => {
      if (!draggingFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setIsDragOver(true);
    },
    onDragLeave: () => setIsDragOver(false),
    onDrop: (event: DragEvent<HTMLTextAreaElement>) => {
      if (!draggingFiles(event)) return;
      event.preventDefault();
      setIsDragOver(false);
      flow.attachScreenshots(
        Array.from(event.dataTransfer.files),
        event.currentTarget.selectionStart,
      );
    },
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const images = Array.from(event.clipboardData.files).filter(isScreenshotFile);
      if (images.length === 0) return;
      event.preventDefault();
      flow.attachScreenshots(images, event.currentTarget.selectionStart);
    },
  };
}

export default function ReportBugSection({ flow }: ReportBugSectionProps) {
  const { isDragOver, ...dropHandlers } = useScreenshotDropTarget(flow);
  const isUploading = flow.uploadingScreenshots > 0;
  if (flow.launched !== null) {
    return (
      <div className="space-y-3" data-testid="report-bug-launched">
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
          className={cn(
            'resize-y min-h-[100px]',
            isDragOver && 'border-primary ring-2 ring-primary/40',
          )}
          {...dropHandlers}
        />
        <p className="text-xs text-muted-foreground" data-testid="report-bug-screenshot-hint">
          {isUploading
            ? `Uploading ${flow.uploadingScreenshots} screenshot${flow.uploadingScreenshots === 1 ? '' : 's'}…`
            : 'Drag, drop or paste screenshots into the description.'}
        </p>
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
          disabled={flow.isSubmitting || isUploading || flow.description.trim() === ''}
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
  );
}
