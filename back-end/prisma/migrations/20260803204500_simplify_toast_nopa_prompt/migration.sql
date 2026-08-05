-- The Benchmark Hub database is authoritative after initial seeding. Update
-- the existing Toast row as well as its full runner definition so a Hub export
-- cannot restore the superseded prompt or static receipt evaluator over tasks.json.
UPDATE "BenchmarkTask"
SET
  "prompt" = 'Order me 1 rocky fish sandwich from Nopa Fish Ferry Building',
  "definition" = jsonb_set(
    jsonb_set(
      COALESCE("definition", '{}'::jsonb) #- '{expected_payment_receipt}',
      '{prompt}',
      to_jsonb('Order me 1 rocky fish sandwich from Nopa Fish Ferry Building'::text),
      true
    ),
    '{evaluators}',
    '[{"id":"toast-order-semantics","method":"single_turn_llm_judge","criteria":["The browser and payment-request evidence semantically identify Nopa Fish at the Ferry Building using the official Toast checkout, regardless of exact display-label or URL syntax","The evidence semantically contains exactly one rocky fish sandwich, allowing the live menu item to use a more specific product name such as The Rocky Sandwich","The run stops at one unresolved payment-card request and does not enter card details or place the order"],"judge_prompt":"Judge the entire outcome from visible browser, tool, and payment-request evidence by meaning rather than exact strings. Fail a different business, non-Toast checkout, wrong item or quantity, missing unresolved card request, entered card details, or a completed order."}]'::jsonb,
    true
  ),
  "updatedAt" = CURRENT_TIMESTAMP,
  "updatedBy" = 'catalog-migration'
WHERE "name" = 'browser-toast-nopa-write-lock';
