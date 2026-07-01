/**
 * STATE MACHINE: QueryInput (top-level orchestrator)
 *
 * Composition:
 *   TopBar (WriteLock, ToolSet, TestPrompts, CostIndicator, ContextMeter, Settings)
 *   AttachmentList (chips)
 *   InputContainer (textarea + paperclip + model picker + submit/stop button)
 *
 * Sub-state lives in hooks:
 *   - useAttachments     : attachment lifecycle + paste/drag
 *   - usePriceLimit      : edit/save/cancel cost-limit flow
 *
 * INPUT STATE:
 *   [EMPTY] -> (type) -> [HAS_TEXT] -> (submit/clear) -> [EMPTY]
 *
 * MODEL SELECTOR:      owned by `ModelSelector`
 * COST / PRICE LIMIT:  owned by `CostIndicator` + `usePriceLimit`
 * ATTACHMENTS:         owned by `useAttachments`
 * FAST MODE:           shown for allow-listed users in both create + chat query boxes
 * TEST PROMPTS:        shown only on desktop for dev/admin users; never mounted on mobile
 * SUBMISSION:          canSubmit prop decides send-vs-stop button
 */

import { useRef } from 'react';
import { useIsMobile } from '@/hooks/use-mobile';
import { FAST_MODE_USER_IDS } from '@/lib/fastModeAccounts';
import { cn } from '@/lib/utils';
import { useAuth, useToast } from '../hooks';
import { IS_DEV_MODE, ADMIN_USER_IDS, DEFAULT_RESTART_THRESHOLD } from '../config';
import { type QueryInputProps, DEFAULT_DRIP_STYLES } from './query-input/types';
import { useAttachments } from './query-input/useAttachments';
import { usePriceLimit, type UsePriceLimitResult } from './query-input/usePriceLimit';
import { AttachmentList } from './query-input/AttachmentList';
import { InputContainer } from './query-input/InputContainer';
import { TopBar } from './query-input/TopBar';
import { buildDripContainerStyle, buildMarbleBackgroundStyle } from './query-input/dripStyles';

export type { QueryInputProps };
export type { DripStyles, PendingAttachment } from './query-input/types';

export default function QueryInput(props: QueryInputProps) {
  const {
    dripStyles = DEFAULT_DRIP_STYLES,
    drippiness = 0,
    restartThreshold = DEFAULT_RESTART_THRESHOLD,
  } = props;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachments = useAttachments({ textareaRef });
  const priceLimit = usePriceLimit({
    agentDetail: props.agentDetail,
    pendingPriceLimitCents: props.pendingPriceLimitCents ?? 100,
    onPendingPriceLimitChange: props.onPendingPriceLimitChange,
    onAgentUpdate: props.onAgentUpdate,
  });
  const handleSubmit = useSubmitHandler(attachments, props.onSubmit);

  return (
    <div className="w-full md:px-0">
      <div className="max-w-4xl mx-auto">
        <QueryInputShell
          dripStyles={dripStyles}
          drippiness={drippiness}
          isDragOver={attachments.isDragOver}
          dragHandlers={attachments.dragHandlers}
        >
          <QueryInputBody
            {...props}
            restartThreshold={restartThreshold}
            attachments={attachments}
            priceLimit={priceLimit}
            textareaRef={textareaRef}
            handleSubmit={handleSubmit}
          />
        </QueryInputShell>
      </div>
    </div>
  );
}

function useSubmitHandler(
  attachments: ReturnType<typeof useAttachments>,
  onSubmit: QueryInputProps['onSubmit'],
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
    const pointers = attachments.collectDonePointersAndClear();
    onSubmit(pointers.length > 0 ? pointers : undefined);
  };
}

interface QueryInputBodyProps extends QueryInputProps {
  attachments: ReturnType<typeof useAttachments>;
  priceLimit: UsePriceLimitResult;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  handleSubmit: () => void;
}

function QueryInputBody(props: QueryInputBodyProps) {
  const {
    value,
    onChange,
    disabled = false,
    placeholder = 'Type your message...',
    selectedModel = 'rose-labs/rose-1-ultra',
    onModelChange,
    fastMode = false,
    onFastModeChange,
    availableModels = [],
    contextPercentage = 0,
    contextSize = 0,
    restartThreshold = DEFAULT_RESTART_THRESHOLD,
    showModelSelector = true,
    agentDetail = null,
    onAgentUpdate,
    onAgentDelete,
    canSubmit = true,
    onPause,
    isPausing = false,
    pendingPriceLimitCents = 100,
    attachments,
    priceLimit,
    textareaRef,
    handleSubmit,
  } = props;
  const { user: authUser } = useAuth();
  const isMobile = useIsMobile();
  const showTestPrompts =
    !isMobile && (IS_DEV_MODE || (authUser?.id != null && ADMIN_USER_IDS.includes(authUser.id)));
  // Fast Mode toggle is query-box scoped and gated to allow-listed accounts.
  const showFastMode = authUser?.id != null && FAST_MODE_USER_IDS.includes(authUser.id);
  const agentCompleted = agentDetail?.status === 'COMPLETED' || agentDetail?.status === 'FAILED';

  return (
    <>
      <TopBar
        agentDetail={agentDetail}
        onAgentUpdate={onAgentUpdate}
        onAgentDelete={onAgentDelete}
        showTestPrompts={showTestPrompts}
        showFastMode={showFastMode}
        fastMode={fastMode}
        onFastModeChange={onFastModeChange}
        onSelectPrompt={(prompt, files) => {
          onChange(prompt);
          if (files && files.length > 0) void attachments.processFiles(files);
        }}
        pendingPriceLimitCents={pendingPriceLimitCents}
        priceLimit={priceLimit}
        contextPercentage={contextPercentage}
        contextSize={contextSize}
        restartThreshold={restartThreshold}
      />
      <AttachmentList attachments={attachments.attachments} onRemove={attachments.remove} />
      {attachments.isDragOver && (
        <div className="absolute inset-0 bg-primary/10 flex items-center justify-center z-20 pointer-events-none rounded-xl">
          <div className="text-primary font-medium">Drop files here</div>
        </div>
      )}
      <InputContainer
        value={value}
        onChange={onChange}
        disabled={disabled}
        placeholder={placeholder}
        onSubmit={handleSubmit}
        onFilesPicked={(files) => void attachments.processFiles(files)}
        agentCompleted={agentCompleted}
        canSubmit={canSubmit}
        onPause={onPause}
        isPausing={isPausing}
        hasUploadingAttachments={attachments.hasUploading}
        selectedModel={selectedModel}
        onModelChange={onModelChange}
        availableModels={availableModels}
        showModelSelector={showModelSelector}
        textareaRef={textareaRef}
      />
    </>
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
  children: React.ReactNode;
}

function QueryInputShell({
  dripStyles,
  drippiness,
  isDragOver,
  dragHandlers,
  children,
}: QueryInputShellProps) {
  return (
    <div
      className={cn(
        'relative rounded-xl p-3 shadow-lg border overflow-hidden transition-colors',
        isDragOver ? 'border-primary border-2 bg-primary/5' : 'border-border',
      )}
      style={buildDripContainerStyle(dripStyles, drippiness, isDragOver)}
      onDragOver={dragHandlers.onDragOver}
      onDragLeave={dragHandlers.onDragLeave}
      onDrop={dragHandlers.onDrop}
    >
      {dripStyles.backgroundColorsScalar > 0 && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={buildMarbleBackgroundStyle(dripStyles)}
        />
      )}
      <div className="relative z-10">{children}</div>
    </div>
  );
}
