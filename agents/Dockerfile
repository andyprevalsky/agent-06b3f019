FROM python:3.11.9-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

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
