export interface BenchmarkQuestion {
  id: string;
  question: string;
  options?: string[];
  correctAnswer: string;
  metadata?: Record<string, any>;
}

export interface BenchmarkConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  cotSteps?: number;
  samples?: number;
  seed?: number;
  batchSize?: number;
}

export abstract class BaseBenchmarkHarness {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly questionCount: number;
  
  abstract loadDataset(): Promise<BenchmarkQuestion[]>;
  abstract formatPrompt(question: BenchmarkQuestion, step: number, previousResponses: string[]): string;
  abstract extractAnswer(modelResponse: string): string;
  abstract evaluateAnswer(extracted: string, correct: string): Promise<boolean>;
  
  // Sample questions with seed for reproducibility
  sampleQuestions(questions: BenchmarkQuestion[], count: number, seed: number): BenchmarkQuestion[] {
    if (count >= questions.length) return questions;
    
    // Use seeded RNG for reproducible shuffling
    const rng = this.createSeededRNG(seed);
    const shuffled = [...questions];
    
    // Fisher-Yates shuffle with seeded randomness
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    
    return shuffled.slice(0, count);
  }
  
  private createSeededRNG(seed: number): () => number {
    // Mulberry32 PRNG for deterministic randomness
    let state = seed;
    return () => {
      let t = state += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
}







