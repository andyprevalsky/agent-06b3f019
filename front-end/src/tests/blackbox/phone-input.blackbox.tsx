/**
 * Black-box tests for the PhoneInput component (international phone entry
 * with country-code selector), exercised through PhoneAuthModal.
 *
 * Behavior under test:
 *   - defaults to US (+1) and formats national digits as the user types
 *   - a redundant leading 1 is absorbed into the US dial code
 *   - selecting a LATAM country composes the E.164 number with that dial code
 *   - pasting a full international number auto-detects the country
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import { PhoneAuthModal } from '@/features/auth';

describe('PhoneInput (via PhoneAuthModal)', () => {
  const onOpenChange = vi.fn();

  beforeEach(() => {
    clearCaptures();
    localStorage.clear();
    onOpenChange.mockReset();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('formats phone number as user types (US national format, +1 in selector)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    const phoneInput = screen.getByLabelText('Phone Number');
    await user.type(phoneInput, '9729777432');

    // Country selector defaults to US (+1); the input shows the national format
    expect(screen.getByLabelText('Country code')).toHaveValue('US');
    expect(phoneInput).toHaveValue('(972) 977-7432');
  });

  it('absorbs a redundant leading 1 into the US dial code', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    const phoneInput = screen.getByLabelText('Phone Number');
    await user.type(phoneInput, '19729777432');

    expect(screen.getByLabelText('Country code')).toHaveValue('US');
    expect(phoneInput).toHaveValue('(972) 977-7432');
  });

  it('sends E.164 with the selected country dial code (LATAM: Mexico)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    await user.selectOptions(screen.getByLabelText('Country code'), 'MX');
    await user.type(screen.getByLabelText('Phone Number'), '5512345678');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      const sendOtpReq = capturedRequests.find((r) => r.url.includes('/auth/send-otp'));
      expect(sendOtpReq).toBeDefined();
      expect(sendOtpReq!.body).toEqual({ phone: '+525512345678' });
    });
  });

  it('auto-detects the country when a full international number is pasted', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    const phoneInput = screen.getByLabelText('Phone Number');
    await user.click(phoneInput);
    await user.paste('+5215512345678');

    expect(screen.getByLabelText('Country code')).toHaveValue('MX');
  });

  it('does not snap a manual Canada choice back to US while typing (+1 is ambiguous)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    await user.selectOptions(screen.getByLabelText('Country code'), 'CA');
    // Partial +1 number: prefix-fallback would say US; exact parse says nothing yet
    await user.type(screen.getByLabelText('Phone Number'), '20455');

    expect(screen.getByLabelText('Country code')).toHaveValue('CA');
  });

  it('keeps national digits when switching countries', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    const phoneInput = screen.getByLabelText('Phone Number');
    await user.type(phoneInput, '5512345678');
    await user.selectOptions(screen.getByLabelText('Country code'), 'MX');

    expect(screen.getByLabelText('Country code')).toHaveValue('MX');
    expect(phoneInput).toHaveValue('55 1234 5678');
  });
});
