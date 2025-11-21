# Benchmark Datasets

This directory contains instructions and utilities for loading benchmark datasets.

## Datasets

### 1. MMLU-Pro
- **Source**: HuggingFace `datasets` library
- **Command**: `pip install datasets && python -c "from datasets import load_dataset; load_dataset('TIGER-Lab/MMLU-Pro')"`
- **Size**: 12,032 questions

### 2. GPQA Diamond
- **Source**: Official GPQA repository
- **URL**: https://github.com/idavidrein/gpqa
- **Size**: 198 questions

### 3. AIME 2025
- **Source**: Manual collection
- **URL**: https://artofproblemsolving.com/wiki/index.php/2025_AIME_Problems
- **Size**: 30 questions
- **Note**: Requires manual transcription

### 4. HLE (Humanity's Last Exam)
- **Source**: Official release by Hendrycks et al
- **URL**: https://github.com/centerforaisafety/HLE
- **Size**: 2,684 questions

### 5. IFBench
- **Source**: IFBench repository
- **URL**: https://github.com/Instruction-Following-Eval/IFBench
- **Size**: 294 questions

### 6. SciCode
- **Source**: SciCode repository
- **URL**: https://github.com/scicode-bench/SciCode
- **Size**: 338 subproblems

### 7. LiveCodeBench
- **Source**: LiveCodeBench repository
- **URL**: https://github.com/LiveCodeBench/LiveCodeBench
- **Size**: 315 questions

### 8. SWE-Bench Verified
- **Source**: SWE-bench repository
- **URL**: https://github.com/princeton-nlp/SWE-bench
- **Size**: 300 verified instances

### 9. Terminal-Bench Hard
- **Source**: Terminal-Bench repository
- **URL**: https://github.com/terminal-bench/terminal-bench
- **Size**: 47 tasks

### 10. τ²-Bench Telecom
- **Source**: τ²-Bench repository
- **URL**: https://github.com/tau2-bench/tau2-bench
- **Size**: 114 tasks

### 11. AA-LCR (Artificial Analysis Long Context Reasoning)
- **Source**: Artificial Analysis (if public)
- **URL**: https://artificialanalysis.ai
- **Size**: 100 questions
- **Note**: May need to be recreated if not publicly available

## Loading Datasets

Each benchmark harness implements a `loadDataset()` method that handles dataset loading, caching, and formatting.






