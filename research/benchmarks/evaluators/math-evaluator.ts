/**
 * Math Evaluator
 * 
 * Evaluates mathematical answers:
 * 1. Extract answer from \boxed{}
 * 2. Normalize using simple text normalization
 * 3. Fall back to equality checker for complex cases
 */

import { checkEquality } from './equality-checker.ts';

/**
 * Extract answer from LaTeX \boxed{} notation
 */
function extractBoxedAnswer(text: string): string | null {
  // Match \boxed{...} with proper brace handling
  const boxedMatch = text.match(/\\boxed\{([^}]+)\}/);
  if (boxedMatch) {
    return boxedMatch[1].trim();
  }
  
  // Also try without backslash (some models forget it)
  const boxedMatch2 = text.match(/boxed\{([^}]+)\}/);
  if (boxedMatch2) {
    return boxedMatch2[1].trim();
  }
  
  return null;
}

/**
 * Normalize a mathematical expression for comparison
 */
function normalizeMathExpression(expr: string): string {
  return expr
    .toLowerCase()
    .replace(/\s+/g, '')           // Remove all whitespace
    .replace(/\\,/g, '')           // Remove LaTeX spacing
    .replace(/\\text\{([^}]+)\}/g, '$1')  // Remove \text{}
    .replace(/\\mathrm\{([^}]+)\}/g, '$1') // Remove \mathrm{}
    .replace(/\$/g, '')            // Remove dollar signs
    .replace(/,(\d{3})/g, '$1')    // Remove thousands separators
    .replace(/\./g, '')            // Remove decimal points for integers
    .replace(/^0+/, '')            // Remove leading zeros
    .trim();
}

/**
 * Check if two mathematical expressions are equivalent
 */
function areExpressionsEqual(expr1: string, expr2: string): boolean {
  const norm1 = normalizeMathExpression(expr1);
  const norm2 = normalizeMathExpression(expr2);
  
  // Direct string comparison
  if (norm1 === norm2) {
    return true;
  }
  
  // Try parsing as numbers
  const num1 = parseFloat(norm1);
  const num2 = parseFloat(norm2);
  
  if (!isNaN(num1) && !isNaN(num2)) {
    // Allow small relative error for floating point
    const relativeError = Math.abs(num1 - num2) / Math.max(Math.abs(num1), Math.abs(num2));
    return relativeError < 0.0001; // 0.01% tolerance
  }
  
  return false;
}

/**
 * Evaluate if a model's mathematical answer is correct
 * 
 * @param modelResponse - Full response from the model
 * @param correctAnswer - The correct answer
 * @param question - Optional question for context (used in LLM fallback)
 * @param apiKey - Optional API key for LLM fallback
 * @returns true if answer is correct, false otherwise
 */
export async function evaluateMathAnswer(
  modelResponse: string,
  correctAnswer: string,
  question?: string,
  apiKey?: string
): Promise<boolean> {
  // Step 1: Try to extract from \boxed{}
  const extractedAnswer = extractBoxedAnswer(modelResponse);
  
  if (!extractedAnswer) {
    console.warn('No answer found in \\boxed{}, trying LLM fallback');
    // Fall back to LLM equality checker
    return await checkEquality(modelResponse, correctAnswer, question, apiKey);
  }
  
  // Step 2: Normalize and compare
  const isEqual = areExpressionsEqual(extractedAnswer, correctAnswer);
  
  if (isEqual) {
    console.log(`Math answer correct: ${extractedAnswer} = ${correctAnswer}`);
    return true;
  }
  
  // Step 3: If simple comparison failed, try LLM fallback
  console.log(`Simple comparison failed (${extractedAnswer} != ${correctAnswer}), trying LLM fallback`);
  return await checkEquality(extractedAnswer, correctAnswer, question, apiKey);
}

/**
 * Extract just the answer from a model response (for testing)
 */
export function extractMathAnswer(modelResponse: string): string {
  const boxed = extractBoxedAnswer(modelResponse);
  if (boxed) {
    return boxed;
  }
  
  // Try to find any number at the end
  const numberMatch = modelResponse.match(/(\d+(?:\.\d+)?)\s*$/);
  if (numberMatch) {
    return numberMatch[1];
  }
  
  return '';
}











