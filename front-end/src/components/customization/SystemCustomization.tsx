/**
 * STATE MACHINE: SystemCustomization
 *
 *   [IDLE] ──────────────────────────────────────────────────────────────────┐
 *     │                                                                       │
 *     ├── (type in name field) → update systemName                           │
 *     ├── (type in prompt field) → update customSystemPrompt                 │
 *     │                                                                       │
 *     └── (click upload) → [UPLOADING] → (success) → update profilePicture ──┘
 *                              │
 *                              └── (error) → show error → [IDLE]
 */

import { useState, useRef } from 'react';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { Button } from '../ui/button';
import { Upload, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase, getSession } from '@/lib/supabase';

// Default profile picture (Rose contact photo)
const DEFAULT_PROFILE_PICTURE = 'https://roselabs.ai/rose-contact.png';

export interface CustomizationData {
  systemName: string;
  profilePicture: string | null;
  customSystemPrompt: string;
}

interface SystemCustomizationProps {
  data: CustomizationData;
  onChange: (data: CustomizationData) => void;
  isLoading?: boolean;
  compact?: boolean;
}

export default function SystemCustomization({
  data,
  onChange,
  isLoading = false,
  compact = false,
}: SystemCustomizationProps) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      setUploadError('Please select an image file');
      return;
    }

    // Validate file size (max 2MB)
    if (file.size > 2 * 1024 * 1024) {
      setUploadError('Image must be smaller than 2MB');
      return;
    }

    setUploading(true);
    setUploadError(null);

    try {
      const session = getSession();
      if (!session?.user?.id) {
        throw new Error('Not authenticated');
      }

      const userId = session.user.id;
      const fileExt = file.name.split('.').pop() || 'png';
      const filePath = `profile-pictures/${userId}/avatar.${fileExt}`;

      // Upload to Supabase Storage
      const { error: uploadError } = await supabase.storage.from('public').upload(filePath, file, {
        upsert: true,
        contentType: file.type,
      });

      if (uploadError) {
        throw uploadError;
      }

      // Get public URL
      const { data: urlData } = supabase.storage.from('public').getPublicUrl(filePath);

      // Add cache buster to force refresh
      const publicUrl = `${urlData.publicUrl}?t=${Date.now()}`;

      onChange({
        ...data,
        profilePicture: publicUrl,
      });
    } catch (error) {
      console.error('Upload error:', error);
      setUploadError(error instanceof Error ? error.message : 'Upload failed');
    } finally {
      setUploading(false);
      // Clear the input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const currentProfilePicture = data.profilePicture || DEFAULT_PROFILE_PICTURE;

  return (
    <div className={cn('space-y-6', compact && 'space-y-4')}>
      {/* System Name Input */}
      <div className="space-y-2">
        <Label htmlFor="systemName">Assistant Name</Label>
        <Input
          id="systemName"
          placeholder="Rose"
          value={data.systemName}
          onChange={(e) => onChange({ ...data, systemName: e.target.value })}
          maxLength={50}
          disabled={isLoading}
          className="border-muted-foreground/30"
        />
        <p className="text-xs text-muted-foreground">
          This name will appear in approval messages and SMS notifications
        </p>
      </div>

      {/* Profile Picture */}
      <div className="space-y-3">
        <Label>Profile Picture</Label>
        <div className="flex items-center gap-4">
          {/* Current profile picture preview */}
          <div className="relative w-16 h-16 rounded-lg overflow-hidden border-2 border-muted-foreground/30 flex-shrink-0">
            <img
              src={currentProfilePicture}
              alt="Profile"
              className="w-full h-full object-cover"
              onError={(e) => {
                (e.target as HTMLImageElement).src = DEFAULT_PROFILE_PICTURE;
              }}
            />
          </div>

          {/* Upload button */}
          <div className="flex flex-col gap-1">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileUpload}
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

      {/* System Prompt */}
      <div className="space-y-2">
        <Label htmlFor="customSystemPrompt">Personality Prompt (Optional)</Label>
        <Textarea
          id="customSystemPrompt"
          placeholder="Describe how you want your assistant to behave..."
          value={data.customSystemPrompt}
          onChange={(e) => onChange({ ...data, customSystemPrompt: e.target.value })}
          maxLength={2000}
          rows={compact ? 3 : 4}
          disabled={isLoading}
          className="resize-none border-muted-foreground/30"
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>This personality will be applied to all your conversations</span>
          <span>{data.customSystemPrompt.length}/2000</span>
        </div>
      </div>
    </div>
  );
}

export { DEFAULT_PROFILE_PICTURE };
