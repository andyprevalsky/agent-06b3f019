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
import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Mail, User, Check, Loader2 } from 'lucide-react';

interface WaitlistFormInput {
  onSuccess?: () => void;
  variant?: string; // "midnight_black", "pearl_white", or "custom"
}

function WaitlistForm({ onSuccess, variant }: WaitlistFormInput) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
  });
  const [emailError, setEmailError] = useState('');
  const [submitError, setSubmitError] = useState('');

  const validateEmail = (email: string) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError('');
    setSubmitError('');

    // Validate email before submission
    if (!validateEmail(formData.email)) {
      setEmailError('Please enter a valid email address');
      return;
    }

    setIsLoading(true);

    try {
      // Use backend API URL (local or production based on env)
      const API_BASE_URL = (
        import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001'
      ).replace(/\/$/, '');
      const API_BASE_WITH_PATH = API_BASE_URL.endsWith('/api')
        ? API_BASE_URL
        : `${API_BASE_URL}/api`;

      // Call backend API
      const response = await fetch(`${API_BASE_WITH_PATH}/waitlist`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: formData.name.trim(),
          email: formData.email.trim().toLowerCase(),
          variant: variant || null,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to join waitlist');
      }

      // Success!
      setIsSuccess(true);
      onSuccess?.();
    } catch (error) {
      console.error('Error joining waitlist:', error);
      setSubmitError(
        error instanceof Error ? error.message : 'Failed to join waitlist. Please try again.',
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleInputChange =
    (field: keyof typeof formData) => (e: React.ChangeEvent<HTMLInputElement>) => {
      setFormData((prev) => ({
        ...prev,
        [field]: e.target.value,
      }));
      // Clear errors when user types
      if (field === 'email') {
        setEmailError('');
      }
      setSubmitError('');
    };

  return (
    <>
      {/* Collapsed state - Button sits outside any card */}
      {!isExpanded && (
        <div className="w-full">
          <Button
            onClick={(e) => {
              e.preventDefault();
              setIsExpanded(true);
            }}
            size="lg"
            className="w-full"
            disabled={isLoading}
          >
            {isLoading ? 'Loading...' : 'Join Waitlist'}
          </Button>
        </div>
      )}

      {/* Expanded state - Form inside card with animation */}
      {isExpanded && !isSuccess && (
        <div className="w-full animate-in slide-in-from-top-2 duration-200 md:duration-300">
          <Card className="w-full overflow-hidden">
            <CardContent className="px-0 py-0">
              <form onSubmit={handleSubmit} className="space-y-0">
                <div className="px-6 py-6 space-y-4">
                  <div className="space-y-2 text-left">
                    <Label htmlFor="name" className="block text-left">
                      Name
                    </Label>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
                      <Input
                        id="name"
                        type="text"
                        placeholder="John Doe"
                        value={formData.name}
                        onChange={handleInputChange('name')}
                        className="pl-10"
                        required
                        disabled={isLoading}
                      />
                    </div>
                  </div>

                  <div className="space-y-2 text-left">
                    <Label htmlFor="email" className="block text-left">
                      Email
                    </Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
                      <Input
                        id="email"
                        type="email"
                        placeholder="john@example.com"
                        value={formData.email}
                        onChange={handleInputChange('email')}
                        className="pl-10"
                        required
                        disabled={isLoading}
                      />
                    </div>
                    {emailError && <p className="text-sm text-red-500">{emailError}</p>}
                  </div>

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
      )}

      {/* Success state */}
      {isSuccess && (
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
      )}
    </>
  );
}

export default WaitlistForm;
