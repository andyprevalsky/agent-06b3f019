/**
 * Supabase edge function entry for GET /cost.
 *
 * Thin wiring layer — all logic lives in research/domains/cost/.
 */

import { serve } from 'https://deno.land/std@0.190.0/http/server.ts';
import { handleCostRequest } from '../../../domains/cost/runtime.ts';
import { withRequestSpan } from '../../../utils/tracing.ts';

serve(withRequestSpan('research.cost', handleCostRequest));
