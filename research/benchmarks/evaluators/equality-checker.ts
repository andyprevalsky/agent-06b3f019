/**
 * Equality Checker Evaluator
 * 
 * Uses GPT-4o to determine if two answers are semantically equivalent.
 * This runs inside the benchmark harness (not as a separate API).
 * Uses OPENROUTER_API_KEY from environment.
 */

const EQUALITY_CHECKER_PROMPT = `Judge whether the following [response] to [question] is correct or not based on the precise and unambiguous [correct_answer] below.

[question]: {question}

[response]: {response}

Your judgement must be in the format and criteria specified below:

extracted_final_answer: The final exact answer extracted from the [response]. Put the extracted answer as 'None' if there is no exact, final answer to extract from the response.

[correct_answer]: {correct_answer}

reasoning: Explain why the extracted_final_answer is correct or incorrect based on [correct_answer], focusing only on if there are meaningful differences between [correct_answer] and the extracted_final_answer. Do not comment on any background to the problem, do not attempt to solve the problem, do not argue for any answer different than [correct_answer], focus only on whether the answers match.

correct: Answer 'yes' if extracted_final_answer matches the [correct_answer] given above, or is within a small margin of error for numerical problems. Answer 'no' otherwise, i.e. if there if there is any inconsistency, ambiguity, non-equivalency, or if the extracted answer is incorrect.

confidence: The extracted confidence score between 0% and 100% from [response]. Put 100 if there is no confidence score available.`;

export interface EqualityCheckResult {
  isEqual: boolean;
  reasoning: string;
  confidence: number;
}

export async function checkEquality(
  modelAnswer: string,
  correctAnswer: string,
  question?: string,
  apiKey?: string
): Promise<boolean> {
  try {
    const prompt = EQUALITY_CHECKER_PROMPT
      .replace('{question}', question || 'N/A')
      .replace('{response}', modelAnswer)
      .replace('{correct_answer}', correctAnswer);

    // Use OPENROUTER_API_KEY from environment or provided key
    const key = apiKey || process.env.OPENROUTER_API_KEY;
    if (!key) {
      console.error('OPENROUTER_API_KEY not found in environment');
      throw new Error('Missing API key for equality checker');
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://rose-benchmark.app',
        'X-Title': 'Rose Benchmark Suite - Equality Checker'
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o',
        messages: [
          { role: 'user', content: prompt }
        ],
        temperature: 0.0, // Deterministic for evaluation
        max_tokens: 500
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Equality checker API error:', response.status, errorText);
      throw new Error(`Equality checker API error: ${response.status}`);
    }

    const data = await response.json();
    const checkerResponse = data.choices?.[0]?.message?.content || '';

    // Extract the "correct:" field from the response
    const correctMatch = checkerResponse.match(/correct:\s*(yes|no)/i);
    if (!correctMatch) {
      console.warn('Could not extract correct/incorrect from checker response:', checkerResponse);
      // Fall back to simple string matching
      return modelAnswer.toLowerCase().trim() === correctAnswer.toLowerCase().trim();
    }

    const isCorrect = correctMatch[1].toLowerCase() === 'yes';
    
    console.log(`Equality check: "${modelAnswer}" vs "${correctAnswer}" => ${isCorrect ? 'MATCH' : 'NO MATCH'}`);
    
    return isCorrect;

  } catch (error) {
    console.error('Error in equality checker:', error);
    // Fall back to simple string matching
    return modelAnswer.toLowerCase().trim() === correctAnswer.toLowerCase().trim();
  }
}

/**
 * Detailed equality check with full response parsing
 */
export async function checkEqualityDetailed(
  modelAnswer: string,
  correctAnswer: string,
  question?: string,
  apiKey?: string
): Promise<EqualityCheckResult> {
  try {
    const prompt = EQUALITY_CHECKER_PROMPT
      .replace('{question}', question || 'N/A')
      .replace('{response}', modelAnswer)
      .replace('{correct_answer}', correctAnswer);

    const key = apiKey || process.env.OPENROUTER_API_KEY;
    if (!key) {
      throw new Error('Missing API key for equality checker');
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://rose-benchmark.app',
        'X-Title': 'Rose Benchmark Suite - Equality Checker'
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o',
        messages: [
          { role: 'user', content: prompt }
        ],
        temperature: 0.0,
        max_tokens: 500
      })
    });

    if (!response.ok) {
      throw new Error(`Equality checker API error: ${response.status}`);
    }

    const data = await response.json();
    const checkerResponse = data.choices?.[0]?.message?.content || '';

    // Parse the structured response
    const correctMatch = checkerResponse.match(/correct:\s*(yes|no)/i);
    const reasoningMatch = checkerResponse.match(/reasoning:\s*(.+?)(?=\n\n|confidence:|$)/is);
    const confidenceMatch = checkerResponse.match(/confidence:\s*(\d+)/i);

    return {
      isEqual: correctMatch?.[1].toLowerCase() === 'yes',
      reasoning: reasoningMatch?.[1].trim() || 'No reasoning provided',
      confidence: confidenceMatch ? parseInt(confidenceMatch[1]) : 100
    };

  } catch (error) {
    console.error('Error in detailed equality checker:', error);
    // Fall back to simple comparison
    const isEqual = modelAnswer.toLowerCase().trim() === correctAnswer.toLowerCase().trim();
    return {
      isEqual,
      reasoning: 'Fallback to string matching due to API error',
      confidence: 50
    };
  }
}

