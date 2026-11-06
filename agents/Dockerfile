FROM python:3.11.9-slim

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
    && apt-get install -y nodejs \
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
