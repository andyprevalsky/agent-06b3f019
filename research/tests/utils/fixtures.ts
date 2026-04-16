/**
 * Test Fixtures and Helper Functions
 * Tests use same credentials as production (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
 */

export const sampleMessages = [
  { role: "user" as const, content: "What is 2+2?" },
];

export const sampleToolDefinition = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Get current weather for a location",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name" },
      },
      required: ["location"],
    },
  },
};

// Get API key from environment (generate via /rose/generate-api-key)
const ROSE_API_KEY = Deno.env.get("ROSE_API_KEY") || "";

export const sampleBenchmarkConfig = {
  url: "/completions",
  headers: {
    "x-api-key": ROSE_API_KEY,
  },
  modelConfig: {
    model: "rose-labs/rose-1-lite",
    temperature: 0.7,
    maxTokens: 100,
    seed: 42,
    cotSteps: 1,
  },
  benchmark: "mmlu-pro",
  seed: 12345,
};

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function assertStatusCode(
  actual: number,
  expected: number,
  ...additionalValid: number[]
) {
  const validCodes = [expected, ...additionalValid];
  if (!validCodes.includes(actual)) {
    throw new Error(
      `Expected status ${validCodes.join(" or ")}, got ${actual}`,
    );
  }
}

export function assertHasProperty(
  obj: any,
  property: string,
  message?: string,
) {
  if (!(property in obj)) {
    throw new Error(
      message || `Expected object to have property '${property}'`,
    );
  }
}

export function assertIsArray(value: any, message?: string) {
  if (!Array.isArray(value)) {
    throw new Error(
      message || `Expected value to be an array, got ${typeof value}`,
    );
  }
}
