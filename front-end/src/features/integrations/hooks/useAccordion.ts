import { useState, useCallback } from 'react';

import type { AccordionSection } from '../types';

export function useAccordion() {
  const [browsersExpanded, setBrowsersExpanded] = useState(false);
  const [passwordsExpanded, setPasswordsExpanded] = useState(false);
  const [messagesSyncExpanded, setMessagesSyncExpanded] = useState(false);
  const [computeExpanded, setComputeExpanded] = useState(false);
  const [socialsExpanded, setSocialsExpanded] = useState(false);

  const toggleSection = useCallback((section: AccordionSection) => {
    setBrowsersExpanded((prev) => (section === 'browsers' ? !prev : false));
    setPasswordsExpanded((prev) => (section === 'passwords' ? !prev : false));
    setMessagesSyncExpanded((prev) => (section === 'messagesSync' ? !prev : false));
    setComputeExpanded((prev) => (section === 'compute' ? !prev : false));
    setSocialsExpanded((prev) => (section === 'socials' ? !prev : false));
  }, []);

  return {
    browsersExpanded,
    passwordsExpanded,
    messagesSyncExpanded,
    computeExpanded,
    socialsExpanded,
    toggleSection,
  } as const;
}
