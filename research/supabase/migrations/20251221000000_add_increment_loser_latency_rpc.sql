-- RPC function to atomically increment a loser's cached latency
-- This reduces their sandbagging delay, giving them better chance to win next race
CREATE OR REPLACE FUNCTION increment_loser_latency(
  p_model TEXT,
  p_pool TEXT,
  p_increment INT DEFAULT 10
)
RETURNS VOID AS $$
BEGIN
  UPDATE "RoseModelLatency"
  SET 
    "latencyMs" = "latencyMs" + p_increment,
    "measuredAt" = NOW()
  WHERE model = p_model AND pool = p_pool;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permission to authenticated and service role
GRANT EXECUTE ON FUNCTION increment_loser_latency(TEXT, TEXT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION increment_loser_latency(TEXT, TEXT, INT) TO service_role;

