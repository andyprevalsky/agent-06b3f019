import { useState, useCallback } from 'react';

import { sendPasswordRequestApi } from '../api';

export function usePasswordRequest() {
  const [passwordRequestExpanded, setPasswordRequestExpanded] = useState(false);
  const [passwordRequestInput, setPasswordRequestInput] = useState('');
  const [passwordRequestSending, setPasswordRequestSending] = useState(false);
  const [passwordRequestSent, setPasswordRequestSent] = useState(false);

  const handlePasswordRequest = useCallback(async () => {
    if (!passwordRequestInput.trim()) return;
    setPasswordRequestSending(true);
    try {
      await sendPasswordRequestApi(passwordRequestInput.trim());
      setPasswordRequestSent(true);
      setPasswordRequestInput('');
      return true;
    } finally {
      setPasswordRequestSending(false);
    }
  }, [passwordRequestInput]);

  return {
    passwordRequestExpanded,
    setPasswordRequestExpanded,
    passwordRequestInput,
    setPasswordRequestInput,
    passwordRequestSending,
    passwordRequestSent,
    handlePasswordRequest,
  } as const;
}
