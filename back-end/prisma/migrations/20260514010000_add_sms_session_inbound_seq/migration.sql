-- Monotonic per-user inbound-SMS counter for the supervisor's deferred-commit
-- gate (WS-2). On every inbound SMS the webhook layer increments this and
-- captures the new value as `mySeq` for the run; at attempt_completion the
-- run re-reads it and discards its pendingWrites buffer if a newer SMS landed.
ALTER TABLE "SmsSession" ADD COLUMN "lastInboundSeq" INTEGER NOT NULL DEFAULT 0;
