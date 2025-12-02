/**
 * Comprehensive test script for all implemented benchmarks
 * Runs Rose models against MMLU-Pro and Terminal-Bench
 */

// Load environment variables
import { config } from 'dotenv';
config();

import { MMLUProHarness } from './src/benchmarks/harnesses/mmlu-pro';
import { TerminalBenchHarness } from './src/benchmarks/harnesses/terminal-bench';

interface BenchmarkResult {
  name: string;
  model: string;
  totalQuestions: number;
  sampleSize: number;
  correct: number;
  incorrect: number;
  accuracy: number;
  avgTimeMs: number;
  totalCost?: number;
  details: Array<{
    id: string;
    question: string;
    modelAnswer: string;
    correctAnswer: string;
    passed: boolean;
    timeMs: number;
  }>;
}

async function testMMLUPro(sampleSize: number = 10): Promise<BenchmarkResult> {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('🧪 TESTING: MMLU-Pro (Graduate-level MCQ)');
  console.log('═══════════════════════════════════════════════════════\n');
  
  const harness = new MMLUProHarness();
  const model = 'rose-labs/rose-1-fast';
  
  console.log(`📚 Loading MMLU-Pro dataset...`);
  const allQuestions = await harness.loadDataset();
  console.log(`✓ Loaded ${allQuestions.length} questions\n`);
  
  console.log(`🎲 Sampling ${sampleSize} questions (seed=42)...`);
  const questions = harness.sampleQuestions(allQuestions, sampleSize, 42);
  console.log(`✓ Sampled ${questions.length} questions\n`);
  
  console.log(`🤖 Running evaluation with Rose model: ${model}`);
  console.log(`   Chain-of-Thought steps: 1\n`);
  
  const results = [];
  let correct = 0;
  let totalTime = 0;
  
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    console.log(`\n[${i + 1}/${questions.length}] ${q.id}`);
    console.log(`Question: ${q.question.substring(0, 100)}...`);
    
    const startTime = Date.now();
    
    try {
      // Format prompt
      const prompt = harness.formatPrompt(q, 1, []);
      console.log(`  Prompt length: ${prompt.length} chars`);
      
      // Call Rose API
      const response = await fetch(`${process.env.SUPABASE_URL}/functions/v1/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'x-api-key': process.env.ROSE_API_KEY || ''
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'You are a helpful assistant answering multiple choice questions.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.7,
          max_tokens: 1000
        })
      });
      
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      
      const data: any = await response.json();
      const modelAnswer = data.choices[0].message.content;
      
      // Extract answer
      const extracted = harness.extractAnswer(modelAnswer);
      const isCorrect = await harness.evaluateAnswer(extracted, q.correctAnswer);
      
      const timeMs = Date.now() - startTime;
      totalTime += timeMs;
      
      if (isCorrect) correct++;
      
      console.log(`  Model response: ${modelAnswer.substring(0, 150)}...`);
      console.log(`  Extracted: ${extracted} | Correct: ${q.correctAnswer}`);
      console.log(`  Result: ${isCorrect ? '✅ PASS' : '❌ FAIL'} (${timeMs}ms)`);
      
      results.push({
        id: q.id,
        question: q.question,
        modelAnswer: extracted,
        correctAnswer: q.correctAnswer,
        passed: isCorrect,
        timeMs
      });
      
    } catch (error) {
      console.log(`  ❌ Error: ${error}`);
      results.push({
        id: q.id,
        question: q.question,
        modelAnswer: 'ERROR',
        correctAnswer: q.correctAnswer,
        passed: false,
        timeMs: Date.now() - startTime
      });
    }
  }
  
  const accuracy = (correct / questions.length) * 100;
  const avgTime = totalTime / questions.length;
  
  return {
    name: 'MMLU-Pro',
    model,
    totalQuestions: allQuestions.length,
    sampleSize: questions.length,
    correct,
    incorrect: questions.length - correct,
    accuracy,
    avgTimeMs: avgTime,
    details: results
  };
}

async function testTerminalBench(sampleSize: number = 3): Promise<BenchmarkResult> {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('🧪 TESTING: Terminal-Bench 2.0 (Real-world tasks)');
  console.log('═══════════════════════════════════════════════════════\n');
  
  const harness = new TerminalBenchHarness();
  const model = 'rose-labs/rose-1-fast';
  
  console.log(`📚 Loading Terminal-Bench dataset...`);
  const allTasks = await harness.loadDataset();
  console.log(`✓ Loaded ${allTasks.length} tasks\n`);
  
  console.log(`🎲 Sampling ${sampleSize} tasks (seed=42)...`);
  const tasks = harness.sampleQuestions(allTasks, sampleSize, 42);
  console.log(`✓ Sampled ${tasks.length} tasks:`);
  tasks.forEach((task: any, i) => {
    console.log(`   ${i + 1}. ${task.harborTaskName}`);
  });
  console.log();
  
  console.log(`🤖 Running with Harbor + Rose Agent...`);
  console.log(`   Environment: Daytona`);
  console.log(`   Agent: rose-agent (custom)\n`);
  
  const taskNames = tasks.map((t: any) => t.harborTaskName).filter(Boolean);
  
  const startTime = Date.now();
  const batchResult = await harness.runBatch(taskNames, model, {
    agent: 'rose-agent',
    environment: 'daytona',
    seed: 42
  });
  const totalTime = Date.now() - startTime;
  
  const results = batchResult.tasks.map(task => ({
    id: task.id,
    question: task.instruction,
    modelAnswer: task.success ? 'PASSED' : 'FAILED',
    correctAnswer: 'PASS',
    passed: task.success,
    timeMs: task.durationMs || 0
  }));
  
  const correct = results.filter(r => r.passed).length;
  const accuracy = (correct / results.length) * 100;
  const avgTime = totalTime / results.length;
  
  return {
    name: 'Terminal-Bench 2.0',
    model,
    totalQuestions: allTasks.length,
    sampleSize: results.length,
    correct,
    incorrect: results.length - correct,
    accuracy,
    avgTimeMs: avgTime,
    details: results
  };
}

function printSummary(results: BenchmarkResult[]) {
  console.log('\n\n');
  console.log('═══════════════════════════════════════════════════════');
  console.log('📊 FINAL BENCHMARK RESULTS');
  console.log('═══════════════════════════════════════════════════════\n');
  
  results.forEach(result => {
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Benchmark: ${result.name}`);
    console.log(`Model: ${result.model}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Dataset size: ${result.totalQuestions} total questions`);
    console.log(`Sample size: ${result.sampleSize} questions tested`);
    console.log(`Correct: ${result.correct}`);
    console.log(`Incorrect: ${result.incorrect}`);
    console.log(`Accuracy: ${result.accuracy.toFixed(2)}%`);
    console.log(`Avg time per question: ${result.avgTimeMs.toFixed(0)}ms`);
    if (result.totalCost) {
      console.log(`Total cost: $${result.totalCost.toFixed(4)}`);
    }
    console.log();
    
    // Show pass/fail breakdown
    console.log(`Detailed Results:`);
    result.details.forEach((detail, i) => {
      const icon = detail.passed ? '✅' : '❌';
      console.log(`  ${i + 1}. ${icon} ${detail.id}`);
      if (detail.modelAnswer !== 'ERROR') {
        console.log(`     Answer: ${detail.modelAnswer} (correct: ${detail.correctAnswer})`);
      } else {
        console.log(`     ERROR during execution`);
      }
    });
    console.log();
  });
  
  console.log('═══════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════');
  
  const overallCorrect = results.reduce((sum, r) => sum + r.correct, 0);
  const overallTotal = results.reduce((sum, r) => sum + r.sampleSize, 0);
  const overallAccuracy = (overallCorrect / overallTotal) * 100;
  
  console.log(`Overall Accuracy: ${overallAccuracy.toFixed(2)}% (${overallCorrect}/${overallTotal})`);
  console.log(`Benchmarks tested: ${results.length}`);
  console.log(`Model: ${results[0]?.model || 'N/A'}`);
  console.log('═══════════════════════════════════════════════════════\n');
}

async function main() {
  console.log('🚀 Running comprehensive benchmark suite for Rose models\n');
  console.log(`Model: rose-labs/rose-1-fast`);
  console.log(`Rose API URL: ${process.env.SUPABASE_URL}/functions/v1/completions`);
  console.log(`API Key: ${process.env.ROSE_API_KEY?.substring(0, 10)}...\n`);
  
  const results: BenchmarkResult[] = [];
  
  try {
    // Test 1: MMLU-Pro (10 questions)
    const mmluResult = await testMMLUPro(10);
    results.push(mmluResult);
    
    // Test 2: Terminal-Bench (3 tasks)
    const tbResult = await testTerminalBench(3);
    results.push(tbResult);
    
    // Print final summary
    printSummary(results);
    
  } catch (error) {
    console.error('\n❌ Test suite failed:', error);
    process.exit(1);
  }
}

// Run tests
main().catch(error => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});





