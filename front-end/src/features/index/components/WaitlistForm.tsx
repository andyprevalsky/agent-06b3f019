/**
 * STATE MACHINE: WaitlistForm
 *
 * EXPANSION STATE:
 * [COLLAPSED] <-- isExpanded: false
 *     |
 *     | (click to expand)
 *     v
 * [EXPANDED] <-- isExpanded: true
 *
 * SUBMISSION FLOW:
 * [IDLE] <-- isLoading: false, isSuccess: false
 *     |
 *     | (form submit)
 *     v
 * [LOADING] <-- isLoading: true
 *     |
 *     +--> (success) --> [SUCCESS] <-- isSuccess: true
 *     +--> (error) --> [ERROR] <-- submitError: string
 *     |                    |
 *     |                    v (retry)
 *     +------<-------------+
 *     v
 * [IDLE]
 *
 * States:
 * - isExpanded: boolean
 * - isLoading: boolean
 * - isSuccess: boolean
 * - formData: { name, email }
 * - emailError: string (validation)
 * - submitError: string (API error)
 */

'use client';
import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Mail, User, Check, Loader2 } from 'lucide-react';

import type { WaitlistFormProps } from '../types';
import { useWaitlistForm } from '../hooks';

interface CollapsedButtonProps {
  isLoading: boolean;
  onExpand: () => void;
}

const CollapsedButton: React.FC<CollapsedButtonProps> = ({ isLoading, onExpand }) => (
  <div className="w-full">
    <Button
      onClick={(e) => {
        e.preventDefault();
        onExpand();
      }}
      size="lg"
      className="w-full"
      disabled={isLoading}
    >
      {isLoading ? 'Loading...' : 'Join Waitlist'}
    </Button>
  </div>
);

interface FormFieldProps {
  id: 'name' | 'email';
  label: string;
  type: string;
  placeholder: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  icon: React.ReactNode;
  isLoading: boolean;
  error?: string;
}

const FormField: React.FC<FormFieldProps> = ({
  id,
  label,
  type,
  placeholder,
  value,
  onChange,
  icon,
  isLoading,
  error,
}) => (
  <div className="space-y-2 text-left">
    <Label htmlFor={id} className="block text-left">
      {label}
    </Label>
    <div className="relative">
      <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4">
        {icon}
      </span>
      <Input
        id={id}
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        className="pl-10"
        required
        disabled={isLoading}
      />
    </div>
    {error && <p className="text-sm text-red-500">{error}</p>}
  </div>
);

type FormBodyProps = Pick<
  ReturnType<typeof useWaitlistForm>,
  'formData' | 'emailError' | 'submitError' | 'isLoading' | 'handleInputChange' | 'handleSubmit'
>;

const ExpandedForm: React.FC<FormBodyProps> = ({
  formData,
  emailError,
  submitError,
  isLoading,
  handleInputChange,
  handleSubmit,
}) => (
  <div className="w-full animate-in slide-in-from-top-2 duration-200 md:duration-300">
    <Card className="w-full overflow-hidden">
      <CardContent className="px-0 py-0">
        <form onSubmit={handleSubmit} className="space-y-0">
          <div className="px-6 py-6 space-y-4">
            <FormField
              id="name"
              label="Name"
              type="text"
              placeholder="John Doe"
              value={formData.name}
              onChange={handleInputChange('name')}
              icon={<User className="w-4 h-4" />}
              isLoading={isLoading}
            />
            <FormField
              id="email"
              label="Email"
              type="email"
              placeholder="john@example.com"
              value={formData.email}
              onChange={handleInputChange('email')}
              icon={<Mail className="w-4 h-4" />}
              isLoading={isLoading}
              error={emailError}
            />
            {submitError && (
              <div className="text-sm text-red-500 bg-red-50 dark:bg-red-950/20 p-3 rounded-md">
                {submitError}
              </div>
            )}
          </div>

          <Button type="submit" className="w-full rounded-none" disabled={isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Joining...
              </>
            ) : (
              'Join Waitlist'
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  </div>
);

const SuccessCard: React.FC = () => (
  <div className="w-full animate-in slide-in-from-top-2 duration-200 md:duration-300">
    <Card className="w-full overflow-hidden border-green-500/50 bg-green-50 dark:bg-green-950/20">
      <CardContent className="p-8 text-center">
        <div className="flex flex-col items-center space-y-4">
          <div className="w-16 h-16 rounded-full bg-green-500 flex items-center justify-center animate-in zoom-in duration-300">
            <Check className="w-8 h-8 text-white" />
          </div>
          <div>
            <h3 className="text-2xl font-semibold text-green-700 dark:text-green-400 mb-2">
              You're On The Waitlist
            </h3>
            <p className="text-muted-foreground">We'll notify you when your spot is ready!</p>
          </div>
        </div>
      </CardContent>
    </Card>
  </div>
);

function WaitlistForm({ onSuccess, variant }: WaitlistFormProps) {
  const state = useWaitlistForm(variant, onSuccess);

  if (state.isSuccess) return <SuccessCard />;
  if (!state.isExpanded) {
    return <CollapsedButton isLoading={state.isLoading} onExpand={state.expand} />;
  }
  return <ExpandedForm {...state} />;
}

export default WaitlistForm;
