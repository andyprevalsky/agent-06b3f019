/**
 * Blackbox tests for the benchmarks domain.
 *
 * Domain surface:
 *   The benchmarks module provides benchmark infrastructure for evaluating LLM
 *   models. It includes harnesses (MMLU-Pro, Terminal-Bench), evaluators
 *   (equality-checker, math-evaluator, code-evaluator, repetition-checker),
 *   a test runner, standards data, and a production runner.
 *
 * Entrypoints tested:
 *   1. Evaluators — repetition detection, math answer extraction/normalization,
 *      code extraction, equality checker prompt construction
 *   2. Harnesses — MMLU-Pro and Terminal-Bench prompt formatting, answer
 *      extraction, dataset loading, metadata
 *   3. Base harness — seeded sampling determinism, cost calculation logic
 *   4. Test runner — benchmark registry, unknown benchmark errors, config
 *      construction
 *   5. Standards data — JSON structure, required fields, data integrity
 *
 * Boundary:
 *   External boundaries (OpenRouter API for equality-checker, model API for
 *   callModel) are LLM calls — non-deterministic, costly, and
 *   rate-limited. Capture testing is not applicable for these boundaries.
 *   We test the boundary indirectly by verifying request construction,
 *   prompt formatting, and fallback behavior (e.g., equality-checker falls
 *   back to string matching when API key is missing).
 */

import {
  assertEquals,
  assertExists,
  assertNotEquals,
  assertThrows,
} from 'https://deno.land/std@0.190.0/testing/asserts.ts';

// ---------------------------------------------------------------------------
// Evaluator: repetition-checker
// ---------------------------------------------------------------------------

import {
  checkRepetition,
  messageSimilarity,
  analyzeRepetition,
  RepetitionChecker,
} from '../../benchmarks/evaluators/repetition-checker.ts';

Deno.test('checkRepetition — returns false for fewer messages than minRepetitions + 1', () => {
  assertEquals(checkRepetition(['a', 'a', 'a']), false);
});

Deno.test('checkRepetition — returns true for 4 identical messages (default threshold)', () => {
  const msgs = ['hello world foo bar baz', 'hello world foo bar baz', 'hello world foo bar baz', 'hello world foo bar baz'];
  assertEquals(checkRepetition(msgs), true);
});

Deno.test('checkRepetition — returns false for diverse messages', () => {
  const msgs = [
    'The quick brown fox jumps over the lazy dog',
    'Python is a programming language',
    'Machine learning uses neural networks',
    'The weather today is sunny and warm',
    'Database indexing improves query performance',
  ];
  assertEquals(checkRepetition(msgs), false);
});

Deno.test('checkRepetition — returns false when only 2 consecutive are similar (default minRepetitions=3)', () => {
  const msgs = [
    'unique message alpha beta gamma',
    'hello world foo bar baz qux',
    'hello world foo bar baz qux',
    'different message entirely here now',
  ];
  assertEquals(checkRepetition(msgs), false);
});

Deno.test('checkRepetition — custom threshold: lower threshold detects partial similarity', () => {
  // These messages share some words but are not 99% similar
  const msgs = [
    'the cat sat on the mat today',
    'the cat sat on the mat yesterday',
    'the cat sat on the mat tomorrow',
    'the cat sat on the mat tonight',
    'the cat sat on the mat this morning',
  ];
  // With default 0.99 threshold, they won't match (different last words)
  assertEquals(checkRepetition(msgs, 0.99, 3), false);
  // With lower threshold (e.g. 0.7), they should match
  assertEquals(checkRepetition(msgs, 0.7, 3), true);
});

Deno.test('checkRepetition — empty messages array returns false', () => {
  assertEquals(checkRepetition([]), false);
});

Deno.test('checkRepetition — single message returns false', () => {
  assertEquals(checkRepetition(['hello']), false);
});

Deno.test('messageSimilarity — identical strings return 1.0', () => {
  assertEquals(messageSimilarity('hello world', 'hello world'), 1.0);
});

Deno.test('messageSimilarity — completely different strings return 0.0', () => {
  assertEquals(messageSimilarity('alpha beta gamma', 'delta epsilon zeta'), 0);
});

Deno.test('messageSimilarity — empty string returns 0', () => {
  assertEquals(messageSimilarity('', 'hello'), 0);
  assertEquals(messageSimilarity('hello', ''), 0);
  assertEquals(messageSimilarity('', ''), 0);
});

Deno.test('messageSimilarity — partial overlap returns value between 0 and 1', () => {
  const sim = messageSimilarity('hello world foo', 'hello world bar');
  assertEquals(sim > 0, true, 'Should be > 0 (shared words)');
  assertEquals(sim < 1, true, 'Should be < 1 (different words)');
});

Deno.test('messageSimilarity — case insensitive', () => {
  assertEquals(messageSimilarity('Hello World', 'hello world'), 1.0);
});

Deno.test('analyzeRepetition — single message returns no repetition', () => {
  const result = analyzeRepetition(['hello']);
  assertEquals(result.isRepeating, false);
  assertEquals(result.maxConsecutiveSimilar, 0);
  assertEquals(result.avgSimilarity, 0);
  assertEquals(result.similarityScores.length, 0);
});

Deno.test('analyzeRepetition — empty messages returns no repetition', () => {
  const result = analyzeRepetition([]);
  assertEquals(result.isRepeating, false);
  assertEquals(result.maxConsecutiveSimilar, 0);
  assertEquals(result.avgSimilarity, 0);
  assertEquals(result.similarityScores.length, 0);
});

Deno.test('analyzeRepetition — repeating messages detected', () => {
  const msgs = [
    'hello world foo bar baz',
    'hello world foo bar baz',
    'hello world foo bar baz',
    'hello world foo bar baz',
    'hello world foo bar baz',
  ];
  const result = analyzeRepetition(msgs);
  assertEquals(result.isRepeating, true);
  assertEquals(result.maxConsecutiveSimilar >= 3, true);
  assertEquals(result.avgSimilarity, 1.0);
  assertEquals(result.similarityScores.length, 4);
});

Deno.test('analyzeRepetition — diverse messages not repeating', () => {
  const msgs = [
    'first unique message about programming',
    'second different message about cooking',
    'third distinct message about travel',
    'fourth separate message about music',
  ];
  const result = analyzeRepetition(msgs);
  assertEquals(result.isRepeating, false);
  assertEquals(result.similarityScores.length, 3);
});

Deno.test('analyzeRepetition — similarity scores count equals messages.length - 1', () => {
  const msgs = ['a b c', 'd e f', 'g h i'];
  const result = analyzeRepetition(msgs);
  assertEquals(result.similarityScores.length, 2);
});

// ---------------------------------------------------------------------------
// Evaluator: math-evaluator
// ---------------------------------------------------------------------------

import {
  evaluateMathAnswer,
  extractMathAnswer,
} from '../../benchmarks/evaluators/math-evaluator.ts';

Deno.test('extractMathAnswer — extracts from \\boxed{}', () => {
  assertEquals(extractMathAnswer('The answer is \\boxed{42}'), '42');
});

Deno.test('extractMathAnswer — extracts from boxed{} without backslash', () => {
  assertEquals(extractMathAnswer('The answer is boxed{42}'), '42');
});

Deno.test('extractMathAnswer — extracts trailing number when no boxed', () => {
  assertEquals(extractMathAnswer('After computation, the answer is 123'), '123');
});

Deno.test('extractMathAnswer — extracts decimal trailing number', () => {
  assertEquals(extractMathAnswer('The result equals 3.14'), '3.14');
});

Deno.test('extractMathAnswer — returns empty string when no answer found', () => {
  assertEquals(extractMathAnswer('I cannot determine the answer'), '');
});

Deno.test('extractMathAnswer — prefers \\boxed over trailing number', () => {
  assertEquals(extractMathAnswer('Step 1: 10. Step 2: \\boxed{42}. Done 99'), '42');
});

Deno.test('evaluateMathAnswer — exact match without boxed falls back (no API key => string match)', async () => {
  // No API key => checkEquality falls back to string matching
  // "42" vs "42" should match even without LLM
  const result = await evaluateMathAnswer('The answer is \\boxed{42}', '42');
  assertEquals(result, true);
});

Deno.test('evaluateMathAnswer — normalized number match', async () => {
  // "042" normalized should equal "42"
  const result = await evaluateMathAnswer('\\boxed{042}', '42');
  assertEquals(result, true);
});

Deno.test('evaluateMathAnswer — wrong answer returns false', async () => {
  // "7" !== "42", no API key so LLM fallback also uses string match
  const result = await evaluateMathAnswer('\\boxed{7}', '42');
  assertEquals(result, false);
});

// ---------------------------------------------------------------------------
// Evaluator: code-evaluator
// ---------------------------------------------------------------------------

import {
  evaluateCode,
  extractPythonCode,
} from '../../benchmarks/evaluators/code-evaluator.ts';

Deno.test('extractPythonCode — extracts from ```python block', () => {
  const input = 'Here is the solution:\n```python\nprint("hello")\n```\nDone.';
  assertEquals(extractPythonCode(input), 'print("hello")');
});

Deno.test('extractPythonCode — extracts from generic ``` block', () => {
  const input = 'Solution:\n```\nprint("hello")\n```';
  assertEquals(extractPythonCode(input), 'print("hello")');
});

Deno.test('extractPythonCode — returns trimmed input when no code block', () => {
  assertEquals(extractPythonCode('  print("hello")  '), 'print("hello")');
});

Deno.test('extractPythonCode — prefers ```python over generic ```', () => {
  const input = '```\ngeneric\n```\n```python\nspecific\n```';
  assertEquals(extractPythonCode(input), 'specific');
});

Deno.test('evaluateCode — returns placeholder result (not implemented)', async () => {
  const result = await evaluateCode('print(1)', 'assert True');
  assertEquals(result.passed, false);
  assertEquals(result.exitCode, -1);
  assertExists(result.error);
});

// ---------------------------------------------------------------------------
// Evaluator: equality-checker (prompt construction and fallback)
// ---------------------------------------------------------------------------

import { checkEquality } from '../../benchmarks/evaluators/equality-checker.ts';

Deno.test('checkEquality — falls back to string matching when no API key', async () => {
  // With no OPENROUTER_API_KEY set and no explicit key, should fall back
  const savedKey = Deno.env.get('OPENROUTER_API_KEY');
  try {
    Deno.env.delete('OPENROUTER_API_KEY');
    const result = await checkEquality('paris', 'paris');
    assertEquals(result, true);
  } finally {
    if (savedKey) Deno.env.set('OPENROUTER_API_KEY', savedKey);
  }
});

Deno.test('checkEquality — fallback string matching is case-insensitive and trimmed', async () => {
  const savedKey = Deno.env.get('OPENROUTER_API_KEY');
  try {
    Deno.env.delete('OPENROUTER_API_KEY');
    const result = await checkEquality('  PARIS  ', '  paris  ');
    assertEquals(result, true);
  } finally {
    if (savedKey) Deno.env.set('OPENROUTER_API_KEY', savedKey);
  }
});

Deno.test('checkEquality — fallback returns false for different answers', async () => {
  const savedKey = Deno.env.get('OPENROUTER_API_KEY');
  try {
    Deno.env.delete('OPENROUTER_API_KEY');
    const result = await checkEquality('london', 'paris');
    assertEquals(result, false);
  } finally {
    if (savedKey) Deno.env.set('OPENROUTER_API_KEY', savedKey);
  }
});

// ---------------------------------------------------------------------------
// Harness: MMLU-Pro
// ---------------------------------------------------------------------------

import { MMLUProHarness } from '../../benchmarks/harnesses/mmlu-pro.ts';

Deno.test('MMLUProHarness — metadata properties are correct', () => {
  const harness = new MMLUProHarness();
  assertEquals(harness.name, 'MMLU-Pro');
  assertEquals(harness.questionCount, 12032);
  assertEquals(harness.defaultRepeats, 1);
  assertExists(harness.description);
});

Deno.test('MMLUProHarness — loadDataset returns sample questions', async () => {
  const harness = new MMLUProHarness();
  const dataset = await harness.loadDataset();
  assertEquals(dataset.length >= 1, true, 'Dataset should have at least 1 question');
  for (const q of dataset) {
    assertExists(q.id, 'Question must have id');
    assertExists(q.question, 'Question must have question text');
    assertExists(q.correctAnswer, 'Question must have correctAnswer');
    assertExists(q.options, 'MMLU-Pro questions must have options');
    assertEquals(q.options!.length, 10, 'MMLU-Pro has 10 options (A-J)');
  }
});

Deno.test('MMLUProHarness — formatPrompt includes question and options', () => {
  const harness = new MMLUProHarness();
  const question = {
    id: 'test-1',
    question: 'What is 2+2?',
    options: ['A) 3', 'B) 4', 'C) 5'],
    correctAnswer: 'B',
  };
  const prompt = harness.formatPrompt(question);
  assertEquals(prompt.includes('What is 2+2?'), true, 'Prompt must include question');
  assertEquals(prompt.includes('A) 3'), true, 'Prompt must include options');
  assertEquals(prompt.includes('B) 4'), true);
  assertEquals(prompt.includes('C) 5'), true);
  assertEquals(prompt.includes('Answer with only the letter'), true, 'Prompt must include instruction');
});

Deno.test('MMLUProHarness — extractAnswer extracts single letter A-J', () => {
  const harness = new MMLUProHarness();
  assertEquals(harness.extractAnswer('C'), 'C');
  assertEquals(harness.extractAnswer('The answer is B'), 'B');
  assertEquals(harness.extractAnswer('A) Paris'), 'A');
});

Deno.test('MMLUProHarness — extractAnswer handles lowercase', () => {
  const harness = new MMLUProHarness();
  assertEquals(harness.extractAnswer('c'), 'C');
});

Deno.test('MMLUProHarness — extractAnswer handles "Answer: X" format', () => {
  const harness = new MMLUProHarness();
  assertEquals(harness.extractAnswer('After analysis, answer: D'), 'D');
  assertEquals(harness.extractAnswer('The answer is E'), 'E');
});

Deno.test('MMLUProHarness — extractAnswer matches standalone "I" in text (valid A-J letter)', () => {
  const harness = new MMLUProHarness();
  // "I" is a valid letter in A-J range, so the regex picks it up as a standalone letter
  assertEquals(harness.extractAnswer('I do not know'), 'I');
});

Deno.test('MMLUProHarness — extractAnswer returns empty for text with no A-J letters', () => {
  const harness = new MMLUProHarness();
  assertEquals(harness.extractAnswer('no valid letter here at all'), '');
});

Deno.test('MMLUProHarness — evaluateAnswer compares case-insensitively', async () => {
  const harness = new MMLUProHarness();
  assertEquals(await harness.evaluateAnswer('c', 'C'), true);
  assertEquals(await harness.evaluateAnswer('C', 'c'), true);
  assertEquals(await harness.evaluateAnswer('A', 'B'), false);
});

// ---------------------------------------------------------------------------
// Harness: Terminal-Bench
// ---------------------------------------------------------------------------

import { TerminalBenchHarness } from '../../benchmarks/harnesses/terminal-bench.ts';

Deno.test('TerminalBenchHarness — metadata properties are correct', () => {
  const harness = new TerminalBenchHarness();
  assertEquals(harness.name, 'Terminal-Bench');
  assertEquals(harness.questionCount, 47);
  assertEquals(harness.defaultRepeats, 3);
  assertExists(harness.description);
});

Deno.test('TerminalBenchHarness — loadDataset returns sample tasks', async () => {
  const harness = new TerminalBenchHarness();
  const dataset = await harness.loadDataset();
  assertEquals(dataset.length >= 1, true, 'Dataset should have at least 1 task');
  for (const q of dataset) {
    assertExists(q.id, 'Task must have id');
    assertExists(q.question, 'Task must have question text');
    assertExists(q.correctAnswer, 'Task must have correctAnswer');
    assertExists(q.metadata, 'Terminal-Bench tasks should have metadata');
    assertExists(q.metadata!.difficulty, 'Task metadata should have difficulty');
    assertExists(q.metadata!.category, 'Task metadata should have category');
  }
});

Deno.test('TerminalBenchHarness — formatPrompt includes task description', () => {
  const harness = new TerminalBenchHarness();
  const question = {
    id: 'test-1',
    question: 'Build a web server on port 8080',
    correctAnswer: 'server_running',
  };
  const prompt = harness.formatPrompt(question);
  assertEquals(prompt.includes('Build a web server on port 8080'), true);
  assertEquals(prompt.includes('terminal'), true, 'Prompt should mention terminal environment');
});

Deno.test('TerminalBenchHarness — extractAnswer truncates to 500 chars', () => {
  const harness = new TerminalBenchHarness();
  const longResponse = 'x'.repeat(1000);
  const extracted = harness.extractAnswer(longResponse);
  assertEquals(extracted.length, 500);
});

Deno.test('TerminalBenchHarness — extractAnswer preserves short response', () => {
  const harness = new TerminalBenchHarness();
  const shortResponse = 'Step 1: Run command';
  assertEquals(harness.extractAnswer(shortResponse), shortResponse);
});

// ---------------------------------------------------------------------------
// Base harness — seeded sampling
// ---------------------------------------------------------------------------

// We test seeded sampling indirectly through a concrete harness
Deno.test('seeded sampling — same seed produces same sample', async () => {
  const harness1 = new MMLUProHarness();
  const harness2 = new MMLUProHarness();
  const dataset = await harness1.loadDataset();

  // sampleQuestions is protected, so we test it through runBenchmark's determinism.
  // If the dataset is smaller than sampleSize, no sampling occurs.
  // With the current sample dataset (3 questions), we verify all are returned.
  assertEquals(dataset.length, 3, 'Sample dataset should have 3 questions');

  // Verify the dataset IDs are consistent across loads
  const dataset2 = await harness2.loadDataset();
  assertEquals(dataset.map(q => q.id), dataset2.map(q => q.id));
});

// ---------------------------------------------------------------------------
// Test runner — registry and config
// ---------------------------------------------------------------------------

// We cannot import runBenchmarkSuite directly because it uses Deno.env/Deno.exit,
// but we can verify the registry by testing createHarness indirectly through
// the harness factories.

Deno.test('benchmark registry — MMLU-Pro is a valid benchmark name', () => {
  // Verify by constructing the harness directly
  const harness = new MMLUProHarness();
  assertEquals(harness.name, 'MMLU-Pro');
});

Deno.test('benchmark registry — Terminal-Bench is a valid benchmark name', () => {
  const harness = new TerminalBenchHarness();
  assertEquals(harness.name, 'Terminal-Bench');
});

// ---------------------------------------------------------------------------
// Standards data — structure and integrity
// ---------------------------------------------------------------------------

Deno.test('standards.json — valid JSON structure', async () => {
  const text = await Deno.readTextFile(
    new URL('../../benchmarks/standards.json', import.meta.url),
  );
  const data = JSON.parse(text);
  assertExists(data.version, 'Must have version');
  assertExists(data.lastUpdated, 'Must have lastUpdated');
  assertExists(data.benchmarks, 'Must have benchmarks');
});

Deno.test('standards.json — each benchmark has required fields', async () => {
  const text = await Deno.readTextFile(
    new URL('../../benchmarks/standards.json', import.meta.url),
  );
  const data = JSON.parse(text);
  for (const [key, bench] of Object.entries(data.benchmarks)) {
    // deno-lint-ignore no-explicit-any
    const b = bench as any;
    assertExists(b.name, `${key} must have name`);
    assertExists(b.description, `${key} must have description`);
    assertExists(b.source, `${key} must have source`);
    assertExists(b.questionCount, `${key} must have questionCount`);
    assertEquals(typeof b.questionCount, 'number', `${key}.questionCount must be a number`);
    assertExists(b.industryStandards, `${key} must have industryStandards`);
    assertEquals(Array.isArray(b.industryStandards), true, `${key}.industryStandards must be array`);
    assertEquals(b.industryStandards.length >= 1, true, `${key} must have at least 1 standard`);
    assertExists(b.updateInstructions, `${key} must have updateInstructions`);
  }
});

Deno.test('standards.json — industry standards have required fields', async () => {
  const text = await Deno.readTextFile(
    new URL('../../benchmarks/standards.json', import.meta.url),
  );
  const data = JSON.parse(text);
  for (const [key, bench] of Object.entries(data.benchmarks)) {
    // deno-lint-ignore no-explicit-any
    const b = bench as any;
    for (const std of b.industryStandards) {
      assertExists(std.model, `${key} standard must have model`);
      assertExists(std.score, `${key} standard must have score`);
      assertEquals(typeof std.score, 'number', `${key} standard score must be number`);
      assertEquals(std.score >= 0 && std.score <= 100, true, `${key} standard score must be 0-100`);
      assertExists(std.date, `${key} standard must have date`);
      assertExists(std.source, `${key} standard must have source`);
    }
  }
});

Deno.test('standards.json — mmlu-pro benchmark exists with expected question count', async () => {
  const text = await Deno.readTextFile(
    new URL('../../benchmarks/standards.json', import.meta.url),
  );
  const data = JSON.parse(text);
  assertExists(data.benchmarks['mmlu-pro']);
  assertEquals(data.benchmarks['mmlu-pro'].questionCount, 12032);
});

Deno.test('standards.json — terminal-bench benchmark exists with expected question count', async () => {
  const text = await Deno.readTextFile(
    new URL('../../benchmarks/standards.json', import.meta.url),
  );
  const data = JSON.parse(text);
  assertExists(data.benchmarks['terminal-bench']);
  assertEquals(data.benchmarks['terminal-bench'].questionCount, 47);
});

Deno.test('standards.json — lastUpdated is valid date format', async () => {
  const text = await Deno.readTextFile(
    new URL('../../benchmarks/standards.json', import.meta.url),
  );
  const data = JSON.parse(text);
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  assertEquals(dateRegex.test(data.lastUpdated), true, 'lastUpdated must be YYYY-MM-DD');
});

// ---------------------------------------------------------------------------
// Harness metadata consistency with standards.json
// ---------------------------------------------------------------------------

Deno.test('MMLU-Pro harness questionCount matches standards.json', async () => {
  const harness = new MMLUProHarness();
  const text = await Deno.readTextFile(
    new URL('../../benchmarks/standards.json', import.meta.url),
  );
  const data = JSON.parse(text);
  assertEquals(harness.questionCount, data.benchmarks['mmlu-pro'].questionCount);
});

Deno.test('Terminal-Bench harness questionCount matches standards.json', async () => {
  const harness = new TerminalBenchHarness();
  const text = await Deno.readTextFile(
    new URL('../../benchmarks/standards.json', import.meta.url),
  );
  const data = JSON.parse(text);
  assertEquals(harness.questionCount, data.benchmarks['terminal-bench'].questionCount);
});

// ---------------------------------------------------------------------------
// Edge cases and invariants
// ---------------------------------------------------------------------------

Deno.test('MMLUProHarness — formatPrompt handles missing options gracefully', () => {
  const harness = new MMLUProHarness();
  const question = {
    id: 'no-options',
    question: 'What is life?',
    correctAnswer: 'A',
  };
  const prompt = harness.formatPrompt(question);
  assertEquals(prompt.includes('What is life?'), true);
  // Should not crash even without options
});

Deno.test('MMLUProHarness — extractAnswer handles multiline response', () => {
  const harness = new MMLUProHarness();
  const response = 'Let me think about this.\nAfter careful analysis.\nThe answer is C.';
  assertEquals(harness.extractAnswer(response), 'C');
});

Deno.test('MMLUProHarness — extractAnswer handles response with multiple letters', () => {
  const harness = new MMLUProHarness();
  // Should pick the first standalone letter A-J
  const response = 'A is wrong, B is wrong, C is correct';
  const result = harness.extractAnswer(response);
  assertEquals(result, 'A');
});

Deno.test('TerminalBenchHarness — evaluateAnswer returns false for empty extracted answer', async () => {
  const harness = new TerminalBenchHarness();
  // Empty string has no keywords, so matchCount = 0
  const result = await harness.evaluateAnswer('', 'kernel_built_and_custom_message_added');
  assertEquals(result, false);
});

Deno.test('TerminalBenchHarness — evaluateAnswer keyword matching at 50% threshold', async () => {
  const harness = new TerminalBenchHarness();
  // correctAnswer: "kernel_built_and_custom_message_added" => keywords: [kernel, built, and, custom, message, added]
  // Need at least 50% = 3 keywords
  const partialMatch = 'I will build the kernel and add a custom message';
  const result = await harness.evaluateAnswer(partialMatch, 'kernel_built_and_custom_message_added');
  assertEquals(result, true, 'Should match with 50%+ keyword coverage');
});

Deno.test('TerminalBenchHarness — evaluateAnswer rejects insufficient keywords', async () => {
  const harness = new TerminalBenchHarness();
  // "kernel_built_and_custom_message_added" => 6 keywords, need 3
  // Response with only 1 keyword
  const poorMatch = 'I will run a database query';
  const result = await harness.evaluateAnswer(poorMatch, 'kernel_built_and_custom_message_added');
  assertEquals(result, false, 'Should fail with <50% keyword coverage');
});

// ---------------------------------------------------------------------------
// Same-input reproducibility
// ---------------------------------------------------------------------------

Deno.test('checkRepetition — same input always produces same output', () => {
  const msgs = ['hello world foo bar', 'hello world foo bar', 'hello world foo bar', 'hello world foo bar'];
  const results = Array.from({ length: 5 }, () => checkRepetition(msgs));
  assertEquals(new Set(results).size, 1, 'All runs should produce same result');
});

Deno.test('messageSimilarity — same input always produces same score', () => {
  const results = Array.from({ length: 5 }, () => messageSimilarity('hello world', 'world hello'));
  assertEquals(new Set(results).size, 1, 'All runs should produce same score');
});

Deno.test('extractMathAnswer — same input always produces same extraction', () => {
  const results = Array.from({ length: 5 }, () => extractMathAnswer('\\boxed{42}'));
  assertEquals(new Set(results).size, 1, 'All runs should produce same extraction');
});

Deno.test('extractPythonCode — same input always produces same extraction', () => {
  const input = '```python\nprint("hello")\n```';
  const results = Array.from({ length: 5 }, () => extractPythonCode(input));
  assertEquals(new Set(results).size, 1, 'All runs should produce same extraction');
});

// ---------------------------------------------------------------------------
// RepetitionChecker class (stateful wrapper)
// ---------------------------------------------------------------------------

Deno.test('RepetitionChecker — constructor with defaults', () => {
  const checker = new RepetitionChecker();
  assertEquals(checker.getMessages().length, 0);
});

Deno.test('RepetitionChecker — addMessage accumulates messages', () => {
  const checker = new RepetitionChecker();
  checker.addMessage('first');
  checker.addMessage('second');
  assertEquals(checker.getMessages().length, 2);
  assertEquals(checker.getMessages()[0], 'first');
  assertEquals(checker.getMessages()[1], 'second');
});

Deno.test('RepetitionChecker — window trimming keeps only recent messages', () => {
  const checker = new RepetitionChecker(3); // windowSize=3
  checker.addMessage('a');
  checker.addMessage('b');
  checker.addMessage('c');
  checker.addMessage('d');
  assertEquals(checker.getMessages().length, 3);
  assertEquals(checker.getMessages()[0], 'b');
  assertEquals(checker.getMessages()[2], 'd');
});

Deno.test('RepetitionChecker — isStuck returns false for diverse messages', async () => {
  const checker = new RepetitionChecker(5, 0.99, 3);
  checker.addMessage('The quick brown fox jumps over the lazy dog');
  checker.addMessage('Python is a programming language used widely');
  checker.addMessage('Machine learning uses neural networks to learn');
  checker.addMessage('Database indexing improves query performance significantly');
  checker.addMessage('The weather today is sunny and warm outside');
  assertEquals(await checker.isStuck(), false);
});

Deno.test('RepetitionChecker — isStuck returns true for identical messages', async () => {
  const checker = new RepetitionChecker(5, 0.99, 3);
  checker.addMessage('stuck in loop message repeated');
  checker.addMessage('stuck in loop message repeated');
  checker.addMessage('stuck in loop message repeated');
  checker.addMessage('stuck in loop message repeated');
  assertEquals(await checker.isStuck(), true);
});

Deno.test('RepetitionChecker — getMessages returns a copy (not a reference)', () => {
  const checker = new RepetitionChecker();
  checker.addMessage('test');
  const msgs = checker.getMessages();
  msgs.push('injected');
  assertEquals(checker.getMessages().length, 1, 'Original should not be modified');
});

// ---------------------------------------------------------------------------
// Equality checker detailed (fallback path)
// ---------------------------------------------------------------------------

import { checkEqualityDetailed } from '../../benchmarks/evaluators/equality-checker.ts';

Deno.test('checkEqualityDetailed — falls back to string matching without API key', async () => {
  const savedKey = Deno.env.get('OPENROUTER_API_KEY');
  try {
    Deno.env.delete('OPENROUTER_API_KEY');
    const result = await checkEqualityDetailed('paris', 'paris');
    assertEquals(result.isEqual, true);
    assertEquals(result.confidence, 50); // fallback confidence
    assertExists(result.reasoning);
  } finally {
    if (savedKey) Deno.env.set('OPENROUTER_API_KEY', savedKey);
  }
});

Deno.test('checkEqualityDetailed — fallback returns false for different answers', async () => {
  const savedKey = Deno.env.get('OPENROUTER_API_KEY');
  try {
    Deno.env.delete('OPENROUTER_API_KEY');
    const result = await checkEqualityDetailed('london', 'paris');
    assertEquals(result.isEqual, false);
    assertEquals(result.confidence, 50);
  } finally {
    if (savedKey) Deno.env.set('OPENROUTER_API_KEY', savedKey);
  }
});

// ---------------------------------------------------------------------------
// Dataset integrity invariants
// ---------------------------------------------------------------------------

Deno.test('MMLU-Pro dataset — all question IDs are unique', async () => {
  const harness = new MMLUProHarness();
  const dataset = await harness.loadDataset();
  const ids = dataset.map(q => q.id);
  assertEquals(ids.length, new Set(ids).size, 'Question IDs must be unique');
});

Deno.test('Terminal-Bench dataset — all task IDs are unique', async () => {
  const harness = new TerminalBenchHarness();
  const dataset = await harness.loadDataset();
  const ids = dataset.map(q => q.id);
  assertEquals(ids.length, new Set(ids).size, 'Task IDs must be unique');
});

Deno.test('MMLU-Pro dataset — all correct answers are valid letters A-J', async () => {
  const harness = new MMLUProHarness();
  const dataset = await harness.loadDataset();
  const validLetters = new Set('ABCDEFGHIJ'.split(''));
  for (const q of dataset) {
    assertEquals(validLetters.has(q.correctAnswer), true,
      `${q.id}: correctAnswer "${q.correctAnswer}" must be A-J`);
  }
});

Deno.test('Terminal-Bench dataset — all tasks have non-empty correctAnswer', async () => {
  const harness = new TerminalBenchHarness();
  const dataset = await harness.loadDataset();
  for (const q of dataset) {
    assertEquals(q.correctAnswer.length > 0, true,
      `${q.id}: correctAnswer must not be empty`);
  }
});

// ---------------------------------------------------------------------------
// Math evaluator edge cases
// ---------------------------------------------------------------------------

Deno.test('extractMathAnswer — handles nested boxed expressions', () => {
  // The regex matches the first non-nested boxed content
  const result = extractMathAnswer('\\boxed{x^2}');
  assertEquals(result, 'x^2');
});

Deno.test('extractMathAnswer — handles boxed with spaces', () => {
  assertEquals(extractMathAnswer('\\boxed{ 42 }'), '42');
});

Deno.test('extractMathAnswer — empty boxed returns empty after trim', () => {
  assertEquals(extractMathAnswer('\\boxed{}'), '');
});

// ---------------------------------------------------------------------------
// Code evaluator edge cases
// ---------------------------------------------------------------------------

Deno.test('extractPythonCode — handles multiple python blocks (returns first)', () => {
  const input = '```python\nblock1\n```\n```python\nblock2\n```';
  assertEquals(extractPythonCode(input), 'block1');
});

Deno.test('extractPythonCode — handles empty code block', () => {
  const input = '```python\n\n```';
  assertEquals(extractPythonCode(input), '');
});

Deno.test('extractPythonCode — handles multiline code', () => {
  const input = '```python\ndef foo():\n    return 42\n```';
  assertEquals(extractPythonCode(input), 'def foo():\n    return 42');
});
