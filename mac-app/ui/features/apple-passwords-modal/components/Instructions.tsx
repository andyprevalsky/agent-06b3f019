/**
 * Numbered instructions list inside the ApplePasswordsModal. Purely
 * presentational — delegates the "Open Passwords" IPC and lightbox toggle
 * to handlers passed in by the hook-backed parent component.
 */

import { Trash2 } from 'lucide-react';
import passwordsExportStep from '../../../assets/passwords-export-step.png';
import { EXPORT_HIGHLIGHT_STYLE } from '../config';

interface InstructionsProps {
  onOpenPasswords: () => void;
  onExpandScreenshot: () => void;
}

const StepNumber = ({ n }: { n: number }): React.ReactElement => (
  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
    {n}
  </span>
);

const Instructions = ({
  onOpenPasswords,
  onExpandScreenshot,
}: InstructionsProps): React.ReactElement => (
  <ol className="text-sm text-muted-foreground space-y-4">
    <li className="space-y-2">
      <div className="flex items-start gap-3">
        <StepNumber n={1} />
        <div className="flex-1">
          <span>
            Open the <strong className="text-foreground">Passwords</strong> app on your Mac
          </span>
          <button
            onClick={onOpenPasswords}
            className="ml-2 px-2 py-0.5 text-xs font-medium bg-muted hover:bg-muted/80 text-foreground rounded transition-colors"
          >
            Open Passwords
          </button>
        </div>
      </div>
    </li>

    <li className="space-y-2">
      <div className="flex items-start gap-3">
        <StepNumber n={2} />
        <span>
          Click <strong className="text-foreground">File</strong> →{' '}
          <strong className="text-foreground">Export All Passwords to File...</strong>
        </span>
      </div>
      <div className="flex justify-center mt-2">
        <button onClick={onExpandScreenshot} className="cursor-zoom-in relative group">
          <img
            src={passwordsExportStep}
            alt="Passwords app showing File menu with Export option"
            className="rounded-lg border border-border max-w-[300px]"
          />
          <div
            className="absolute border-2 border-red-500 rounded pointer-events-none"
            style={EXPORT_HIGHLIGHT_STYLE}
          />
          <span className="absolute bottom-2 right-2 text-xs bg-black/60 text-white px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity">
            Click to enlarge
          </span>
        </button>
      </div>
    </li>

    <li className="space-y-2">
      <div className="flex items-start gap-3">
        <StepNumber n={3} />
        <span>
          Save the file and <strong className="text-foreground">upload it below</strong>
        </span>
      </div>
    </li>

    <li className="space-y-2">
      <div className="flex items-start gap-3">
        <StepNumber n={4} />
        <div className="flex items-center gap-2">
          <Trash2 className="w-4 h-4 text-muted-foreground" />
          <span>
            <strong className="text-foreground">Delete the CSV file</strong> from your computer
            after import
          </span>
        </div>
      </div>
    </li>
  </ol>
);

export default Instructions;
