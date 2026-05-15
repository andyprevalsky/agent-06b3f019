/**
 * STATE MACHINE: SystemCustomization
 *
 *   [IDLE] ──────────────────────────────────────────────────────────────────┐
 *     │                                                                       │
 *     ├── (type in name field) → update systemName                           │
 *     ├── (type in prompt field) → update customSystemPrompt                 │
 *     ├── (promptReplacement provided) → render replacement instead of prompt │
 *     │                                                                       │
 *     └── (click upload) → [UPLOADING] → (success) → update profilePicture ──┘
 *                              │
 *                              └── (error) → show error → [IDLE]
 */

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Upload, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

import type { CustomizationData, SystemCustomizationProps } from '../types';
import { DEFAULT_PROFILE_PICTURE, MAX_NAME_LENGTH, MAX_PROMPT_LENGTH } from '../config';
import { useFileUpload } from '../hooks';

function NameField({
  data,
  onChange,
  isLoading,
}: {
  data: CustomizationData;
  onChange: (d: CustomizationData) => void;
  isLoading: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="systemName">Assistant Name</Label>
      <Input
        id="systemName"
        placeholder="Rose"
        value={data.systemName}
        onChange={(e) => onChange({ ...data, systemName: e.target.value })}
        maxLength={MAX_NAME_LENGTH}
        disabled={isLoading}
        className="border-muted-foreground/30"
      />
      <p className="text-xs text-muted-foreground">
        This name will appear in approval messages and SMS notifications
      </p>
    </div>
  );
}

function ProfilePictureField({
  data,
  onChange,
  isLoading,
}: {
  data: CustomizationData;
  onChange: (d: CustomizationData) => void;
  isLoading: boolean;
}) {
  const { uploading, uploadError, fileInputRef, handleFileUpload } = useFileUpload(data, onChange);
  const currentPicture = data.profilePicture || DEFAULT_PROFILE_PICTURE;

  return (
    <div className="space-y-3">
      <Label>Profile Picture</Label>
      <div className="flex items-center gap-4">
        <div className="relative w-16 h-16 rounded-lg overflow-hidden border-2 border-muted-foreground/30 flex-shrink-0">
          <img
            src={currentPicture}
            alt="Profile"
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).src = DEFAULT_PROFILE_PICTURE;
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={(e) => void handleFileUpload(e)}
            className="hidden"
            disabled={isLoading || uploading}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading || uploading}
          >
            {uploading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Uploading...
              </>
            ) : (
              <>
                <Upload className="w-4 h-4 mr-2" />
                Upload Custom Image
              </>
            )}
          </Button>
          {uploadError && <span className="text-xs text-destructive">{uploadError}</span>}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        This image will appear on the contact card saved to your phone
      </p>
    </div>
  );
}

function PromptField({
  data,
  onChange,
  isLoading,
  compact,
}: {
  data: CustomizationData;
  onChange: (d: CustomizationData) => void;
  isLoading: boolean;
  compact: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="customSystemPrompt">Personality Prompt (Optional)</Label>
      <Textarea
        id="customSystemPrompt"
        placeholder="Describe how you want your assistant to behave..."
        value={data.customSystemPrompt}
        onChange={(e) => onChange({ ...data, customSystemPrompt: e.target.value })}
        maxLength={MAX_PROMPT_LENGTH}
        rows={compact ? 3 : 4}
        disabled={isLoading}
        className="resize-none border-muted-foreground/30"
      />
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>This personality will be applied to all your conversations</span>
        <span>
          {data.customSystemPrompt.length}/{MAX_PROMPT_LENGTH}
        </span>
      </div>
    </div>
  );
}

export default function SystemCustomization({
  data,
  onChange,
  isLoading = false,
  compact = false,
  promptReplacement,
}: SystemCustomizationProps) {
  return (
    <div className={cn('space-y-6', compact && 'space-y-4')}>
      <NameField data={data} onChange={onChange} isLoading={isLoading} />
      <ProfilePictureField data={data} onChange={onChange} isLoading={isLoading} />
      {promptReplacement ?? (
        <PromptField data={data} onChange={onChange} isLoading={isLoading} compact={compact} />
      )}
    </div>
  );
}
