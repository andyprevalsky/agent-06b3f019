FROM python:3.11.9-slim AS phone-harness-tools

# Isolate Phone Harness's Python 3.12 requirement from the Temporal interpreter.
RUN pip install --no-cache-dir uv==0.12.24
ENV UV_PYTHON_INSTALL_DIR=/opt/phone-harness/python \
    UV_TOOL_DIR=/opt/phone-harness/tools \
    UV_TOOL_BIN_DIR=/usr/local/bin
RUN uv tool install --python 3.12 --upgrade phone-harness==0.3.3 \
    && phone-harness --version

FROM python:3.11.9-slim

COPY --from=phone-harness-tools /opt/phone-harness /opt/phone-harness
COPY --from=phone-harness-tools /usr/local/bin/phone-harness /usr/local/bin/phone-harness
COPY --from=phone-harness-tools /usr/local/bin/uv /usr/local/bin/uv
ENV UV_PYTHON_INSTALL_DIR=/opt/phone-harness/python \
    UV_TOOL_DIR=/opt/phone-harness/tools \
    UV_TOOL_BIN_DIR=/usr/local/bin
ARG NODE_VERSION=22.23.4

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    ca-certificates \
    curl \
    git \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y "nodejs=${NODE_VERSION}-1nodesource1" \
    && rm -rf /var/lib/apt/lists/*

# Needed by helpers/e2b_log_collector.py for retained sandbox stdout/stderr logs.
RUN npm install -g @e2b/cli@2.13.0 && npm cache clean --force

# Copy requirements first for better caching; vendored wheels resolve beside them.
COPY requirements.txt .
COPY vendor/ ./vendor/

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create a non-root user
RUN useradd -m -u 1000 worker && chown -R worker:worker /app
USER worker

# Expose health check port
EXPOSE 8080

# Set environment variables
ENV PYTHONUNBUFFERED=1

# Run the worker
CMD ["python", "worker.py"]
