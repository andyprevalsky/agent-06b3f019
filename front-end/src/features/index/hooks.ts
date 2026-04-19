import { useState, useEffect, useCallback, useRef } from 'react';
import { isEarlyAccessEnabled } from '@/lib/utils';

import { submitWaitlist } from './api';
import {
  HERO_BASE_TEXT,
  HERO_ROTATING_WORDS,
  HERO_TYPE_BASE_SPEED,
  HERO_TYPE_WORD_SPEED,
  HERO_DELETE_SPEED,
  HERO_PAUSE_AFTER_WORD,
  HERO_PAUSE_BETWEEN_WORDS,
  PRE_ORDER_CHECKOUT_URLS,
} from './config';
import type { WaitlistFormState } from './types';

// ---------------------------------------------------------------------------
// Progressive image loader
// ---------------------------------------------------------------------------

type FetchPriority = 'high' | 'low' | 'auto';

interface ImageWithPriority extends HTMLImageElement {
  fetchpriority?: 'high' | 'low';
}

function preloadImage(src: string, priority?: 'high' | 'low'): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image() as ImageWithPriority;
    if (priority) {
      img.fetchpriority = priority;
    }
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = src;
  });
}

interface ProgressiveImageOptions {
  lowSrc: string;
  medSrc: string;
  highSrc: string;
  fetchPriority: FetchPriority;
}

/** Loads low/medium/high versions of an image, returning the best available src. */
export function useProgressiveImageSrc({
  lowSrc,
  medSrc,
  highSrc,
  fetchPriority,
}: ProgressiveImageOptions): string {
  const [currentSrc, setCurrentSrc] = useState(lowSrc);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    // Tier: 1=low, 2=med, 3=high. Only upgrade, never downgrade if med resolves after high.
    let currentTier = 0;
    const upgradeTo = (tier: number, src: string) => {
      if (cancelledRef.current || tier <= currentTier) return;
      currentTier = tier;
      setCurrentSrc(src);
    };

    const lowPriority = fetchPriority === 'high' ? 'high' : undefined;

    const run = async () => {
      try {
        await preloadImage(lowSrc, lowPriority);
        upgradeTo(1, lowSrc);
      } catch (error) {
        console.warn('Failed to load low resolution image:', error);
        return;
      }

      // Load medium and high in parallel; high overwrites medium if it arrives later.
      const medP = preloadImage(medSrc, 'low')
        .then(() => upgradeTo(2, medSrc))
        .catch((error: unknown) => {
          console.warn('Failed to load medium resolution image:', error);
        });
      const highP = preloadImage(highSrc, 'low')
        .then(() => upgradeTo(3, highSrc))
        .catch((error: unknown) => {
          console.warn('Failed to load high resolution image:', error);
        });
      await Promise.all([medP, highP]);
    };

    void run();

    return () => {
      cancelledRef.current = true;
    };
  }, [lowSrc, medSrc, highSrc, fetchPriority]);

  return currentSrc;
}

// ---------------------------------------------------------------------------
// Early access
// ---------------------------------------------------------------------------

/** Returns whether the early access features are enabled. */
export function useEarlyAccess(): boolean {
  return isEarlyAccessEnabled();
}

// ---------------------------------------------------------------------------
// Hero typewriter effect
// ---------------------------------------------------------------------------

/** Drives the typewriter animation for the hero section. */
export function useTypewriter(): string {
  const [typedText, setTypedText] = useState('');

  useEffect(() => {
    let currentWordIndex = 0;
    let currentCharIndex = 0;
    let isDeleting = false;
    let isFirstType = true;
    let timeoutId: ReturnType<typeof setTimeout>;

    const typeText = () => {
      const currentWord = HERO_ROTATING_WORDS[currentWordIndex];

      if (!isDeleting) {
        if (currentCharIndex === 0 && isFirstType) {
          let baseIndex = 0;
          const typeBase = () => {
            if (baseIndex <= HERO_BASE_TEXT.length) {
              setTypedText(HERO_BASE_TEXT.slice(0, baseIndex));
              baseIndex++;
              setTimeout(typeBase, HERO_TYPE_BASE_SPEED);
            } else {
              isFirstType = false;
              typeText();
            }
          };
          typeBase();
          return;
        }

        if (currentCharIndex < currentWord.length) {
          setTypedText(HERO_BASE_TEXT + currentWord.slice(0, currentCharIndex + 1));
          currentCharIndex++;
          timeoutId = setTimeout(typeText, HERO_TYPE_WORD_SPEED);
        } else {
          timeoutId = setTimeout(() => {
            isDeleting = true;
            typeText();
          }, HERO_PAUSE_AFTER_WORD);
        }
      } else {
        if (currentCharIndex > 0) {
          setTypedText(HERO_BASE_TEXT + currentWord.slice(0, currentCharIndex - 1));
          currentCharIndex--;
          timeoutId = setTimeout(typeText, HERO_DELETE_SPEED);
        } else {
          isDeleting = false;
          currentWordIndex = (currentWordIndex + 1) % HERO_ROTATING_WORDS.length;
          timeoutId = setTimeout(typeText, HERO_PAUSE_BETWEEN_WORDS);
        }
      }
    };

    typeText();
    return () => clearTimeout(timeoutId);
  }, []);

  return typedText;
}

// ---------------------------------------------------------------------------
// Media query hooks
// ---------------------------------------------------------------------------

/** Returns true when viewport width is at or below the given breakpoint. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    try {
      mql.addEventListener('change', onChange);
    } catch {
      // Safari <14 fallback
      mql.addListener(onChange as EventListener);
    }
    return () => {
      try {
        mql.removeEventListener('change', onChange);
      } catch {
        mql.removeListener(onChange as EventListener);
      }
    };
  }, [query]);

  return matches;
}

// ---------------------------------------------------------------------------
// Waitlist form
// ---------------------------------------------------------------------------

/** Manages the waitlist form expansion, validation, and submission. */
export function useWaitlistForm(variant?: string, onSuccess?: () => void): WaitlistFormState {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [formData, setFormData] = useState({ name: '', email: '' });
  const [emailError, setEmailError] = useState('');
  const [submitError, setSubmitError] = useState('');

  const expand = useCallback(() => setIsExpanded(true), []);

  const handleInputChange = useCallback(
    (field: 'name' | 'email') => (e: React.ChangeEvent<HTMLInputElement>) => {
      setFormData((prev) => ({ ...prev, [field]: e.target.value }));
      if (field === 'email') setEmailError('');
      setSubmitError('');
    },
    [],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      setEmailError('');
      setSubmitError('');

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(formData.email)) {
        setEmailError('Please enter a valid email address');
        return;
      }

      setIsLoading(true);

      submitWaitlist({
        name: formData.name.trim(),
        email: formData.email.trim().toLowerCase(),
        variant: variant || null,
      })
        .then(() => {
          setIsSuccess(true);
          onSuccess?.();
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : 'Failed to join waitlist. Please try again.';
          console.error('Error joining waitlist:', error);
          setSubmitError(message);
        })
        .finally(() => {
          setIsLoading(false);
        });
    },
    [formData, variant, onSuccess],
  );

  return {
    isExpanded,
    isLoading,
    isSuccess,
    formData,
    emailError,
    submitError,
    expand,
    handleInputChange,
    handleSubmit,
  };
}

// ---------------------------------------------------------------------------
// Pre-order
// ---------------------------------------------------------------------------

/** Opens Stripe checkout for the selected variant. */
export function usePreOrder(): (variant: 'black' | 'white') => void {
  return useCallback((variant: 'black' | 'white') => {
    window.open(PRE_ORDER_CHECKOUT_URLS[variant], '_blank');
  }, []);
}
