import { BaseBenchmarkHarness, BenchmarkQuestion } from './base';
import fetch from 'node-fetch';
import * as fs from 'fs/promises';
import * as path from 'path';

export class MMLUProHarness extends BaseBenchmarkHarness {
  readonly name = "MMLU-Pro";
  readonly description = "Graduate-level multiple-choice questions across 14 subjects";
  readonly questionCount = 12032;
  
  async loadDataset(): Promise<BenchmarkQuestion[]> {
    const cacheFile = path.join(__dirname, '../datasets/mmlu-pro-cache.json');
    
    // Check cache
    try {
      const cached = await fs.readFile(cacheFile, 'utf-8');
      console.log('✓ Loaded MMLU-Pro from cache');
      return JSON.parse(cached);
    } catch {
      console.log('Fetching MMLU-Pro from HuggingFace...');
    }
    
    // Fetch from HuggingFace (get first 1000 questions - dataset has 12032 total)
    const response = await fetch(
      'https://datasets-server.huggingface.co/rows?dataset=TIGER-Lab/MMLU-Pro&config=default&split=test&offset=0&limit=1000'
    );
    
    if (!response.ok) {
      throw new Error(`Failed to fetch MMLU-Pro: ${response.status}`);
    }
    
    const data: any = await response.json();
    const questions: BenchmarkQuestion[] = data.rows.map((row: any) => ({
      id: `mmlu-pro-${row.row_idx}`,
      question: row.row.question,
      options: row.row.options,
      correctAnswer: row.row.answer,
      metadata: {
        subject: row.row.subject,
        category: row.row.category
      }
    }));
    
    // Cache
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify(questions, null, 2));
    
    console.log(`✓ Loaded ${questions.length} MMLU-Pro questions`);
    return questions;
  }
  
  formatPrompt(question: BenchmarkQuestion, step: number, previousResponses: string[]): string {
    const optionsText = question.options?.join('\n') || '';
    
    if (step === 1) {
      // First CoT step
      return `The following is a multiple choice question. Think through it step by step.

Question: ${question.question}

${optionsText}

Let's approach this systematically:`;
    } else {
      // Subsequent CoT steps
      const context = previousResponses.map((r, i) => `Step ${i + 1}: ${r}`).join('\n\n');
      return `${context}

Continue your reasoning and provide the final answer as a single letter (A-J):`;
    }
  }
  
  extractAnswer(modelResponse: string): string {
    // Extract letter A-J
    const match = modelResponse.match(/\b([A-J])\b/i);
    return match ? match[1].toUpperCase() : '';
  }
  
  async evaluateAnswer(extracted: string, correct: string): Promise<boolean> {
    return extracted.toUpperCase() === correct.toUpperCase();
  }
}

