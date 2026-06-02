/**
 * Blackbox coverage for the onboarding agent customization step.
 *
 * Source under test: `ui/features/onboarding/components/OnboardingCustomization.tsx`.
 *
 * State-machine sketch:
 *   loading --GET user-settings--> ready
 *   ready --edit name / pick voice / paste custom id--> ready
 *   ready --Continue + PATCH 200--> complete callback + local voice preference
 *   ready --custom voice with empty id--> ready with validation error
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { renderWithProviders } from './test-wrapper';
import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import OnboardingCustomization from '../../ui/features/onboarding/components/OnboardingCustomization';
import { resolveVoiceOrbSrc } from '../../ui/features/onboarding/components/VoiceOrb';
import {
  resolveCustomPreviewApiUrl,
  resolvePresetSamplePath,
} from '../../ui/features/onboarding/api';

const API_BASE = 'http://localhost:3001/api';
const SESSION_KEY = 'rose-session';
const VOICE_STORAGE_KEY = 'rose.onboarding.voicePreference';

function primeSession(): void {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      access_token: 'test-access-token-onboarding-customization',
      refresh_token: 'test-refresh-token',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user: { id: 'test-user-onboarding-customization', phone: '+19729777432' },
    })
  );
}

function parseBody(body: string | null): Record<string, unknown> {
  if (body === null) return {};
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

beforeEach(() => {
  clearCaptures();
  localStorage.clear();
  primeSession();
  vi.stubGlobal(
    'Audio',
    class {
      src = '';
      currentTime = 0;
      pause(): void {}
      async play(): Promise<void> {}
    }
  );
  // jsdom doesn't implement HTMLMediaElement.play; stub it so the looping
  // VoiceOrb video mounts.
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: async function play(): Promise<void> {},
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    value: function pause(): void {},
  });
  server.use(
    http.get(`${API_BASE}/user-settings`, () =>
      HttpResponse.json({
        systemName: 'Rose',
        profilePicture: null,
        customSystemPrompt: 'Old personality should not render',
      })
    ),
    http.get(`${API_BASE}/voices/:voiceId/preview`, () =>
      HttpResponse.json({ url: 'https://example.com/preview.mp3' })
    ),
    http.get('/api/voices/:voiceId/preview', () =>
      HttpResponse.json({ url: 'https://example.com/preview.mp3' })
    )
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('OnboardingCustomization', () => {
  it('resolves the orb video against Vite base paths so file:// production builds can load it', () => {
    expect(resolveVoiceOrbSrc('/')).toBe('/voice-orb.mp4');
    expect(resolveVoiceOrbSrc('./')).toBe('./voice-orb.mp4');
    expect(resolveVoiceOrbSrc('/nested/app')).toBe('/nested/app/voice-orb.mp4');
  });

  it('resolves voice preview audio against production-safe asset and API URLs', () => {
    expect(resolvePresetSamplePath('voice id/with space', './')).toBe(
      './voice-samples/voice%20id%2Fwith%20space.mp3'
    );
    expect(resolvePresetSamplePath('voice-id', '/nested/app')).toBe(
      '/nested/app/voice-samples/voice-id.mp3'
    );
    expect(resolveCustomPreviewApiUrl('custom/id', 'https://api.example.test')).toBe(
      'https://api.example.test/api/voices/custom%2Fid/preview'
    );
  });

  it('renders the new title, name field, and 4-slot voice carousel without profile picture or personality prompt', async () => {
    renderWithProviders(<OnboardingCustomization onComplete={() => {}} />);

    await waitFor(() => expect(screen.getByText('Create your Agent')).toBeInTheDocument());

    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next voice' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Rose' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Seraph' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Wyatt' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Custom' })).toBeInTheDocument();
    expect(screen.queryByText(/profile picture/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/personality/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/approval messages/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Choose your assistant name/i)).not.toBeInTheDocument();
  });

  it('saves the next preset (Seraph) when Next voice is clicked once', async () => {
    let completed = 0;
    const user = userEvent.setup();
    renderWithProviders(
      <OnboardingCustomization
        onComplete={() => {
          completed += 1;
        }}
      />
    );

    await waitFor(() => expect(screen.getByText('Create your Agent')).toBeInTheDocument());
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Atlas');
    await user.click(screen.getByRole('button', { name: 'Next voice' }));
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(completed).toBe(1));

    expect(JSON.parse(localStorage.getItem(VOICE_STORAGE_KEY) ?? '{}')).toMatchObject({
      mode: 'preset',
      voiceId: 'J2FGlQG8Gd7x8uEDt2H8',
      label: 'Seraph',
    });

    const patch = capturedRequests.find(
      (request) => request.method === 'PATCH' && request.url.endsWith('/api/user-settings')
    );
    expect(parseBody(patch?.body ?? null)).toMatchObject({
      systemName: 'Atlas',
      profilePicture: null,
      customSystemPrompt: null,
      voicePreferenceId: 'J2FGlQG8Gd7x8uEDt2H8',
    });
  });

  it('selecting the Custom carousel slot reveals the voice-id input and persists a pasted id', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OnboardingCustomization onComplete={() => {}} />);

    await waitFor(() => expect(screen.getByText('Create your Agent')).toBeInTheDocument());
    await user.click(screen.getByRole('tab', { name: 'Custom' }));
    await user.type(screen.getByPlaceholderText('ElevenLabs voice ID'), 'voice_custom_123');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(VOICE_STORAGE_KEY) ?? '{}')).toMatchObject({
        mode: 'custom',
        voiceId: 'voice_custom_123',
      });
    });

    const patch = capturedRequests.find(
      (request) => request.method === 'PATCH' && request.url.endsWith('/api/user-settings')
    );
    expect(parseBody(patch?.body ?? null)).toMatchObject({
      voicePreferenceId: 'voice_custom_123',
    });
  });

  it('blocks Continue with an error when the Custom slot is selected with an empty id', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OnboardingCustomization onComplete={() => {}} />);

    await waitFor(() => expect(screen.getByText('Create your Agent')).toBeInTheDocument());
    await user.click(screen.getByRole('tab', { name: 'Custom' }));
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByText('Enter an ElevenLabs voice ID')).toBeInTheDocument();
    });
  });
});
