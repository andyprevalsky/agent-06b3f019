import { Loader2, Save, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import type { UserData } from '../types';

interface PersonalInfoTabProps {
  userData: UserData;
  onFieldChange: (field: keyof UserData, value: string) => void;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
}

function AddressFields({
  userData,
  onFieldChange,
}: Pick<PersonalInfoTabProps, 'userData' | 'onFieldChange'>) {
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Delivery Address</h3>

      <div className="space-y-2">
        <Label htmlFor="addressLine1">Address Line 1</Label>
        <Input
          id="addressLine1"
          placeholder="123 Main Street"
          value={userData.addressLine1}
          onChange={(e) => onFieldChange('addressLine1', e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="addressLine2">Address Line 2 (Optional)</Label>
        <Input
          id="addressLine2"
          placeholder="Apt 4B, Suite 100, etc."
          value={userData.addressLine2}
          onChange={(e) => onFieldChange('addressLine2', e.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="city">City</Label>
          <Input
            id="city"
            placeholder="New York"
            value={userData.city}
            onChange={(e) => onFieldChange('city', e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="state">State</Label>
          <Input
            id="state"
            placeholder="NY"
            value={userData.state}
            onChange={(e) => onFieldChange('state', e.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="postalCode">Postal Code</Label>
          <Input
            id="postalCode"
            placeholder="10001"
            value={userData.postalCode}
            onChange={(e) => onFieldChange('postalCode', e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="country">Country</Label>
          <Input
            id="country"
            placeholder="United States"
            value={userData.country}
            onChange={(e) => onFieldChange('country', e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

export default function PersonalInfoTab({
  userData,
  onFieldChange,
  saving,
  saved,
  onSave,
}: PersonalInfoTabProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Personal Information</CardTitle>
        <CardDescription>
          Your information used when purchasing items through your agents
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="name">Full Name</Label>
          <Input
            id="name"
            placeholder="John Doe"
            value={userData.name}
            onChange={(e) => onFieldChange('name', e.target.value)}
          />
        </div>

        <AddressFields userData={userData} onFieldChange={onFieldChange} />

        <div className="flex gap-4 pt-4">
          <Button onClick={onSave} disabled={saving} className="min-w-[120px]">
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : saved ? (
              <>
                <Check className="w-4 h-4 mr-2" />
                Saved!
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                Save Settings
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
