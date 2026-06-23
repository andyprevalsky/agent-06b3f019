/**
 * AgentPayModal domain blackbox tests — file-level boundary for
 * `mac-app/ui/components/AgentPayModal.tsx`.
 *
 * Source under test: a controlled modal (`isOpen`, `onClose`, `onSuccess` props)
 * that:
 *   1. On open, fetches `GET ${VITE_BACKEND_API_URL}/api/user-settings` with a
 *      bearer token from `getSession()` (localStorage-backed) and pre-fills:
 *        - shipping address fields
 *        - saved payment envelope (decoded from `encryptedPaymentInformation`)
 *   2. Shows a saved-card summary (masked last-4 + city/country + autopay limit)
 *      when an envelope is present; otherwise shows the full card form.
 *   3. Validates the payment form client-side (card#, cardholder, expiry, CVV,
 *      billing address, shipping address when not "same as billing").
 *   4. On save, encrypts via `encryptPaymentData()` (hybrid RSA+AES via Web
 *      Crypto) and PATCHes `/api/user-settings` with the encrypted envelope and
 *      shipping fields, then calls `onSuccess()`.
 *   5. Surfaces a human-readable error banner on save failure and keeps the
 *      modal open; surfaces console-logged error on initial fetch failure but
 *      does NOT block the user from filling the form.
 *
 * We only assert on user-visible DOM and captured network requests — no
 * internal hook state, no mocked encryption internals. The real Web Crypto
 * implementation is used (Node 20+ exposes `globalThis.crypto.subtle`).
 *
 * State-machine sketch:
 *   closed --isOpen--> loading --GET 200--> [savedEnvelope ? saved-summary : card-form]
 *                                 --GET 4xx/5xx--> card-form (silent, logged)
 *   saved-summary --click "Update"--> card-form
 *   card-form --invalid submit--> card-form (with per-field errors)
 *   card-form --valid submit + PATCH 200--> onSuccess() called, modal closes
 *   card-form --valid submit + PATCH 4xx/5xx--> card-form with error banner
 *   any-open --click backdrop | Cancel | X--> onClose() (unless saving)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { renderWithProviders } from './test-wrapper';
import { clearIpcMock, installIpcMock } from './ipc-mock';
import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import AgentPayModal from '../../ui/components/AgentPayModal';
import type { EncryptedPaymentEnvelope } from '@/lib/encryption';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const API_BASE = 'http://localhost:3001/api';
const SESSION_KEY = 'rose-session';
const ACCESS_TOKEN = 'test-access-token-agent-pay';

function primeSession(): void {
  const session = {
    access_token: ACCESS_TOKEN,
    refresh_token: 'test-refresh-token',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'test-user-agent-pay', phone: '+19729777432' },
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function buildSavedEnvelope(): EncryptedPaymentEnvelope {
  return {
    version: 1,
    encrypted_aes_key: 'fake-aes-key',
    iv: 'fake-iv',
    ciphertext: 'fake-ciphertext',
    card_last_four: '4242',
    card_type: 'visa',
    billing_city: 'San Francisco',
    billing_country: 'United States',
    autoagentpaylimit_cents: 25000,
  };
}

function encodeEnvelope(env: EncryptedPaymentEnvelope): string {
  return btoa(JSON.stringify(env));
}

function parseBody(body: string | null): Record<string, unknown> {
  if (body === null) return {};
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Fill the billing card form (first occurrence of shared placeholders — the
 * delivery address reuses `John Doe`/`123 Main Street`/`New York`/`NY`/`10001`
 * which is why we index via `getAllByPlaceholderText`).
 */
async function fillValidCardForm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByPlaceholderText('4111 1111 1111 1111'), '4111111111111111');
  await user.type(screen.getAllByPlaceholderText('John Doe')[0], 'Andy Prevalsky');
  await user.type(screen.getByPlaceholderText('MM/YY'), '1230');
  await user.type(screen.getByPlaceholderText('123'), '123');
  await user.type(screen.getAllByPlaceholderText('123 Main Street')[0], '100 Market St');
  await user.type(screen.getAllByPlaceholderText('New York')[0], 'San Francisco');
  await user.type(screen.getAllByPlaceholderText('NY')[0], 'CA');
  await user.type(screen.getAllByPlaceholderText('10001')[0], '94103');
}

beforeEach(() => {
  // capturedRequests is cleared globally in setup.ts::afterEach; only auth
  // state needs explicit per-test priming.
  localStorage.clear();
  primeSession();
  installIpcMock();
});

afterEach(() => {
  cleanup();
  clearIpcMock();
  localStorage.clear();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Module boundary
// ---------------------------------------------------------------------------

describe('AgentPayModal — module boundary', () => {
  it('default-exports a React component', () => {
    expect(typeof AgentPayModal).toBe('function');
  });

  it('renders nothing when isOpen=false (no portal, no fetch)', async () => {
    renderWithProviders(<AgentPayModal isOpen={false} onClose={() => {}} onSuccess={() => {}} />);

    expect(screen.queryByText('Agent Pay')).not.toBeInTheDocument();
    // Give any stray fetch a tick to fire — none should.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const settingsReqs = capturedRequests.filter((r) => r.url.includes('/api/user-settings'));
    expect(settingsReqs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Initial render / empty state (no saved card)
// ---------------------------------------------------------------------------

describe('AgentPayModal — initial render (no saved card)', () => {
  beforeEach(() => {
    // Default handler: user-settings exists but has no encryptedPaymentInformation.
    server.use(
      http.get(`${API_BASE}/user-settings`, () =>
        HttpResponse.json({
          name: '',
          addressLine1: '',
          city: '',
          state: '',
          postalCode: '',
          country: 'United States',
        })
      )
    );
  });

  it('renders the header, security notice, and card form after initial fetch', async () => {
    renderWithProviders(<AgentPayModal isOpen={true} onClose={() => {}} onSuccess={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Agent Pay')).toBeInTheDocument();
    });

    // The SecurityNotice + card form render only once the initial GET resolves
    // (initialLoading → false). The header above is present even while loading,
    // so wait for the post-fetch content before asserting on it.
    await waitFor(() => {
      expect(screen.getByText(/All card credentials are end-to-end encrypted/)).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /Create Card via Privacy\.com/ })).toHaveAttribute(
      'href',
      'https://privacy.com'
    );
    // Card form is visible (empty state — no saved card)
    expect(screen.getByText('Card Information')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('4111 1111 1111 1111')).toBeInTheDocument();
    expect(screen.getByText('Billing Address')).toBeInTheDocument();
    expect(screen.getByText('Delivery Address')).toBeInTheDocument();
    // Save button label in empty state
    expect(screen.getByRole('button', { name: 'Save Payment' })).toBeInTheDocument();
  });

  it('formats card number into groups of 4 and caps at 16 digits', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgentPayModal isOpen={true} onClose={() => {}} onSuccess={() => {}} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('4111 1111 1111 1111')).toBeInTheDocument();
    });

    const cardInput = screen.getByPlaceholderText('4111 1111 1111 1111');
    // Includes extra digits beyond 16 and non-digits — should be stripped and capped
    await user.type(cardInput, 'abc4111111111111111199');
    expect(cardInput).toHaveValue('4111 1111 1111 1111');
  });

  it('formats expiry as MM/YY and CVV strips non-digits', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgentPayModal isOpen={true} onClose={() => {}} onSuccess={() => {}} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('MM/YY')).toBeInTheDocument();
    });

    const expiryInput = screen.getByPlaceholderText('MM/YY');
    await user.type(expiryInput, '1230');
    expect(expiryInput).toHaveValue('12/30');

    const cvvInput = screen.getByPlaceholderText('123');
    await user.type(cvvInput, '12a34');
    expect(cvvInput).toHaveValue('1234');
  });
});

// ---------------------------------------------------------------------------
// Saved card state
// ---------------------------------------------------------------------------

describe('AgentPayModal — saved card state', () => {
  it('shows masked card summary + autopay limit when envelope is present', async () => {
    server.use(
      http.get(`${API_BASE}/user-settings`, () =>
        HttpResponse.json({
          name: 'Andy Prevalsky',
          addressLine1: '100 Market St',
          city: 'San Francisco',
          state: 'CA',
          postalCode: '94103',
          country: 'United States',
          encryptedPaymentInformation: encodeEnvelope(buildSavedEnvelope()),
        })
      )
    );

    renderWithProviders(<AgentPayModal isOpen={true} onClose={() => {}} onSuccess={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/\*\*\*\* \*\*\*\* \*\*\*\* 4242/)).toBeInTheDocument();
    });
    expect(screen.getByText('San Francisco, United States')).toBeInTheDocument();
    expect(screen.getByText('$250.00')).toBeInTheDocument();
    // Card form NOT shown when saved card present and not editing
    expect(screen.queryByText('Card Information')).not.toBeInTheDocument();
    // Save button label changes when not editing card
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save Payment' })).not.toBeInTheDocument();
  });

  it('clicking "Update" reveals the full card form (edit flow)', async () => {
    server.use(
      http.get(`${API_BASE}/user-settings`, () =>
        HttpResponse.json({
          encryptedPaymentInformation: encodeEnvelope(buildSavedEnvelope()),
        })
      )
    );
    const user = userEvent.setup();
    renderWithProviders(<AgentPayModal isOpen={true} onClose={() => {}} onSuccess={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Update/ })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Update/ }));

    expect(screen.getByText('Card Information')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('4111 1111 1111 1111')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Payment' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Validation (error state)
// ---------------------------------------------------------------------------

describe('AgentPayModal — client-side validation', () => {
  beforeEach(() => {
    server.use(
      http.get(`${API_BASE}/user-settings`, () =>
        HttpResponse.json({
          country: 'United States',
        })
      )
    );
  });

  it('shows required-field errors and does NOT PATCH when submitting an empty card form', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderWithProviders(<AgentPayModal isOpen={true} onClose={() => {}} onSuccess={onSuccess} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save Payment' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Save Payment' }));

    // Per-field billing errors surfaced (unique messages)
    expect(screen.getByText('Card number is required')).toBeInTheDocument();
    expect(screen.getByText('Cardholder name is required')).toBeInTheDocument();
    expect(screen.getByText('Expiry date is required')).toBeInTheDocument();
    expect(screen.getByText('CVV is required')).toBeInTheDocument();
    expect(screen.getByText('Street address is required')).toBeInTheDocument();
    expect(screen.getByText('ZIP code is required')).toBeInTheDocument();
    // "City is required" / "State is required" appear once for billing AND once
    // for shipping (same message string, different field keys). Assert on the
    // count rather than singular presence to keep the intent explicit.
    expect(screen.getAllByText('City is required')).toHaveLength(2);
    expect(screen.getAllByText('State is required')).toHaveLength(2);

    // Shipping-only errors (delivery address required since sameAsBilling default false)
    expect(screen.getByText('Name is required')).toBeInTheDocument();
    expect(screen.getByText('Address is required')).toBeInTheDocument();
    expect(screen.getByText('Postal code is required')).toBeInTheDocument();

    // No PATCH fired
    const patchReqs = capturedRequests.filter(
      (r) => r.method === 'PATCH' && r.url.includes('/api/user-settings')
    );
    expect(patchReqs).toHaveLength(0);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('flags an invalid card number (fails Luhn) without PATCHing', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderWithProviders(<AgentPayModal isOpen={true} onClose={() => {}} onSuccess={onSuccess} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('4111 1111 1111 1111')).toBeInTheDocument();
    });

    // 16 digits but fails Luhn
    await user.type(screen.getByPlaceholderText('4111 1111 1111 1111'), '4111111111111112');
    await user.type(screen.getAllByPlaceholderText('John Doe')[0], 'Andy Prevalsky');
    await user.type(screen.getByPlaceholderText('MM/YY'), '1230');
    await user.type(screen.getByPlaceholderText('123'), '123');
    await user.type(screen.getAllByPlaceholderText('123 Main Street')[0], '100 Market St');
    await user.type(screen.getAllByPlaceholderText('New York')[0], 'SF');
    await user.type(screen.getAllByPlaceholderText('NY')[0], 'CA');
    await user.type(screen.getAllByPlaceholderText('10001')[0], '94103');
    // Same-as-billing shortcut so shipping isn't a blocker
    await user.click(screen.getByRole('checkbox'));

    await user.click(screen.getByRole('button', { name: 'Save Payment' }));

    expect(screen.getByText('Invalid card number')).toBeInTheDocument();
    const patchReqs = capturedRequests.filter(
      (r) => r.method === 'PATCH' && r.url.includes('/api/user-settings')
    );
    expect(patchReqs).toHaveLength(0);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('"Same as billing" hides the delivery address form and clears its errors', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgentPayModal isOpen={true} onClose={() => {}} onSuccess={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Delivery Address')).toBeInTheDocument();
    });

    // Full Name field is the delivery-address "Full Name" field only
    expect(screen.getByText('Full Name')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox'));
    expect(screen.queryByText('Full Name')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Happy path — save flow with real Web Crypto encryption
// ---------------------------------------------------------------------------

describe('AgentPayModal — happy path save', () => {
  beforeEach(() => {
    server.use(
      http.get(`${API_BASE}/user-settings`, () =>
        HttpResponse.json({
          country: 'United States',
        })
      ),
      http.patch(`${API_BASE}/user-settings`, () => HttpResponse.json({ success: true }))
    );
  });

  it('encrypts, PATCHes with envelope + shipping fields, and calls onSuccess', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderWithProviders(<AgentPayModal isOpen={true} onClose={() => {}} onSuccess={onSuccess} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('4111 1111 1111 1111')).toBeInTheDocument();
    });

    await fillValidCardForm(user);
    // Same as billing → shipping derived from billing
    await user.click(screen.getByRole('checkbox'));

    // Clear any fetch captures from the initial GET
    clearCaptures();

    await user.click(screen.getByRole('button', { name: 'Save Payment' }));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    const patchReq = capturedRequests.find(
      (r) => r.method === 'PATCH' && r.url.includes('/api/user-settings')
    );
    expect(patchReq).toBeDefined();
    expect(patchReq!.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(patchReq!.headers['content-type']).toBe('application/json');

    const body = parseBody(patchReq!.body);
    // Encrypted envelope present as base64 string
    expect(typeof body.encryptedPaymentInformation).toBe('string');
    // Parse back the envelope and assert metadata matches inputs
    const encoded = body.encryptedPaymentInformation as string;
    const envelope = JSON.parse(atob(encoded)) as EncryptedPaymentEnvelope;
    expect(envelope.version).toBe(1);
    expect(envelope.card_last_four).toBe('1111');
    expect(envelope.card_type).toBe('visa');
    expect(envelope.billing_city).toBe('San Francisco');
    expect(envelope.billing_country).toBe('United States');
    expect(envelope.autoagentpaylimit_cents).toBe(10000); // default "100.00"
    expect(typeof envelope.ciphertext).toBe('string');
    expect(envelope.ciphertext.length).toBeGreaterThan(0);
    expect(typeof envelope.encrypted_aes_key).toBe('string');
    expect(envelope.encrypted_aes_key.length).toBeGreaterThan(0);

    // Shipping derived from billing (same-as-billing checked)
    expect(body.name).toBe('Andy Prevalsky');
    expect(body.addressLine1).toBe('100 Market St');
    expect(body.city).toBe('San Francisco');
    expect(body.state).toBe('CA');
    expect(body.postalCode).toBe('94103');
    expect(body.country).toBe('United States');
  });

  it('when saved card exists and user does NOT click Update, PATCH omits encryptedPaymentInformation', async () => {
    server.use(
      http.get(`${API_BASE}/user-settings`, () =>
        HttpResponse.json({
          name: 'Old Name',
          addressLine1: '1 Old St',
          city: 'Old City',
          state: 'OS',
          postalCode: '00001',
          country: 'United States',
          encryptedPaymentInformation: encodeEnvelope(buildSavedEnvelope()),
        })
      ),
      http.patch(`${API_BASE}/user-settings`, () => HttpResponse.json({ success: true }))
    );

    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderWithProviders(<AgentPayModal isOpen={true} onClose={() => {}} onSuccess={onSuccess} />);

    await waitFor(() => {
      expect(screen.getByText(/\*\*\*\* \*\*\*\* \*\*\*\* 4242/)).toBeInTheDocument();
    });

    // Submit without editing card — uses saved shipping address
    clearCaptures();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    const patchReq = capturedRequests.find(
      (r) => r.method === 'PATCH' && r.url.includes('/api/user-settings')
    );
    expect(patchReq).toBeDefined();
    const body = parseBody(patchReq!.body);
    expect(body.encryptedPaymentInformation).toBeUndefined();
    expect(body.name).toBe('Old Name');
    expect(body.addressLine1).toBe('1 Old St');
    expect(body.city).toBe('Old City');
  });
});

// ---------------------------------------------------------------------------
// Error surface
// ---------------------------------------------------------------------------

describe('AgentPayModal — save failure', () => {
  beforeEach(() => {
    server.use(
      http.get(`${API_BASE}/user-settings`, () =>
        HttpResponse.json({
          country: 'United States',
        })
      )
    );
  });

  it('surfaces a friendly error banner when PATCH returns 500, keeps modal open, no onSuccess', async () => {
    server.use(
      http.patch(`${API_BASE}/user-settings`, () =>
        HttpResponse.json({ error: 'Database unavailable' }, { status: 500 })
      )
    );
    // Component logs the error to console.error before surfacing it in the UI;
    // suppress to keep test output clean while still asserting the UI surface.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const user = userEvent.setup();
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(<AgentPayModal isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('4111 1111 1111 1111')).toBeInTheDocument();
    });

    await fillValidCardForm(user);
    await user.click(screen.getByRole('checkbox'));

    await user.click(screen.getByRole('button', { name: 'Save Payment' }));

    await waitFor(() => {
      expect(screen.getByText('Failed to save payment information')).toBeInTheDocument();
    });

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // Modal still open — save button is re-enabled
    expect(screen.getByRole('button', { name: 'Save Payment' })).toBeEnabled();
    // No raw stack traces leaked
    expect(screen.queryByText(/TypeError:/)).not.toBeInTheDocument();
    errorSpy.mockRestore();
  });

  it('surfaces "Not authenticated" error when session is missing', async () => {
    localStorage.clear();
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderWithProviders(<AgentPayModal isOpen={true} onClose={() => {}} onSuccess={onSuccess} />);

    // Without a session, the initial GET is skipped entirely, so the form
    // appears synchronously — no `setInitialLoading(true)` is ever called.
    await fillValidCardForm(user);
    await user.click(screen.getByRole('checkbox'));

    await user.click(screen.getByRole('button', { name: 'Save Payment' }));

    await waitFor(() => {
      expect(screen.getByText('Not authenticated')).toBeInTheDocument();
    });

    expect(onSuccess).not.toHaveBeenCalled();
    const patchReqs = capturedRequests.filter(
      (r) => r.method === 'PATCH' && r.url.includes('/api/user-settings')
    );
    expect(patchReqs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Close behavior
// ---------------------------------------------------------------------------

describe('AgentPayModal — close interactions', () => {
  beforeEach(() => {
    server.use(
      http.get(`${API_BASE}/user-settings`, () => HttpResponse.json({ country: 'United States' }))
    );
  });

  it('Cancel button invokes onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithProviders(<AgentPayModal isOpen={true} onClose={onClose} onSuccess={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Fetch boundary capture
// ---------------------------------------------------------------------------

describe('AgentPayModal — fetch boundary capture', () => {
  it('GETs /api/user-settings with bearer token on open', async () => {
    server.use(
      http.get(`${API_BASE}/user-settings`, () => HttpResponse.json({ country: 'United States' }))
    );

    renderWithProviders(<AgentPayModal isOpen={true} onClose={() => {}} onSuccess={() => {}} />);

    await waitFor(() => {
      const getReq = capturedRequests.find(
        (r) => r.method === 'GET' && r.url.includes('/api/user-settings')
      );
      expect(getReq).toBeDefined();
    });

    const getReq = capturedRequests.find(
      (r) => r.method === 'GET' && r.url.includes('/api/user-settings')
    )!;
    expect(getReq.url).toBe(`${API_BASE}/user-settings`);
    expect(getReq.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(getReq.body).toBeNull();
  });

  it('does NOT GET when no session is present (auth-gate)', async () => {
    localStorage.clear();
    renderWithProviders(<AgentPayModal isOpen={true} onClose={() => {}} onSuccess={() => {}} />);

    // Wait a tick to be sure no deferred fetch fires.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const getReqs = capturedRequests.filter(
      (r) => r.method === 'GET' && r.url.includes('/api/user-settings')
    );
    expect(getReqs).toHaveLength(0);
  });

  it('tolerates an initial GET 500 without blocking the user (form still usable)', async () => {
    server.use(
      http.get(`${API_BASE}/user-settings`, () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 })
      )
    );
    // Suppress the expected console.error emitted by the component's catch.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderWithProviders(<AgentPayModal isOpen={true} onClose={() => {}} onSuccess={() => {}} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('4111 1111 1111 1111')).toBeInTheDocument();
    });
    // No user-facing stack / error banner (silent recovery)
    expect(screen.queryByText(/TypeError:/)).not.toBeInTheDocument();
    errorSpy.mockRestore();
  });
});
