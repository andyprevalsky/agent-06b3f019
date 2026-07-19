import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PhoneAuthModal } from '@/features/auth';

import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';

describe('PhoneAuthModal waitlist profile collection', () => {
  const onOpenChange = vi.fn();

  beforeEach(() => {
    clearCaptures();
    onOpenChange.mockReset();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('collects required first and last names after email and persists them on verify', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <PhoneAuthModal open={true} onOpenChange={onOpenChange} collectName={true} />,
    );

    const emailInput = screen.getByLabelText('Email');
    const firstNameInput = screen.getByLabelText('First name');
    const lastNameInput = screen.getByLabelText('Last name');
    expect(emailInput.compareDocumentPosition(firstNameInput)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(firstNameInput.compareDocumentPosition(lastNameInput)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    await user.type(screen.getByLabelText('Phone Number'), '9729777432');
    await user.type(emailInput, 'person@example.com');
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();

    await user.type(firstNameInput, 'Ada');
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();

    await user.type(lastNameInput, 'Lovelace');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByLabelText('Verification Code')).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText('Verification Code'), '181818');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => {
      const verifyReq = capturedRequests.find((request) =>
        request.url.includes('/auth/verify-otp'),
      );
      expect(verifyReq).toBeDefined();
      const body = verifyReq!.body as Record<string, unknown>;
      expect(body.firstName).toBe('Ada');
      expect(body.lastName).toBe('Lovelace');
      expect(body.email).toBe('person@example.com');
    });
  });
});
