#!/usr/bin/env python3
"""
Test LLM image/file size limits for rose-lite-pool and rose-ultra-pool models.

Tests models via the Rose API using model_seed parameter for deterministic selection.
Executes ONE HTTP request per invocation to allow resuming progress at any point.

Usage:
    python test_llm_image_limits.py <pool> <model_seed> <file_size_mb>

Examples:
    python test_llm_image_limits.py rose-lite 0 5
    python test_llm_image_limits.py rose-ultra 2 10

    # Run all tests sequentially
    python test_llm_image_limits.py --run-all

    # Show next test to run
    python test_llm_image_limits.py --next

    # Print summary of results
    python test_llm_image_limits.py --summary

Results are saved to test_llm_image_limits_results.json
"""

import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path

import requests

# Configuration
API_URL = "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions"
API_KEY = "af1ea4b12ea8dbe07c555a45a8ad4dc8"
AUTH_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScgLtWKh0DYc8sXZz3XU"
REQUEST_TIMEOUT = 20  # seconds

# Model pools (must match index.ts in research/supabase/functions/completions/)
MODEL_POOLS = {
    "rose-lite": [
        "moonshotai/kimi-k2-0905",
        "openai/gpt-5.2",
        "google/gemini-2.5-flash",
        "anthropic/claude-haiku-4.5",
    ],
    "rose-ultra": [
        "openai/gpt-5.2",
        "anthropic/claude-sonnet-4.5",
        "moonshotai/kimi-k2-thinking",
        "google/gemini-3-pro-preview",
        "x-ai/grok-4.1-fast",
    ],
}

# File sizes to test in MB
FILE_SIZES_MB = [1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50]

RESULTS_FILE = Path(__file__).parent / "test_llm_image_limits_results.json"


def generate_image_base64(size_mb: int) -> str:
    """Generate a base64-encoded PNG image of approximately the specified size in MB."""
    try:
        from PIL import Image
        import numpy as np
    except ImportError:
        print("PIL/numpy not installed. Run: pip install Pillow numpy")
        sys.exit(1)

    from io import BytesIO

    target_bytes = int(size_mb * 1024 * 1024)

    # Start with a reasonable dimension estimate
    # PNG with random noise compresses poorly, giving us larger files
    dim = int((target_bytes / 3) ** 0.5)  # Rough estimate for RGB
    dim = max(100, min(dim, 15000))  # Clamp to reasonable range

    # Create random noise image (compresses poorly = larger file)
    np.random.seed(42)  # Reproducible
    noise = np.random.randint(0, 256, (dim, dim, 3), dtype=np.uint8)
    img = Image.fromarray(noise, 'RGB')

    # Save to bytes and check size
    buffer = BytesIO()
    img.save(buffer, format='PNG', compress_level=0)  # No compression

    actual_size = buffer.tell()

    # Adjust dimensions iteratively to get closer to target
    for _ in range(5):
        ratio = (target_bytes / actual_size) ** 0.5
        dim = int(dim * ratio)
        dim = max(100, min(dim, 15000))

        noise = np.random.randint(0, 256, (dim, dim, 3), dtype=np.uint8)
        img = Image.fromarray(noise, 'RGB')

        buffer = BytesIO()
        img.save(buffer, format='PNG', compress_level=0)
        actual_size = buffer.tell()

        if 0.9 <= actual_size / target_bytes <= 1.1:
            break

    buffer.seek(0)
    return base64.b64encode(buffer.read()).decode("utf-8")


def test_model(pool_name: str, model_seed: int, file_size_mb: int) -> dict:
    """
    Test a specific model with a specific file size.
    Returns a result dict with success/failure info.
    """
    if pool_name not in MODEL_POOLS:
        return {
            "pool": pool_name,
            "model_seed": model_seed,
            "file_size_mb": file_size_mb,
            "success": False,
            "error": f"Unknown pool: {pool_name}. Valid pools: {list(MODEL_POOLS.keys())}",
        }

    pool = MODEL_POOLS[pool_name]
    if model_seed < 0 or model_seed >= len(pool):
        return {
            "pool": pool_name,
            "model_seed": model_seed,
            "file_size_mb": file_size_mb,
            "success": False,
            "error": f"model_seed {model_seed} out of range. Pool has {len(pool)} models (0-{len(pool)-1})",
        }

    model_name = pool[model_seed]
    api_model = f"rose-labs/rose-1-{'lite' if pool_name == 'rose-lite' else 'ultra'}"

    print(f"\n{'='*60}")
    print(f"Testing: {model_name} (pool={pool_name}, seed={model_seed})")
    print(f"File size: {file_size_mb}MB")
    print(f"{'='*60}")

    # Generate the test image
    print(f"Generating {file_size_mb}MB base64 image...")
    start_gen = time.time()
    image_base64 = generate_image_base64(file_size_mb)
    gen_time = time.time() - start_gen
    actual_size_mb = len(image_base64) / (1024 * 1024)
    print(f"Generated {actual_size_mb:.2f}MB in {gen_time:.2f}s")

    # Prepare the request
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {AUTH_TOKEN}",
        "x-api-key": API_KEY,
    }

    payload = {
        "model": api_model,
        "model_seed": model_seed,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{image_base64}"
                        }
                    },
                    {
                        "type": "text",
                        "text": "What do you see in this image? Reply in 10 words or less."
                    }
                ]
            }
        ],
        "max_tokens": 50,
        "stream": False,
    }

    # Make the request
    print(f"Sending request to {api_model} with model_seed={model_seed}...")
    print(f"Timeout: {REQUEST_TIMEOUT}s")

    result = {
        "pool": pool_name,
        "model_seed": model_seed,
        "model_name": model_name,
        "file_size_mb": file_size_mb,
        "actual_size_mb": round(actual_size_mb, 2),
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }

    try:
        start_req = time.time()
        response = requests.post(
            API_URL,
            headers=headers,
            json=payload,
            timeout=REQUEST_TIMEOUT,
        )
        req_time = time.time() - start_req

        result["status_code"] = response.status_code
        result["request_time_s"] = round(req_time, 2)

        if response.status_code == 200:
            resp_json = response.json()
            result["success"] = True
            result["response"] = {
                "model": resp_json.get("model"),
                "usage": resp_json.get("usage"),
                "content": resp_json.get("choices", [{}])[0].get("message", {}).get("content", "")[:200],
            }
            print(f"✅ SUCCESS in {req_time:.2f}s")
            print(f"   Model: {resp_json.get('model')}")
            print(f"   Usage: {resp_json.get('usage')}")
        else:
            result["success"] = False
            try:
                result["error"] = response.json()
            except:
                result["error"] = response.text[:500]
            print(f"❌ FAILED with status {response.status_code}")
            print(f"   Error: {result['error']}")

    except requests.Timeout:
        result["success"] = False
        result["error"] = f"Request timed out after {REQUEST_TIMEOUT}s"
        print(f"❌ TIMEOUT after {REQUEST_TIMEOUT}s")

    except Exception as e:
        result["success"] = False
        result["error"] = str(e)
        print(f"❌ ERROR: {e}")

    return result


def load_results() -> list:
    """Load existing results from file."""
    if RESULTS_FILE.exists():
        with open(RESULTS_FILE, "r") as f:
            return json.load(f)
    return []


def save_result(result: dict):
    """Append a result to the results file."""
    results = load_results()
    results.append(result)
    with open(RESULTS_FILE, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nResult saved to {RESULTS_FILE}")


def get_next_test(results: list) -> tuple | None:
    """
    Determine the next test to run based on existing results.
    Returns (pool_name, model_seed, file_size_mb) or None if all tests complete.
    """
    # Build a set of completed tests and failures
    completed = set()
    failures = {}  # (pool, seed) -> min_failed_size

    for r in results:
        key = (r["pool"], r["model_seed"], r["file_size_mb"])
        completed.add(key)

        if not r["success"]:
            model_key = (r["pool"], r["model_seed"])
            if model_key not in failures:
                failures[model_key] = r["file_size_mb"]
            else:
                failures[model_key] = min(failures[model_key], r["file_size_mb"])

    # Find next test to run
    for pool_name, pool in MODEL_POOLS.items():
        for model_seed in range(len(pool)):
            model_key = (pool_name, model_seed)

            # Skip if this model has already failed
            if model_key in failures:
                continue

            for size_mb in FILE_SIZES_MB:
                key = (pool_name, model_seed, size_mb)
                if key not in completed:
                    return (pool_name, model_seed, size_mb)

    return None


def print_summary(results: list):
    """Print a summary of all test results."""
    print("\n" + "="*80)
    print("TEST RESULTS SUMMARY")
    print("="*80)

    # Group by model
    by_model = {}
    for r in results:
        key = (r["pool"], r["model_seed"], r.get("model_name", "unknown"))
        if key not in by_model:
            by_model[key] = []
        by_model[key].append(r)

    for (pool, seed, model_name), model_results in sorted(by_model.items()):
        print(f"\n{pool} seed={seed} ({model_name}):")

        successes = [r for r in model_results if r["success"]]
        failures = [r for r in model_results if not r["success"]]

        if successes:
            max_success = max(r["file_size_mb"] for r in successes)
            print(f"  ✅ Max successful size: {max_success}MB")

        if failures:
            min_failure = min(r["file_size_mb"] for r in failures)
            print(f"  ❌ First failure at: {min_failure}MB")
            # Show error for first failure
            first_fail = next(r for r in failures if r["file_size_mb"] == min_failure)
            error = first_fail.get("error", "unknown")
            if isinstance(error, dict):
                error = json.dumps(error)[:100]
            elif isinstance(error, str):
                error = error[:100]
            print(f"     Error: {error}...")


def main():
    parser = argparse.ArgumentParser(description="Test LLM image size limits")
    parser.add_argument("pool", nargs="?", help="Pool name (rose-lite or rose-ultra)")
    parser.add_argument("model_seed", nargs="?", type=int, help="Model seed (0-indexed)")
    parser.add_argument("file_size_mb", nargs="?", type=int, help="File size in MB")
    parser.add_argument("--run-all", action="store_true", help="Run all tests sequentially")
    parser.add_argument("--summary", action="store_true", help="Print summary of existing results")
    parser.add_argument("--next", action="store_true", help="Show next test to run")

    args = parser.parse_args()

    if args.summary:
        results = load_results()
        print_summary(results)
        return

    if args.next:
        results = load_results()
        next_test = get_next_test(results)
        if next_test:
            pool, seed, size = next_test
            print(f"Next test: python {__file__} {pool} {seed} {size}")
        else:
            print("All tests complete!")
        return

    if args.run_all:
        results = load_results()
        while True:
            next_test = get_next_test(results)
            if not next_test:
                print("\n✅ All tests complete!")
                break

            pool, seed, size = next_test
            result = test_model(pool, seed, size)
            save_result(result)
            results.append(result)

            # If test failed, skip remaining sizes for this model
            if not result["success"]:
                print(f"\n⚠️  Model {result.get('model_name')} failed at {size}MB, skipping larger sizes")

        print_summary(results)
        return

    # Single test mode
    if not all([args.pool, args.model_seed is not None, args.file_size_mb]):
        parser.print_help()
        print("\nExamples:")
        print(f"  python {__file__} rose-lite 0 5")
        print(f"  python {__file__} rose-ultra 2 10")
        print(f"  python {__file__} --run-all")
        print(f"  python {__file__} --summary")
        print(f"  python {__file__} --next")
        print("\nModel pools:")
        for pool_name, pool in MODEL_POOLS.items():
            print(f"  {pool_name}:")
            for i, model in enumerate(pool):
                print(f"    seed={i}: {model}")
        sys.exit(1)

    result = test_model(args.pool, args.model_seed, args.file_size_mb)
    save_result(result)

    if result["success"]:
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
