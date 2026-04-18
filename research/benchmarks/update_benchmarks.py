#!/usr/bin/env python3
"""
Display instructions and links for manually updating benchmark standards.

This script shows where to find the latest leaderboard data for each benchmark.
After visiting the links and gathering data, manually update standards.json.

Usage:
  python update_benchmarks.py
  python update_benchmarks.py --benchmark mmlu-pro
"""

import argparse
import json


def load_standards():
    with open('standards.json') as f:
        return json.load(f)


def print_update_instructions(benchmark_key, benchmark_data):
    print(f'\n{"=" * 80}')
    print(f'📊 {benchmark_data["name"]}')
    print('=' * 80)
    print('\n📍 Official Source:')
    print(f'   {benchmark_data["source"]}')

    print('\n📝 Update Instructions:')
    print(f'   {benchmark_data["updateInstructions"]}')

    print('\n🔗 Where to find latest results:')
    if 'mmlu-pro' in benchmark_key:
        print('   • Leaderboard: https://huggingface.co/spaces/TIGER-Lab/MMLU-Pro')
        print('   • Look for: Top models with scores ≥70%')
    elif 'terminal-bench' in benchmark_key:
        print('   • Website: https://www.tbench.ai')
        print('   • Look for: Terminal-Bench Hard (47 tasks) results')

    print('\n📄 Current Standards:')
    for idx, std in enumerate(benchmark_data['industryStandards'][:5], 1):
        notes = f' ({std.get("notes", "")})' if std.get('notes') else ''
        print(f'   {idx}. {std["model"]}: {std["score"]}%{notes} - {std["date"]}')

    print('\n✏️  To update:')
    print('   1. Visit the leaderboard URL above')
    print('   2. Find the latest model scores')
    print('   3. Edit research/benchmarks/standards.json')
    print(f"   4. Update the 'industryStandards' array for '{benchmark_key}'")
    print("   5. Update 'lastUpdated' to today's date")


def main():
    parser = argparse.ArgumentParser(
        description='Display instructions for updating benchmark standards'
    )
    parser.add_argument('--benchmark', help='Show instructions for specific benchmark only')
    args = parser.parse_args()

    try:
        data = load_standards()
    except FileNotFoundError:
        print('❌ Error: standards.json not found')
        print('   Expected location: research/benchmarks/standards.json')
        return

    print('\n🔄 BENCHMARK STANDARDS UPDATE GUIDE')
    print('=' * 80)
    print('\nThis script helps you manually update industry benchmark standards.')
    print('Automated scraping will be added in the future.')

    benchmarks = data['benchmarks']

    if args.benchmark:
        if args.benchmark in benchmarks:
            print_update_instructions(args.benchmark, benchmarks[args.benchmark])
        else:
            print(f'\n❌ Unknown benchmark: {args.benchmark}')
            print(f'   Available: {", ".join(benchmarks.keys())}')
    else:
        # Show all benchmarks
        for key, bench_data in benchmarks.items():
            print_update_instructions(key, bench_data)

    print(f'\n{"=" * 80}')
    print('💡 Tip: Run with --benchmark <name> to see instructions for one benchmark')
    print('=' * 80 + '\n')


if __name__ == '__main__':
    main()
