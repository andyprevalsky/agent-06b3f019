/**
 * Pill-shaped Quick-Query launcher component.
 *
 * Thin view: reads state + handlers from `useLauncher`, renders the shell
 * + form + drag/drop attach surface. All IO is orchestrated in hooks.
 *
 * STATE MACHINE:
 *   [idle] ↔ [has_text] ↔ [has_files]
 *   any --dragover--> [drag_over] --drop--> [has_files]
 *   [has_text|has_files] --submit--> [submitting]
 *
 * Border = pre-DnD production shell:
 *   outer + ShaderTile, 2px inset #f5f5f5
 *   Corner radius locked to the idle pill (height/2), so expanding for
 *   files/paragraph does NOT grow into a giant stadium — same ends as before.
 */

import { useCallback, useEffect, useState } from 'react';
import QueryForm from './QueryForm';
import LauncherShell from './LauncherShell';
import { useLauncher } from '../hooks';
import { resizeQuickQuery } from '../api';
import {
  LAUNCHER_PILL_HEIGHT,
  launcherPillHeightFromContent,
  launcherWindowHeightFromPill,
} from '../config';

const Launcher = (): React.JSX.Element => {
  const {
    query,
    setQuery,
    submitting,
    inputRef,
    handleSubmit,
    handleKeyDown,
    attachments,
    isDragOver,
    attachError,
    dragHandlers,
    removeAttachment,
    addFiles,
  } = useLauncher();

  const [contentHeight, setContentHeight] = useState(LAUNCHER_PILL_HEIGHT - 4);
  const hasAttachments = attachments.length > 0;
  const pillHeight = launcherPillHeightFromContent(contentHeight, hasAttachments);

  const onContentHeightChange = useCallback((height: number) => {
    setContentHeight(height);
  }, []);

  useEffect(() => {
    void resizeQuickQuery({ height: launcherWindowHeightFromPill(pillHeight) });
  }, [pillHeight]);

  return (
    <div className="drag-region" style={{ position: 'relative', width: '100%', height: '100%' }}>
      <LauncherShell pillHeight={pillHeight} isDragOver={isDragOver} dragHandlers={dragHandlers}>
        <QueryForm
          query={query}
          setQuery={setQuery}
          submitting={submitting}
          inputRef={inputRef}
          handleSubmit={handleSubmit}
          handleKeyDown={handleKeyDown}
          canSubmitWithoutQuery={hasAttachments}
          attachments={attachments}
          onRemoveAttachment={removeAttachment}
          onPickFiles={addFiles}
          attachError={attachError}
          onContentHeightChange={onContentHeightChange}
        />
      </LauncherShell>
    </div>
  );
};

export default Launcher;
