import { Loader2, Save, Check, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SystemCustomization, type CustomizationData } from '@/features/customization';

interface CustomizationTabProps {
  customization: CustomizationData;
  onCustomizationChange: (data: CustomizationData) => void;
  loading: boolean;
  savingCustomization: boolean;
  savedCustomization: boolean;
  onSave: () => void;
}

export default function CustomizationTab({
  customization,
  onCustomizationChange,
  loading,
  savingCustomization,
  savedCustomization,
  onSave,
}: CustomizationTabProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="w-5 h-5" />
          Customize Your Assistant
        </CardTitle>
        <CardDescription>
          Personalize your AI assistant's name, appearance, and personality
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <SystemCustomization
          data={customization}
          onChange={onCustomizationChange}
          isLoading={loading || savingCustomization}
        />

        <div className="flex gap-4 pt-4 border-t">
          <Button onClick={onSave} disabled={savingCustomization} className="min-w-[160px]">
            {savingCustomization ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : savedCustomization ? (
              <>
                <Check className="w-4 h-4 mr-2" />
                Saved!
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                Save Customization
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
