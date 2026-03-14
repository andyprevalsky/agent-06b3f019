"""Measure streaming response: TTFC (time to first contentful token) and total time."""
import sys, time, json, subprocess, os

SUPABASE_URL = "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions"
ANON_KEY = os.environ["SUPABASE_ANON_KEY"]
API_KEY = os.environ["ROSE_API_KEY"]
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_KEY = os.environ["OPENROUTER_API_KEY"]


def measure_stream(stdin):
    start = time.time()
    first_content_time = None
    first_any_time = None
    reasoning_chars = 0
    content_chars = 0
    finish_reason = None
    chunk_count = 0
    actual_model = None

    for line in stdin:
        line = line.strip()
        if not line.startswith('data: '):
            continue
        data_str = line[6:]
        if data_str == '[DONE]':
            break
        chunk_count += 1
        try:
            d = json.loads(data_str)
            if not actual_model and d.get('actual_model'):
                actual_model = d['actual_model']
            choices = d.get('choices', [])
            if not choices:
                continue
            delta = choices[0].get('delta', {})
            r = delta.get('reasoning', '')
            c = delta.get('content', '')
            fr = choices[0].get('finish_reason')
            if r:
                reasoning_chars += len(r)
                if first_any_time is None:
                    first_any_time = time.time()
            if c and c.strip():
                content_chars += len(c)
                if first_any_time is None:
                    first_any_time = time.time()
                if first_content_time is None:
                    first_content_time = time.time()
            if fr is not None and fr != 'null':
                finish_reason = fr
        except json.JSONDecodeError:
            pass

    elapsed = time.time() - start
    ttfa = (first_any_time - start) if first_any_time else None
    ttfc = (first_content_time - start) if first_content_time else None

    return {
        'actual_model': actual_model,
        'ttfa': ttfa,
        'ttfc': ttfc,
        'total': elapsed,
        'chunks': chunk_count,
        'reasoning_chars': reasoning_chars,
        'content_chars': content_chars,
        'finish_reason': finish_reason,
    }


def run_test_openrouter(model, payload_path):
    """Test a model directly via OpenRouter."""
    with open(payload_path) as f:
        body = json.load(f)

    body['model'] = model
    body.pop('claude_token', None)
    body['stream'] = True
    body.setdefault('stream_options', {'include_usage': True})

    proc = subprocess.Popen(
        ['curl', '-s', '--max-time', '120',
         '-X', 'POST', OPENROUTER_URL,
         '-H', 'Content-Type: application/json',
         '-H', f'Authorization: Bearer {OPENROUTER_KEY}',
         '-d', json.dumps(body)],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    result = measure_stream(proc.stdout)
    proc.wait()
    return result


def run_test_claude_auth(payload_path, claude_token):
    """Test via Rose endpoint with claude_token (claudeAuth path)."""
    with open(payload_path) as f:
        body = json.load(f)

    body['model'] = 'rose-labs/rose-1-lite'
    body['claude_token'] = claude_token
    body['stream'] = True
    body.setdefault('stream_options', {'include_usage': True})

    proc = subprocess.Popen(
        ['curl', '-s', '--max-time', '120',
         '-X', 'POST', SUPABASE_URL,
         '-H', 'Content-Type: application/json',
         '-H', f'Authorization: Bearer {ANON_KEY}',
         '-H', f'x-api-key: {API_KEY}',
         '-d', json.dumps(body)],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    result = measure_stream(proc.stdout)
    proc.wait()
    return result


def print_row(r, label=None):
    name = label or r['actual_model'] or '???'
    ttfa_s = f"{r['ttfa']:.1f}s" if r['ttfa'] else "N/A"
    ttfc_s = f"{r['ttfc']:.1f}s" if r['ttfc'] else "NONE"
    total_s = f"{r['total']:.1f}s"
    print(f"{name:<35} {ttfa_s:>6} {ttfc_s:>6} {total_s:>6} {r['reasoning_chars']:>7} {r['content_chars']:>8} {r['finish_reason'] or 'N/A':>8}")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        # stdin pipe mode
        r = measure_stream(sys.stdin)
        print(f"Model: {r['actual_model']}")
        print(f"TTFA: {r['ttfa']:.1f}s" if r['ttfa'] else "TTFA: N/A")
        print(f"TTFC: {r['ttfc']:.1f}s" if r['ttfc'] else "TTFC: N/A (no content)")
        print(f"Total: {r['total']:.1f}s")
        print(f"Chunks: {r['chunks']}")
        print(f"Reasoning: {r['reasoning_chars']} chars")
        print(f"Content: {r['content_chars']} chars")
        print(f"Finish: {r['finish_reason']}")
    else:
        payload_path = sys.argv[1]
        claude_token = sys.argv[2] if len(sys.argv) > 2 else None

        models = [
            'minimax/minimax-m2.5',
            'moonshotai/kimi-k2.5',
            'google/gemini-3-flash-preview',
        ]

        print(f"{'Model':<35} {'TTFA':>6} {'TTFC':>6} {'Total':>6} {'Reason':>7} {'Content':>8} {'Finish':>8}")
        print('-' * 90)

        # ClaudeAuth baseline first
        if claude_token:
            r = run_test_claude_auth(payload_path, claude_token)
            print_row(r, label=f"claudeAuth ({r['actual_model'] or '?'})")
            print('-' * 90)

        # Each waterfall model via OpenRouter
        for model in models:
            r = run_test_openrouter(model, payload_path)
            print_row(r, label=r['actual_model'] or model)
