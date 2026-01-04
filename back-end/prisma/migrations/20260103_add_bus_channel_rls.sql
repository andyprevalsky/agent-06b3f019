-- Add RLS policies for bus:* realtime channels
-- These allow users to subscribe to bus channels for agents they own
-- The bus channel is used for real-time sub-agent tree state updates

-- Policy: Users can receive broadcasts on bus channels for their own agents
-- The bus ID is the root agent's ID, extracted from topic "bus:<uuid>"
CREATE POLICY "self_can_receive_bus" ON "realtime"."messages"
FOR SELECT
TO authenticated, anon
USING (
  realtime.topic() LIKE 'bus:%'
  AND EXISTS (
    SELECT 1 FROM public."Agent"
    WHERE "Agent"."id" = SUBSTRING(realtime.topic() FROM 5)
    AND "Agent"."userId" = auth.uid()::text
  )
);

-- Policy: Users can send to bus channels for their own agents (for completeness)
CREATE POLICY "self_can_send_bus" ON "realtime"."messages"
FOR INSERT
TO authenticated, anon
WITH CHECK (
  realtime.topic() LIKE 'bus:%'
  AND EXISTS (
    SELECT 1 FROM public."Agent"
    WHERE "Agent"."id" = SUBSTRING(realtime.topic() FROM 5)
    AND "Agent"."userId" = auth.uid()::text
  )
);
