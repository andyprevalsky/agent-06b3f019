/**
 * STATE MACHINE: QueryInput (top-level orchestrator)
 *
 * Stock: top toolbar, attachments, textarea and model/send controls.
 * Rose Desktop: nub toolbar, pinned tools, attachments, model/speed/send.
 * Browser: existing owner-agent input, files and Send only; read-only model
 *   label stays unknown until the browser task reports its actual model.
 *
 * Sub-state lives in hooks:
 *   - useAttachments     : attachment lifecycle + paste/drag
 *   - usePriceLimit      : edit/save/cancel cost-limit flow
 *   - useTopBarProps     : account/viewport gating shared by TopBar + NubToolbar
 *
 * DIRECT CHANNEL (directChannel, the Rose Desktop code-agent view): the same
 *   shell, attachments and send button with native session controls; no Rose nub tab
 *   or pinned tools. Draft attachments clear only after confirmed delivery.
 *
 * TAB REVEAL (Rose Desktop only): owned by `useToolbarReveal` (ToolbarNub.tsx)
 *   [CLOSED 4px lip] --hover/focus/tap--> [OPEN 18px strip] --leave/tap--> [CLOSED]
 *
 * INPUT STATE:
 *   [EMPTY] -> (type) -> [HAS_TEXT] -> (submit/clear) -> [EMPTY]
 *
 * MODEL SELECTOR:      owned by `ModelSelector`
 * COST / PRICE LIMIT:  owned by `CostIndicator` + `usePriceLimit`
 * ATTACHMENTS:         owned by `useAttachments`
 * FAST MODE:           shown for admin operators (id, verified phone, impersonation)
 *                      in create + chat query boxes; Zap icon only (aria-label
 *                      + tooltip carry "Fast Mode"); controls LLM provider speed,
 *                      not DEMO cache replay. Rose Desktop: SpeedToggle
 *                      [NORMAL] -> [FAST] -> [ULTRA (default)] -> [NORMAL]
 * SIMULATOR:           shown for admin users; session-only and default off
 * TEST PROMPTS:        shown only on desktop for dev/admin users; never mounted on mobile
 * SUBMISSION:          canSubmit prop decides send-vs-stop button
 * SURFACE:             the translucent drip surface (data-surface="translucent";
 *                      the mobile hug rule in index.css targets it)
 *   Rose dark (useRoseTheme().isDark, Rose Desktop accounts only):
 *                      [LIGHT drip] --html.dark--> [DARK solid #2f2f2c,
 *                      9% white border, deep shadow, no white marble; textarea
 *                      #f2f2ef / placeholder #8c8c86; model chip #2f2f2c]
 *                      Light keeps the exact stock styles (dripStyles.ts).
 */

import { useRef } from 'react';
import { cn } from '@/lib/utils';
import { useToast } from '../hooks';
import { type QueryInputProps, DEFAULT_DRIP_STYLES } from './query-input/types';
import { useAttachments } from './query-input/useAttachments';
import { usePriceLimit } from './query-input/usePriceLimit';
import { AttachmentList } from './query-input/AttachmentList';
import { QueryInputLayer } from './query-input/QueryInputLayer';
import { InputContainer } from './query-input/InputContainer';
import { TopBar, type TopBarProps } from './query-input/TopBar';
import { NubTab } from './query-input/ToolbarNub';
import { NubToolbar } from './query-input/NubToolbar';
import { PinnedTools } from './query-input/PinnedTools';
import { useToolbarReveal } from './query-input/useToolbarReveal';
import { useTopBarProps } from './query-input/useTopBarProps';
import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import { useRoseTheme } from '@/features/rose-theme';
import {
  buildDripContainerStyle,
  buildMarbleBackgroundStyle,
  showsMarbleBackground,
} from './query-input/dripStyles';
import { DEFAULT_PENDING_PRICE_LIMIT_CENTS } from '../config';
import { useRoseApps } from './rose-apps/roseAppsState';
import { browserComposerTarget, browserComposerModel } from './query-input/browserComposer';
import './query-input/roseQueryBox.css';

export type { QueryInputProps };
export type { DripStyles, PendingAttachment } from './query-input/types';

export default function QueryInput(props: QueryInputProps) {
  const { dripStyles = DEFAULT_DRIP_STYLES, drippiness = 0, directChannel = false } = props;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachments = useAttachments({ textareaRef, draftKey: props.draftKey });
  const priceLimit = usePriceLimit({
    agentDetail: props.agentDetail,
    pendingPriceLimitCents: props.pendingPriceLimitCents ?? DEFAULT_PENDING_PRICE_LIMIT_CENTS,
    onPendingPriceLimitChange: props.onPendingPriceLimitChange,
    onAgentUpdate: props.onAgentUpdate,
  });
  const handleSubmit = useSubmitHandler(attachments, props.onSubmit, directChannel);
  const topBarProps = useTopBarProps(props, attachments, priceLimit, textareaRef);
  const reveal = useToolbarReveal();
  const roseDesktop = useRoseDesktop();
  const roseDark = useRoseTheme().isDark;
  const apps = useRoseApps();
  const browser =
    !!browserComposerTarget(apps, props.agentId) && !!props.liftAboveApps && !directChannel;

  return (
    <QueryInputLayer
      enabled={roseDesktop && !!props.liftAboveApps}
      browserEligible={!directChannel}
      ownerAgentId={props.agentId}
    >
      <div className="w-full md:px-0">
        <div
          data-testid="query-input-host"
          className={cn('max-w-4xl mx-auto', roseDesktop && !browser && 'relative mt-[14px]')}
        >
          {roseDesktop && !directChannel && !browser && (
            <NubTab reveal={reveal}>
              <NubToolbar {...topBarProps} />
            </NubTab>
          )}
          <QueryInputShell
            dripStyles={dripStyles}
            drippiness={drippiness}
            isDragOver={attachments.isDragOver}
            dragHandlers={attachments.dragHandlers}
            aboveTab={roseDesktop}
            roseDark={roseDark}
          >
            <QueryInputBody
              {...props}
              attachments={attachments}
              textareaRef={textareaRef}
              handleSubmit={handleSubmit}
              topBarProps={topBarProps}
              roseDesktop={roseDesktop}
              roseDark={roseDark}
              browser={browser}
              browserModelLabel={browser ? browserComposerModel(apps, props.agentId) : undefined}
            />
          </QueryInputShell>
        </div>
      </div>
    </QueryInputLayer>
  );
}

function useSubmitHandler(
  attachments: ReturnType<typeof useAttachments>,
  onSubmit: QueryInputProps['onSubmit'],
  directChannel: boolean,
) {
  const { toast } = useToast();
  return () => {
    if (attachments.hasUploading) {
      toast({ title: 'Please wait', description: 'Files are still uploading...' });
      return;
    }
    if (attachments.hasFailed) {
      toast({
        title: 'Upload failed',
        description: 'Some files failed to upload. Remove them and try again.',
        variant: 'destructive',
      });
      return;
    }
    const pointers = directChannel
      ? attachments.collectDonePointers()
      : attachments.collectDonePointersAndClear();
    const result = onSubmit(pointers.length > 0 ? pointers : undefined);
    if (directChannel)
      void Promise.resolve(result).then((delivered) => {
        if (delivered === true) attachments.collectDonePointersAndClear();
      });
  };
}

interface QueryInputBodyProps extends QueryInputProps {
  attachments: ReturnType<typeof useAttachments>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  handleSubmit: () => void;
  topBarProps: TopBarProps;
  /** Rose Desktop: the tab carries the toolbar; speed moves to the bottom row. */
  roseDesktop: boolean;
  /** Rose Desktop dark mode: dark textarea + model chip. */
  roseDark: boolean;
  browser: boolean;
  browserModelLabel?: string;
}

function QueryInputBody(props: QueryInputBodyProps) {
  const {
    value,
    onChange,
    disabled = false,
    placeholder = 'Type your message...',
    selectedModel = 'rose-labs/rose-1-ultra',
    onModelChange,
    availableModels = [],
    showModelSelector = true,
    agentDetail = null,
    canSubmit = true,
    onPause,
    isPausing = false,
    attachments,
    textareaRef,
    handleSubmit,
    topBarProps,
    roseDesktop,
    roseDark,
    directChannel = false,
    browser,
  } = props;
  const agentCompleted = agentDetail?.status === 'COMPLETED' || agentDetail?.status === 'FAILED';
  const speed =
    roseDesktop && !directChannel && !browser && topBarProps.showFastMode
      ? { fastMode: topBarProps.fastMode ?? false, onFastModeChange: topBarProps.onFastModeChange }
      : undefined;
  const toolbar = roseDesktop ? <PinnedTools {...topBarProps} /> : <TopBar {...topBarProps} />;

  return (
    <>
      {!directChannel && !browser && toolbar}
      <AttachmentList attachments={attachments.attachments} onRemove={attachments.remove} />
      <DragOverlay visible={attachments.isDragOver} />
      <InputContainer
        value={value}
        onChange={onChange}
        disabled={disabled}
        placeholder={browser ? 'Message Rose about this browser' : placeholder}
        onSubmit={handleSubmit}
        onFilesPicked={(files) => void attachments.processFiles(files)}
        agentCompleted={agentCompleted}
        canSubmit={browser || canSubmit}
        onPause={browser ? undefined : onPause}
        isPausing={isPausing}
        hasUploadingAttachments={attachments.hasUploading}
        selectedModel={selectedModel}
        onModelChange={onModelChange}
        availableModels={availableModels}
        showModelSelector={showModelSelector}
        hideModelSelector={directChannel || browser}
        readOnlyModelLabel={props.browserModelLabel}
        textareaRef={textareaRef}
        roseDesktop={roseDesktop}
        roseDark={roseDark}
        speed={speed}
        attachable
        sessionControls={browser ? undefined : props.sessionControls}
      />
    </>
  );
}

function DragOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="absolute inset-0 bg-primary/10 flex items-center justify-center z-20 pointer-events-none rounded-xl">
      <div className="text-primary font-medium">Drop files here</div>
    </div>
  );
}

interface QueryInputShellProps {
  dripStyles: NonNullable<QueryInputProps['dripStyles']>;
  drippiness: number;
  isDragOver: boolean;
  dragHandlers: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
  /** Rose Desktop: stack the box above the tab so the tab sits behind it. */
  aboveTab: boolean;
  /** Rose Desktop dark mode: the solid dark surface (dripStyles.ts). */
  roseDark: boolean;
  children: React.ReactNode;
}

function QueryInputShell({
  dripStyles,
  drippiness,
  isDragOver,
  dragHandlers,
  aboveTab,
  roseDark,
  children,
}: QueryInputShellProps) {
  const dripStyle = buildDripContainerStyle(dripStyles, drippiness, isDragOver, roseDark);
  return (
    <div
      data-testid="query-input-surface"
      data-surface="translucent"
      className={cn(
        'relative rounded-xl p-3 shadow-lg border overflow-hidden transition-colors',
        aboveTab && 'z-[1]',
        isDragOver ? 'border-primary border-2 bg-primary/5' : 'border-border',
      )}
      style={dripStyle}
      onDragOver={dragHandlers.onDragOver}
      onDragLeave={dragHandlers.onDragLeave}
      onDrop={dragHandlers.onDrop}
    >
      {showsMarbleBackground(dripStyles, roseDark) && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={buildMarbleBackgroundStyle(dripStyles)}
        />
      )}
      <div className="relative z-10">{children}</div>
    </div>
  );
}
