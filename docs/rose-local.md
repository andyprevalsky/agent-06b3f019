# Rose Local

Rose Local routes Rose model inference to an OpenAI-compatible server on the same machine as the Rose backend or agent worker. It has no provider API fallback. If the server or model is unavailable, the request fails.

The current Rose app still sends queries, agent state, tool results, and other service data through the Rose backend. This pool does **not** make a cloud-hosted Rose run fully private. A Mac-hosted model cannot be reached by the current cloud worker through its loopback address; full device-local execution needs a separate local agent runtime and storage path.

## Engine

Use `llama.cpp`'s `llama-server` with a tool-capable GGUF model. It supports Metal on Apple Silicon and an OpenAI-compatible chat endpoint. Start it on the same machine as the Rose process:

```bash
llama-server -m /absolute/path/to/model.gguf --host 127.0.0.1 --port 8080 --jinja -c 8192
```

Configure **both** the backend and agent worker when they run on separate machines:

```bash
ROSE_LOCAL_BASE_URL=http://127.0.0.1:8080/v1
ROSE_LOCAL_MODEL=/absolute/path/to/model.gguf
```

`ROSE_LOCAL_MODEL` must match the server's `/v1/models` ID. Rose accepts HTTP loopback addresses only and rejects remote hosts. The backend chat client also rejects redirects. The pool ID is `rose-labs/rose-local` in the querybox.

## Performance

The querybox leaves average output tokens/s, peak throughput, and percentages versus Flash and Ultra unmeasured until they are benchmarked on the actual target machine and model. The development smoke used a 0.6B Q4 model on a Linux CPU; it validates routing and tool calls, not Apple Silicon performance or long-horizon agent quality. Measure a tool-heavy Rose task and a matching output-token throughput workload on the target Mac before publishing comparative numbers.
