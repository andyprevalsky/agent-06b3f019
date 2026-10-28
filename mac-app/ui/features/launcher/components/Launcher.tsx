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
 *   outer + LiquidMetalRing (ui/shared/liquid-metal), 2px inset fill
 *
 * Theme: [light] <-> [dark] follows the main window's html.dark
 *   (ui/shared/theme-sync); palette vars live in config.ts LAUNCHER_GLOBAL_CSS.
 *   Corner radius locked to the idle pill (height/2), so expanding for
 *   files/paragraph does NOT grow into a giant stadium — same ends as before.
 *
 * Window surface:
 *   Nearly-invisible fill over the full BrowserWindow so macOS hit-tests the
 *   launcher (not apps behind) during OS file drags. Pill chrome stays the
 *   only drag-region for moving the frameless window.
 */

import { useCallback, useState } from 'react';
import QueryForm from './QueryForm';
import LauncherShell from './LauncherShell';
import { useLauncher, useLauncherWindowHeight } from '../hooks';
import { LAUNCHER_PILL_HEIGHT, launcherPillHeightFromContent } from '../config';

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

  useLauncherWindowHeight(pillHeight);

  return (
    <div
      data-testid="launcher-window-surface"
      className="no-drag"
      onDragOver={dragHandlers.onDragOver}
      onDragLeave={dragHandlers.onDragLeave}
      onDrop={dragHandlers.onDrop}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        // Fully transparent pixels pass OS drags through on macOS Electron.
        // A 1% fill keeps the BrowserWindow in the hit-test path.
        backgroundColor: 'rgba(255, 255, 255, 0.01)',
      }}
    >
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
