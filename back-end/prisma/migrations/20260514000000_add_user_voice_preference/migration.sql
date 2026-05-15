-- Persisted ElevenLabs voice ID chosen by the user during onboarding;
-- consumed at outbound Vapi call time to set assistant.voice.voiceId.
ALTER TABLE "User" ADD COLUMN "voicePreferenceId" TEXT;
