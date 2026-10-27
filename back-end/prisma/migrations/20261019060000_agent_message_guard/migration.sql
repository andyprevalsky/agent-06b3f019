-- Agent-to-agent message guard: per-sender send bucket + per-recipient read marks.
ALTER TABLE "Agent" ADD COLUMN "agentMessaging" JSONB;
