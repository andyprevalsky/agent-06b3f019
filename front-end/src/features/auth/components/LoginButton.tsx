/**
 * STATE MACHINE: LoginButton
 *
 * [LOADING] <-- loading: true (from useAuth)
 *     |
 *     v (auth check complete)
 * [READY]
 *     |
 *     +--> user exists --> click navigates to /terminal
 *     +--> no user --> click opens auth modal
 *
 * MODAL STATE:
 * [CLOSED] <-- modalOpen: false
 *     |
 *     v (click when no user)
 * [OPEN] <-- modalOpen: true
 *     |
 *     v (auth complete or close)
 * [CLOSED]
 */

import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';

import PhoneAuthModal from './PhoneAuthModal';

const LoginButton = () => {
  const [modalOpen, setModalOpen] = useState(false);
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleClick = () => {
    // If already authenticated, redirect to terminal
    if (user) {
      navigate('/terminal');
    } else {
      // Otherwise, open the auth modal
      setModalOpen(true);
    }
  };

  if (loading) {
    return null;
  }

  return (
    <>
      <button
        ref={buttonRef}
        className="hidden md:flex items-center justify-center px-4 py-2 rounded-md text-sm font-medium bg-white/5 backdrop-blur-xl text-black hover:bg-white/10 transition-colors border border-white/20"
        onClick={handleClick}
      >
        Login
      </button>

      <PhoneAuthModal open={modalOpen} onOpenChange={setModalOpen} triggerRef={buttonRef} />
    </>
  );
};

export default LoginButton;
