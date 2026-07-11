import { useEffect, useState } from 'react';
import { getErrorMessageOrFallback } from '../../../shared/utils/error';
import {
  cancelTelegramAuth,
  isTelegramApiAvailable,
  onTelegramAuthComplete,
  onTelegramAuthError,
  onTelegramNeedCode,
  onTelegramNeedPassword,
  startTelegramAuth,
  submitTelegramCode,
  submitTelegramPassword,
} from './api';
import {
  AUTHENTICATE_GENERIC_FAILURE,
  CODE_EMPTY_MESSAGE,
  PASSWORD_EMPTY_MESSAGE,
  PHONE_EMPTY_MESSAGE,
  SEND_CODE_GENERIC_FAILURE,
  START_AUTH_GENERIC_FAILURE,
  SUBMIT_LABEL_CODE,
  SUBMIT_LABEL_PASSWORD,
  SUBMIT_LABEL_PHONE,
  TELEGRAM_API_UNAVAILABLE_MESSAGE,
  VERIFY_CODE_GENERIC_FAILURE,
} from './config';
import type { AuthStep, UseTelegramAuthModalResult } from './types';

const SUBMIT_LABELS: Record<AuthStep, string> = {
  phone: SUBMIT_LABEL_PHONE,
  code: SUBMIT_LABEL_CODE,
  password: SUBMIT_LABEL_PASSWORD,
};

interface SubmitState {
  setLoading: (v: boolean) => void;
  setError: (v: string | null) => void;
}

/**
 * Config table driving the generic submit handler. Each step has:
 *   - the inline error when input is empty
 *   - the logger tag written before firing the IPC call
 *   - the IPC call itself (accepts the step's payload, returns a result)
 *   - the fallback error if the IPC throws OR if it returns success=false
 *     without an error string
 */
interface StepSubmitSpec {
  emptyMessage: string;
  logMessage: string;
  call: (input: string) => Promise<{ success: boolean; error?: string }>;
  successFalseFallback: string;
  thrownFallback: string;
}

const STEP_SPECS: Record<AuthStep, StepSubmitSpec> = {
  phone: {
    emptyMessage: PHONE_EMPTY_MESSAGE,
    logMessage: '[TelegramAuthModal] Starting auth for:',
    // Phone state is already canonical E.164 (set by PhoneInput).
    call: (phoneNumber) => startTelegramAuth(phoneNumber),
    successFalseFallback: START_AUTH_GENERIC_FAILURE,
    thrownFallback: SEND_CODE_GENERIC_FAILURE,
  },
  code: {
    emptyMessage: CODE_EMPTY_MESSAGE,
    logMessage: '[TelegramAuthModal] Submitting code',
    call: submitTelegramCode,
    successFalseFallback: VERIFY_CODE_GENERIC_FAILURE,
    thrownFallback: VERIFY_CODE_GENERIC_FAILURE,
  },
  password: {
    emptyMessage: PASSWORD_EMPTY_MESSAGE,
    logMessage: '[TelegramAuthModal] Submitting password',
    call: submitTelegramPassword,
    successFalseFallback: AUTHENTICATE_GENERIC_FAILURE,
    thrownFallback: AUTHENTICATE_GENERIC_FAILURE,
  },
};

/**
 * Generic step submit: validate non-empty, assert IPC bridge, fire the
 * step-specific IPC call, surface `success=false`/throw into the error state.
 * On success, `loading` stays true — the main process is expected to drive
 * the next transition via an onTelegram* event.
 *
 * The phone step logs the stripped E.164 form; code/password log just a tag
 * so secrets never hit the renderer log.
 */
const runStepSubmit = async (step: AuthStep, input: string, state: SubmitState): Promise<void> => {
  const spec = STEP_SPECS[step];
  if (!input.trim()) {
    state.setError(spec.emptyMessage);
    return;
  }
  if (!isTelegramApiAvailable()) {
    state.setError(TELEGRAM_API_UNAVAILABLE_MESSAGE);
    return;
  }
  state.setLoading(true);
  state.setError(null);
  try {
    if (step === 'phone') console.log(spec.logMessage, input);
    else console.log(spec.logMessage);
    const result = await spec.call(input);
    if (!result.success) {
      state.setError(result.error ?? spec.successFalseFallback);
      state.setLoading(false);
    }
  } catch (err) {
    state.setError(getErrorMessageOrFallback(err, spec.thrownFallback));
    state.setLoading(false);
  }
};

interface AuthEventHandlers {
  setStep: (s: AuthStep) => void;
  setLoading: (v: boolean) => void;
  setError: (v: string | null) => void;
  reset: () => void;
  onSuccess: () => void;
  onClose: () => void;
}

const subscribeToAuthEvents = (h: AuthEventHandlers): void => {
  onTelegramNeedCode(() => {
    console.log('[TelegramAuthModal] Received needCode event');
    h.setStep('code');
    h.setLoading(false);
  });
  onTelegramNeedPassword(() => {
    console.log('[TelegramAuthModal] Received needPassword event');
    h.setStep('password');
    h.setLoading(false);
  });
  onTelegramAuthComplete(() => {
    console.log('[TelegramAuthModal] Received authComplete event');
    h.setLoading(false);
    h.onSuccess();
    h.reset();
    h.onClose();
  });
  onTelegramAuthError((errorMessage: string) => {
    console.log('[TelegramAuthModal] Received authError event:', errorMessage);
    h.setError(errorMessage);
    h.setLoading(false);
  });
};

/**
 * All TelegramAuthModal state lives here. The component is a pure renderer
 * over this hook's result. Business rules encoded:
 *
 *   - The modal only subscribes to IPC events while `isOpen` is true; closed
 *     mounts do zero work.
 *   - Each submit step rejects empty input inline and never fires the IPC
 *     call. Errors clear on the next successful step.
 *   - While any submit is in-flight, `loading` is true — every close path
 *     (Cancel, backdrop) is a no-op and submit buttons are disabled so rapid
 *     double-clicks cannot re-fire the same IPC call.
 *   - Loading clears ONLY when the main process signals via event
 *     (needCode/needPassword/authComplete/authError) or the IPC call throws.
 *   - Going "back" from the code step calls `cancelAuth`, resets the code
 *     input, and returns to the phone step — phone value is preserved so the
 *     user can retry without re-typing.
 *   - Closing the modal (Cancel or backdrop) calls `cancelAuth`, resets ALL
 *     state, then invokes `onClose`.
 */
export const useTelegramAuthModal = (
  isOpen: boolean,
  onClose: () => void,
  onSuccess: () => void
): UseTelegramAuthModalResult => {
  const [step, setStep] = useState<AuthStep>('phone');
  const [phoneNumber, setPhoneNumberState] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = (): void => {
    setStep('phone');
    setPhoneNumberState('');
    setCode('');
    setPassword('');
    setError(null);
    setLoading(false);
  };

  useEffect(() => {
    if (!isOpen) return;
    subscribeToAuthEvents({ setStep, setLoading, setError, reset, onSuccess, onClose });
  }, [isOpen, onClose, onSuccess]);

  // PhoneInput emits canonical E.164 (+<dialcode><digits>); store as-is.
  const setPhoneNumber = (raw: string): void => {
    setPhoneNumberState(raw);
  };

  const handleClose = (): void => {
    if (loading) return;
    cancelTelegramAuth();
    reset();
    onClose();
  };

  const handleBackToPhone = (): void => {
    cancelTelegramAuth();
    setStep('phone');
    setCode('');
    setError(null);
  };

  const handleSubmit = (): void => {
    const inputs: Record<AuthStep, string> = { phone: phoneNumber, code, password };
    void runStepSubmit(step, inputs[step], { setLoading, setError });
  };

  return {
    step,
    phoneNumber,
    code,
    password,
    loading,
    error,
    setPhoneNumber,
    setCode,
    setPassword,
    handleSubmit,
    handleClose,
    handleBackToPhone,
    getSubmitLabel: () => SUBMIT_LABELS[step],
  };
};
