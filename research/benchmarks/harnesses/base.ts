// Core types for benchmark harnesses
export interface BenchmarkQuestion {
  id: string;
  question: string;
  options?: string[];          // For MCQ
  correctAnswer: string;
  metadata?: Record<string, any>;
}

export interface BenchmarkResult {
  questionId: string;
  modelResponse: string;
  extractedAnswer: string;
  isCorrect: boolean;
  costCents: number;
  durationMs: number;
  metadata?: Record<string, any>;
}

export interface BenchmarkConfig {
  modelUrl: string;
  apiKey: string;
  temperature?: number;
  maxTokens?: number;
  repeats?: number;
  cotSteps?: number;
  sampleSize?: number;  // Default: 100
  seed?: number;  // Default: 42
}

export interface BenchmarkSummary {
  benchmarkName: string;
  totalQuestions: number;    // Full dataset size
  sampledQuestions: number;  // Actually evaluated
  correctAnswers: number;
  accuracy: number;          // 0-100
  totalCostCents: number;
  totalDurationSeconds: number;
  results: BenchmarkResult[];
  isSampled: boolean;
}

// Base interface that all harnesses implement
export interface IBenchmarkHarness {
  // Metadata
  readonly name: string;
  readonly description: string;
  readonly questionCount: number;
  readonly defaultRepeats: number;
  
  // Core methods
  loadDataset(): Promise<BenchmarkQuestion[]>;
  formatPrompt(question: BenchmarkQuestion): string;
  extractAnswer(modelResponse: string): string;
  evaluateAnswer(extracted: string, correct: string): Promise<boolean>;
  
  // Main execution
  runBenchmark(config: BenchmarkConfig): Promise<BenchmarkSummary>;
}

// Simple seeded random number generator
function seededRandom(seed: number) {
  let state = seed;
  return function() {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

// Abstract base class for common functionality
export abstract class BaseBenchmarkHarness implements IBenchmarkHarness {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly questionCount: number;
  abstract readonly defaultRepeats: number;
  
  abstract loadDataset(): Promise<BenchmarkQuestion[]>;
  abstract formatPrompt(question: BenchmarkQuestion): string;
  abstract extractAnswer(modelResponse: string): string;
  abstract evaluateAnswer(extracted: string, correct: string): Promise<boolean>;
  
  // Sample questions with seeded randomization
  protected sampleQuestions(
    questions: BenchmarkQuestion[], 
    n: number, 
    seed: number
  ): BenchmarkQuestion[] {
    if (questions.length <= n) {
      return questions;
    }
    
    // Create shuffled copy using seeded random
    const rng = seededRandom(seed);
    const shuffled = [...questions];
    
    // Fisher-Yates shuffle with seeded random
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    
    return shuffled.slice(0, n);
  }
  
  // Helper method for calling model API
  protected async callModel(
    url: string,
    apiKey: string,
    prompt: string,
    temperature?: number,
    maxTokens?: number,
    cotSteps?: number
  ): Promise<{ response: string; cost: number }> {
    const startTime = Date.now();
    
    const requestBody = {
      model: "rose-labs/rose",
      messages: [
        { role: "user", content: prompt }
      ],
      temperature: temperature || 0.7,
      max_tokens: maxTokens || 2000,
      cot_steps: cotSteps || 1
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Model API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const modelResponse = data.choices?.[0]?.message?.content || '';
    
    // Calculate approximate cost
    const promptTokens = data.usage?.prompt_tokens || 0;
    const completionTokens = data.usage?.completion_tokens || 0;
    const costCents = Math.ceil(
      (promptTokens * 0.00005 + completionTokens * 0.00015) * 100
    );

    return {
      response: modelResponse,
      cost: costCents
    };
  }
  
  // Default implementation of runBenchmark
  async runBenchmark(config: BenchmarkConfig): Promise<BenchmarkSummary> {
    const fullDataset = await this.loadDataset();
    
    // Check for MAX_SAMPLES_PER_BENCH environment variable
    const envMaxSamples = typeof Deno !== 'undefined' 
      ? Deno.env.get('MAX_SAMPLES_PER_BENCH')
      : process.env.MAX_SAMPLES_PER_BENCH;
    
    const defaultSampleSize = envMaxSamples ? parseInt(envMaxSamples, 10) : 100;
    const sampleSize = config.sampleSize ?? defaultSampleSize;
    const seed = config.seed ?? 42;
    const repeats = config.repeats ?? this.defaultRepeats;
    
    // Sample if dataset larger than sample size
    const isSampled = fullDataset.length > sampleSize;
    const questions = isSampled 
      ? this.sampleQuestions(fullDataset, sampleSize, seed)
      : fullDataset;
    
    console.log(`Running ${this.name} benchmark:`);
    console.log(`  Total questions in dataset: ${fullDataset.length}`);
    console.log(`  Sampled questions: ${questions.length}`);
    console.log(`  Repeats per question: ${repeats}`);
    console.log(`  CoT steps: ${config.cotSteps || 1}`);
    
    const results: BenchmarkResult[] = [];
    let questionIndex = 0;
    
    for (const question of questions) {
      questionIndex++;
      console.log(`  Processing question ${questionIndex}/${questions.length}...`);
      
      // Run with specified number of repeats
      for (let i = 0; i < repeats; i++) {
        const prompt = this.formatPrompt(question);
        const startTime = Date.now();
        
        try {
          // Call model API
          const { response, cost } = await this.callModel(
            config.modelUrl,
            config.apiKey,
            prompt,
            config.temperature,
            config.maxTokens,
            config.cotSteps
          );
          
          const durationMs = Date.now() - startTime;
          const extractedAnswer = this.extractAnswer(response);
          const isCorrect = await this.evaluateAnswer(extractedAnswer, question.correctAnswer);
          
          results.push({
            questionId: question.id,
            modelResponse: response,
            extractedAnswer,
            isCorrect,
            costCents: cost,
            durationMs,
            metadata: { 
              repeatIndex: i, 
              cotSteps: config.cotSteps || 1 
            }
          });
          
        } catch (error) {
          console.error(`Error processing question ${question.id}:`, error);
          results.push({
            questionId: question.id,
            modelResponse: `ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`,
            extractedAnswer: '',
            isCorrect: false,
            costCents: 0,
            durationMs: Date.now() - startTime,
            metadata: { 
              repeatIndex: i, 
              cotSteps: config.cotSteps || 1,
              error: true
            }
          });
        }
      }
    }
    
    // Calculate aggregate statistics
    const correctAnswers = results.filter(r => r.isCorrect).length;
    const totalCost = results.reduce((sum, r) => sum + r.costCents, 0);
    const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);
    
    const summary: BenchmarkSummary = {
      benchmarkName: this.name,
      totalQuestions: fullDataset.length,
      sampledQuestions: questions.length,
      correctAnswers,
      accuracy: results.length > 0 ? (correctAnswers / results.length) * 100 : 0,
      totalCostCents: totalCost,
      totalDurationSeconds: totalDuration / 1000,
      results,
      isSampled
    };
    
    console.log(`\n${this.name} Results:`);
    console.log(`  Accuracy: ${summary.accuracy.toFixed(2)}%`);
    console.log(`  Cost: $${(summary.totalCostCents / 100).toFixed(2)}`);
    console.log(`  Duration: ${summary.totalDurationSeconds.toFixed(1)}s`);
    
    return summary;
  }
}

