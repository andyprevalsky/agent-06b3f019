/**
 * STATE MACHINE: Personal information
 *
 * [READY] --edit personal/delivery field--> [DIRTY]
 *    ^                                      |
 *    |                                      v save
 * [SAVED] <----------------------------- [SAVING]
 *    |                                      |
 *    +---------- after 3 seconds -----------+ error -> [DIRTY]
 *
 * The verified phone is read-only. Personal identity and delivery recipient
 * are edited independently, then persisted together by the parent settings flow.
 *
 * Fields live inside a single <form> so the browser groups the shipping-address
 * inputs (autoComplete="shipping ...") and offers native address autofill.
 * Submitting the form (Save button or Enter) triggers the parent save handler.
 */

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

function PersonalFields({
  userData,
  onFieldChange,
}: Pick<PersonalInfoTabProps, 'userData' | 'onFieldChange'>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Personal Information</CardTitle>
        <CardDescription>
          Your identity and contact details. Agents use these details when referring to you.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Personal Full Name</Label>
          <Input
            id="name"
            autoComplete="name"
            placeholder="John Doe"
            value={userData.name}
            onChange={(event) => onFieldChange('name', event.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={userData.email}
            onChange={(event) => onFieldChange('email', event.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="phone">Verified Phone</Label>
          <Input id="phone" type="tel" value={userData.phone} disabled />
          <p className="text-sm text-muted-foreground">
            This is the verified phone number associated with your account.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function DeliveryFields({ userData, onFieldChange, saving, saved }: PersonalInfoTabProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Delivery Address</CardTitle>
        <CardDescription>
          The recipient and address agents should use for deliveries and purchases.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="deliveryRecipientName">Recipient Full Name</Label>
          <Input
            id="deliveryRecipientName"
            autoComplete="shipping name"
            placeholder="Delivery recipient"
            value={userData.deliveryRecipientName}
            onChange={(event) => onFieldChange('deliveryRecipientName', event.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="addressLine1">Address Line 1</Label>
          <Input
            id="addressLine1"
            autoComplete="shipping address-line1"
            placeholder="123 Main Street"
            value={userData.addressLine1}
            onChange={(event) => onFieldChange('addressLine1', event.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="addressLine2">Address Line 2 (Optional)</Label>
          <Input
            id="addressLine2"
            autoComplete="shipping address-line2"
            placeholder="Apt 4B, Suite 100, etc."
            value={userData.addressLine2}
            onChange={(event) => onFieldChange('addressLine2', event.target.value)}
          />
        </div>

        <DeliveryLocationFields userData={userData} onFieldChange={onFieldChange} />

        <div className="flex gap-4 pt-4">
          <Button type="submit" disabled={saving} className="min-w-[120px]">
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : saved ? (
              <>
                <Check className="mr-2 h-4 w-4" />
                Saved!
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" />
                Save Settings
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DeliveryLocationFields({
  userData,
  onFieldChange,
}: Pick<PersonalInfoTabProps, 'userData' | 'onFieldChange'>) {
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="city">City</Label>
          <Input
            id="city"
            autoComplete="shipping address-level2"
            placeholder="New York"
            value={userData.city}
            onChange={(event) => onFieldChange('city', event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="state">State</Label>
          <Input
            id="state"
            autoComplete="shipping address-level1"
            placeholder="NY"
            value={userData.state}
            onChange={(event) => onFieldChange('state', event.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="postalCode">Postal Code</Label>
          <Input
            id="postalCode"
            autoComplete="shipping postal-code"
            placeholder="10001"
            value={userData.postalCode}
            onChange={(event) => onFieldChange('postalCode', event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="country">Country</Label>
          <Input
            id="country"
            autoComplete="shipping country-name"
            placeholder="United States"
            value={userData.country}
            onChange={(event) => onFieldChange('country', event.target.value)}
          />
        </div>
      </div>
    </>
  );
}

export default function PersonalInfoTab(props: PersonalInfoTabProps) {
  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave();
      }}
    >
      <PersonalFields userData={props.userData} onFieldChange={props.onFieldChange} />
      <DeliveryFields {...props} />
    </form>
  );
}
