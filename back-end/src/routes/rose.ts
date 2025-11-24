import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { ROSE_MODEL_POOLS, normalizeRoseAlias } from '../lib/roseModels';
// import { MMLUProHarness } from '../benchmarks/harnesses/mmlu-pro';
// import { TerminalBenchHarness, TerminalBenchTask } from '../benchmarks/harnesses/terminal-bench';
import { prisma } from '../lib/prisma';

const router = Router();

// Randomly select a model from the pool
function selectModel(requestedModel: string): string {
  const normalized = normalizeRoseAlias(requestedModel) ?? requestedModel.toLowerCase();
  const pool = ROSE_MODEL_POOLS[normalized as keyof typeof ROSE_MODEL_POOLS];
  
  if (!pool) {
    throw new Error(`Unknown model: ${requestedModel}. Use 'rose-labs/rose-1-fast' or 'rose-labs/rose-1-ultra'`);
  }
  
  const selectedModel = pool[Math.floor(Math.random() * pool.length)];
  console.log(`🎲 Model selection: ${requestedModel} → ${selectedModel}`);
  return selectedModel;
}

/**
 * POST /v1/chat/completions
 * OpenRouter-compatible chat completions endpoint
 */
router.post('/chat/completions', async (req: AuthRequest, res: Response) => {
  try {
    const { model, messages, temperature, max_tokens, ...otherParams } = req.body;

    // Validate request
    if (!model) {
      return res.status(400).json({ error: 'Missing required field: model' });
    }
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid required field: messages' });
    }

    // Select actual model from pool
    let actualModel: string;
    try {
      actualModel = selectModel(model);
    } catch (error) {
      return res.status(400).json({ 
        error: error instanceof Error ? error.message : 'Invalid model' 
      });
    }

    // Prepare request to OpenRouter with throughput optimization
    const openrouterBody = {
      model: actualModel,
      messages,
      temperature,
      max_tokens,
      ...otherParams,
      provider: {
        sort: 'throughput'  // Optimize for lowest e2e latency
      }
    };

    // Call OpenRouter API
    const openrouterResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.BACKEND_URL || 'https://navi-j9a9.onrender.com',
        'X-Title': 'Rose AI Agent'
      },
      body: JSON.stringify(openrouterBody)
    });

    if (!openrouterResponse.ok) {
      const errorText = await openrouterResponse.text();
      console.error('OpenRouter API error:', openrouterResponse.status, errorText);
      return res.status(openrouterResponse.status).json({ 
        error: 'OpenRouter API error',
        details: errorText 
      });
    }

    const data = await openrouterResponse.json() as any;

    // Mask the actual model in the response - return the requested model name
    if (data.model) {
      data.model = model;  // Replace actual model with the requested Rose variant
    }

    // Return the response (with masked model)
    res.json(data);
  } catch (error) {
    console.error('Rose endpoint error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ 
      error: 'Internal server error',
      details: errorMessage 
    });
  }
});

/**
 * GET /v1/cost/:modelName
 * Calculate average cost for Rose model pools
 * Returns average of pool models rounded up to nearest $0.05
 * Also returns minimum context length from all models in pool
 */
router.get('/cost/:modelName', async (req: AuthRequest, res: Response) => {
  try {
    // Normalize: 'rose-labs/rose' → 'rose', 'rose-labs/rose-ultra' → 'rose-ultra'
    let modelName = req.params.modelName.toLowerCase();
    if (modelName.startsWith('rose-labs/')) {
      modelName = modelName.replace('rose-labs/', '');
    }
    const pool = ROSE_MODEL_POOLS[modelName as keyof typeof ROSE_MODEL_POOLS];

    if (!pool) {
      return res.status(404).json({ 
        error: `Model not found: ${modelName}` 
      });
    }

    // Fetch all OpenRouter models
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': process.env.BACKEND_URL || 'https://navi-j9a9.onrender.com',
        'X-Title': 'Rose AI Agent'
      }
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API returned ${response.status}`);
    }

    const data = await response.json() as any;
    const allModels = data.data || [];

    // Calculate average pricing and minimum context length
    let totalPrompt = 0;
    let totalCompletion = 0;
    let validModels = 0;
    let minContextLength = Infinity;

    for (const modelId of pool) {
      const modelInfo = allModels.find((m: any) => m.id === modelId);
      
      if (modelInfo) {
        // Track minimum context length for all models
        const contextLength = modelInfo.top_provider?.context_length || modelInfo.context_length;
        if (contextLength && contextLength < minContextLength) {
          minContextLength = contextLength;
        }

        // Track pricing only for models that have it
        if (modelInfo.pricing) {
          // OpenRouter returns price per token, accumulate as-is
          const promptCost = parseFloat(modelInfo.pricing.prompt || '0');
          const completionCost = parseFloat(modelInfo.pricing.completion || '0');
          
          totalPrompt += promptCost;
          totalCompletion += completionCost;
          validModels++;
        }
      }
    }

    if (validModels === 0) {
      return res.status(500).json({ 
        error: 'No pricing information available for models in pool' 
      });
    }

    // Calculate averages (per token)
    const avgPrompt = totalPrompt / validModels;
    const avgCompletion = totalCompletion / validModels;

    // Convert to per-million tokens for rounding, then back to per-token
    const roundUpToNearestFiveCents = (perTokenPrice: number) => {
      const perMillionPrice = perTokenPrice * 1000000;
      const roundedPerMillion = Math.ceil(perMillionPrice / 0.05) * 0.05;
      return roundedPerMillion / 1000000;
    };

    const roundedPrompt = roundUpToNearestFiveCents(avgPrompt);
    const roundedCompletion = roundUpToNearestFiveCents(avgCompletion);

    res.json({
      model: modelName,
      poolSize: pool.length,
      contextLength: minContextLength === Infinity ? 200000 : minContextLength,
      pricing: {
        prompt: roundedPrompt.toString(),
        completion: roundedCompletion.toString()
      }
    });
  } catch (error) {
    console.error('Cost calculation error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ 
      error: 'Failed to calculate cost',
      details: errorMessage 
    });
  }
});

/**
 * POST /bench
 * Temporarily disabled while the heavy harnesses are excluded from builds.
 */
router.post('/bench', (_req: AuthRequest, res: Response) => {
  return res.status(503).json({
    error: 'Benchmarking temporarily disabled',
    detail: 'Bench harnesses were removed from the build to keep TypeScript memory usage low.'
  });
});

/*
import * as fs from 'fs';
import * as path from 'path';
import { MMLUProHarness } from '../benchmarks/harnesses/mmlu-pro';
import { TerminalBenchHarness, TerminalBenchTask } from '../benchmarks/harnesses/terminal-bench';

const HARNESSES = {
  'mmlu-pro': () => new MMLUProHarness(),
  'terminal-bench': () => new TerminalBenchHarness(),
};

interface BenchmarkRequest {
  benchmark: string;
  model: string;
  cotSteps?: number;
  samples?: number;
  seed?: number;
  batchSize?: number;
  temperature?: number;
  maxTokens?: number;
}

interface QuestionResult {
  questionId: string;
  cotResponses: string[];
  extractedAnswer: string;
  correctAnswer: string;
  isCorrect: boolean;
  durationMs: number;
  costCents: number;
}

router.post('/bench', async (req: AuthRequest, res: Response) => {
  const {
    benchmark,
    model,
    cotSteps = 1,
    samples = 100,
    seed = 42,
    batchSize = 10,
    temperature = 0.7,
    maxTokens = 2000
  }: BenchmarkRequest = req.body;
  res.json({
    message: 'Benchmarking is not supported yet'
  });
  // Validate
  const createHarness = HARNESSES[benchmark as keyof typeof HARNESSES];
  if (!createHarness) {
    return res.status(400).json({
      error: `Unknown benchmark: ${benchmark}`,
      available: Object.keys(HARNESSES)
    });
  }
  
  const startTime = Date.now();
  const harness = createHarness();
  
  try {
    // Load and sample dataset
    console.log(`Loading ${harness.name} dataset...`);
    const allQuestions = await harness.loadDataset();
    const maxSamples = parseInt(process.env.MAX_SAMPLES_PER_BENCH || '100');
    const sampleCount = Math.min(samples, maxSamples);
    const questions = harness.sampleQuestions(allQuestions, sampleCount, seed);
    
    console.log(`Running ${questions.length} questions with CoT=${cotSteps}, batch size=${batchSize}`);
    
    const results: QuestionResult[] = [];
    
    // Branch: Terminal-Bench uses Harbor containerized execution
    if (benchmark === 'terminal-bench') {
      console.log('🚢 Using Harbor containerized execution for Terminal-Bench');
      
      const terminalHarness = harness as TerminalBenchHarness;
      
      // For Terminal-Bench, run Harbor with specific sampled task IDs
      console.log(`Running Harbor for ${questions.length} Terminal-Bench tasks...`);
      
      // Extract Harbor task names from sampled questions
      const harborTaskNames = questions.map((q: TerminalBenchTask) => q.harborTaskName).filter((name): name is string => Boolean(name));
      console.log(`  Harbor task names: ${harborTaskNames.join(', ')}`);
      
      try {
        const harborResult = await terminalHarness.runBatch(harborTaskNames, model, {
          agent: 'claude-code',
          environment: 'daytona',
          seed
        });
        
        // Convert Harbor results to our format
        for (const task of harborResult.tasks) {
          results.push({
            questionId: task.id,
            cotResponses: [task.output || ''],
            extractedAnswer: task.success ? 'pass' : 'fail',
            correctAnswer: 'pass',
            isCorrect: task.success,
            durationMs: task.durationMs || 0,
            costCents: 0 // Harbor doesn't provide cost breakdown yet
          });
        }
      } catch (error) {
        console.error(`Harbor batch execution failed:`, error);
        // Return failed results for all tasks on error
        for (let i = 0; i < questions.length; i++) {
          const task = questions[i] as TerminalBenchTask;
          results.push({
            questionId: task.id,
            cotResponses: [],
            extractedAnswer: 'fail',
            correctAnswer: 'pass',
            isCorrect: false,
            durationMs: 0,
            costCents: 0
          });
        }
      }
    } else {
      // MMLU-Pro and other text-based benchmarks use LLM CoT loop
      console.log('📝 Using text-based LLM evaluation');
      
      // Process in batches
      for (let i = 0; i < questions.length; i += batchSize) {
        const batch = questions.slice(i, i + batchSize);
        
        const batchResults = await Promise.all(
          batch.map(async (question) => {
            const questionStart = Date.now();
            const cotResponses: string[] = [];
            let totalCost = 0;
          
            try {
              // CoT loop (sequential within question)
              for (let step = 1; step <= cotSteps; step++) {
                const prompt = harness.formatPrompt(question, step, cotResponses);
                
                // Call edge function /completions
                const response = await fetch(
                  `${process.env.SUPABASE_URL}/functions/v1/completions`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
                      'x-api-key': process.env.ROSE_API_KEY!,
                    },
                    body: JSON.stringify({
                      model,
                      messages: [{ role: 'user', content: prompt }],
                      temperature,
                      max_tokens: maxTokens,
                      seed: seed + step // Different seed per step
                    })
                  }
                );
                
                if (!response.ok) {
                  throw new Error(`Completions API error: ${response.status}`);
                }
                
                const data: any = await response.json();
                const content = data.choices[0].message.content;
                cotResponses.push(content);
                
                // Track cost (from usage data)
                if (data.usage) {
                  const stepCost = calculateCost(
                    data.usage.prompt_tokens,
                    data.usage.completion_tokens
                  );
                  totalCost += stepCost;
                }
              }
              
              // Extract and evaluate final answer
              const finalResponse = cotResponses[cotResponses.length - 1];
              const extractedAnswer = harness.extractAnswer(finalResponse);
              const isCorrect = await harness.evaluateAnswer(
                extractedAnswer,
                question.correctAnswer
              );
              
              return {
                questionId: question.id,
                cotResponses,
                extractedAnswer,
                correctAnswer: question.correctAnswer,
                isCorrect,
                durationMs: Date.now() - questionStart,
                costCents: totalCost
              };
            } catch (error) {
              console.error(`Error on question ${question.id}:`, error);
              return {
                questionId: question.id,
                cotResponses,
                extractedAnswer: '',
                correctAnswer: question.correctAnswer,
                isCorrect: false,
                durationMs: Date.now() - questionStart,
                costCents: totalCost
              };
            }
          })
        );
        
        results.push(...batchResults);
        console.log(`Progress: ${results.length}/${questions.length} questions`);
      }
    }
    
    // Calculate aggregate metrics
    const correctCount = results.filter(r => r.isCorrect).length;
    const accuracy = (correctCount / results.length) * 100;
    const totalCost = results.reduce((sum, r) => sum + r.costCents, 0);
    const durationSeconds = (Date.now() - startTime) / 1000;
    const avgDurationMs = results.reduce((sum, r) => sum + r.durationMs, 0) / results.length;
    
    // Log to database
    const benchmarkRun = await prisma.benchmarkRun.create({
      data: {
        userId: req.user?.id || 'system',
        benchmarkName: harness.name,
        modelConfig: { model, cotSteps, temperature, maxTokens, seed },
        results: results as any,
        aggregateScore: accuracy,
        totalCostCents: totalCost,
        sampledQuestions: results.length,
        durationSeconds: Math.round(durationSeconds)
      }
    });
    
    console.log(`✓ Benchmark complete: ${accuracy.toFixed(1)}% accuracy`);
    
    // Return results with industry comparison
    const standards = loadIndustryStandards();
    const comparison = compareWithStandards(harness.name, accuracy, standards);
    
    return res.json({
      id: benchmarkRun.id,
      benchmarkName: harness.name,
      model,
      cotSteps,
      accuracy,
      correctAnswers: correctCount,
      totalQuestions: allQuestions.length,
      sampledQuestions: results.length,
      totalCostCents: totalCost,
      durationSeconds: Math.round(durationSeconds),
      avgDurationMs: Math.round(avgDurationMs),
      industryComparison: comparison,
      results: results.map(r => ({
        questionId: r.questionId,
        isCorrect: r.isCorrect,
        extractedAnswer: r.extractedAnswer,
        durationMs: r.durationMs,
        costCents: r.costCents
      }))
    });
    
  } catch (error) {
    console.error('Benchmark error:', error);
    return res.status(500).json({ error: 'Benchmark execution failed' });
  }
});

function calculateCost(promptTokens: number, completionTokens: number): number {
  const promptCost = (promptTokens / 1000000) * 50; // $0.50/M
  const completionCost = (completionTokens / 1000000) * 150; // $1.50/M
  return Math.ceil((promptCost + completionCost) * 100); // cents
}

function loadIndustryStandards() {
  const standardsPath = path.join(__dirname, '../../benchmarks/standards.json');
  return JSON.parse(fs.readFileSync(standardsPath, 'utf-8'));
}

function compareWithStandards(benchmarkName: string, score: number, standards: any) {
  const benchKey = benchmarkName.toLowerCase().replace(/[^a-z]/g, '-');
  const benchStandards = standards.benchmarks[benchKey]?.industryStandards || [];
  
  if (benchStandards.length === 0) {
    return { position: 'no-data', average: null, leader: null };
  }
  
  const avg = benchStandards reduce((sum: number, s: any) => sum + s.score, 0) / benchStandards.length;
  const leader = benchStandards[0];
  
  let position = 'below-average';
  if (score >= leader.score) position = 'above-leader';
  else if (score >= avg) position = 'above-average';
  
  return {
    position,
    average: avg,
    leader: { model: leader.model, score: leader.score },
    yourScore: score
  };
}
*/

export default router;

