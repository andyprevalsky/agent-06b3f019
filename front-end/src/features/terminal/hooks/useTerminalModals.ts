/**
 * Terminal feature — modal + lightweight UI state hook.
 *
 * Owns the open/closed flags for the four terminal-level modals
 * (create agent, login, credit exhausted, cost limit) so the main
 * composition hook stays focused on orchestration.
 */

import { useState } from 'react';

export function useTerminalModals() {
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  // Optional heading shown atop the phone-auth modal. Undefined => the modal's
  // default "Start Building." copy; set to override (e.g. waitlist CTA).
  const [loginModalTitle, setLoginModalTitle] = useState<string | undefined>(undefined);
  const [showCreditModal, setShowCreditModal] = useState(false);
  const [showCostLimitModal, setShowCostLimitModal] = useState(false);

  return {
    createModalOpen,
    setCreateModalOpen,
    loginModalOpen,
    setLoginModalOpen,
    loginModalTitle,
    setLoginModalTitle,
    showCreditModal,
    setShowCreditModal,
    showCostLimitModal,
    setShowCostLimitModal,
  };
}
