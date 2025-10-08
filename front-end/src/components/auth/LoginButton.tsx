import { useState, useRef } from "react";
import PhoneAuthModal from "./PhoneAuthModal";
import { useAuth } from "@/hooks/useAuth";
import { useNavigate } from "react-router-dom";

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
      
      <PhoneAuthModal 
        open={modalOpen} 
        onOpenChange={setModalOpen}
        triggerRef={buttonRef}
      />
    </>
  );
};

export default LoginButton;

