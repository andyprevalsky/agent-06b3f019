-- Composite index serving the recent-inbound OTP relay query:
-- channel equality filter + timestamp range (the ~10-minute `since` window).
CREATE INDEX IF NOT EXISTS "MessageRecord_channel_timestamp_idx"
  ON "MessageRecord"("channel", "timestamp");
