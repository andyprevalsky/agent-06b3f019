/**
 * Canonical allow-list of benchmark task tags.
 *
 * Extracted from benchmarks.blackbox.ts so the validation test that asserts
 * every tag in agents/benchmarks/tasks.json is known stays under the file
 * line-count limit. Keep this in sync with the tags used across the catalog —
 * when a new task category slice is added to tasks.json, add its tag here.
 */
export const KNOWN_TAGS = [
  'basic',
  'chat',
  'smoke',
  'approval',
  'browser',
  'proxy-rotation',
  'claude-code',
  'attachment',
  'for-each',
  'outreach',
  'job-applications',
  'cache',
  'DEMO',
  'DAILY',
  'fleet-concurrency',
  'load-test',
  'mass-agent',
  'research',
  'people-search',
  'lantern',
  'baseline',
  'single-arm',
  'scale',
  'batch',
  'fleet-concurrency',
  'needs-auth',
  'auth',
  'browser-auth',
  'auth-anon',
  'auth-cookie',
  'biometrics',
  'local-only',
  'minted',
  'social',
  'grep',
  'github',
  'payment',
  'new-user',
  'phone',
  'ivr',
  'plaid',
  'transactions',
  'bot-challenge',
  'antibot',
  'documents',
  'prod-data',
  'external',
  'voice',
  'wait-for',
  'eval',
  'real-llm',
  'gate',
  'subscription',
  'webhook',
  'admin-bypass',
  'kyc',
  'source',
  'response-schema',
  'regression',
  // Planner-memory A/B tasks terminate after validating the emitted plan.
  'planner',
  'memory',
  'plan-only',
  // Long-horizon capability slice — months-long goals run under world-model
  // simulate with time skipping (see raise-5m-rose-labs-brex in tasks.json).
  'long-horizon',
  // Ecommerce / real-world task category slices (see tasks.json).
  'ecommerce',
  'purchase',
  'passkey',
  'grocery',
  'doordash',
  'food-plan',
  'cart-reauth',
  'needs_auth',
  'lodging',
  'reservation',
  'appointment',
  'ticketing',
  'transportation',
  'rapid-delivery',
  'returns',
  // AgentCard lifecycle + settlement slices (see tasks.json).
  'compensation',
  'agentcard-lifecycle-sandbox',
  'agentcard-lifecycle-production',
  'setup',
  'idempotency',
  'settlement',
  // Browser proxy/IP rotation slice (browser-rotate-ip-escalation in tasks.json).
  'rotate-ip',
  'proxy',
  'proxy-rotation',
  // SMS supervisor trajectory slice — runner="sms" / SMS-surface tasks that
  // drive the real inbound-SMS path (see agents/benchmarks/sms_runner.py and
  // sms-supervisor-bluebottle-no-hallucinate).
  'sms',
  // WhatsApp recall slice — tasks that read the frozen WhatsApp history baked
  // into the canonical base fixture (see whatsapp-history-recall in tasks.json).
  'whatsapp',
  // Google Calendar and Drive searched through the calendar/drive grep sources
  // (google-calendar-day-recall, google-drive-lease-recall in tasks.json).
  'google',
  'calendar',
  'drive',
  'messages',
  // Polar-bench (Odysseys + BU Bench V1) — opt-in suite; tags mirror upstream
  // sources in agents/benchmarks/polar/*.json via polar_catalog.py.
  'polar-bench',
  'odysseys',
  'easy',
  'medium',
  'hard',
  'bu-bench',
  'interactiontests',
  'webbenchread',
  'om2w2',
  'gaia',
  'browsecomp',
  // Code-capability fixtures with hidden tests (agents/benchmarks/code_bench.py, plan C8).
  'code-bench',
];
