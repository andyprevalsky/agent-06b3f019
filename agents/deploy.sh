#!/bin/bash

# Deployment script for Navi Temporal Agents to fly.io

set -e  # Exit on error

echo "🚀 Deploying Navi Temporal Agents to fly.io..."

# Check if flyctl is installed
if ! command -v fly &> /dev/null; then
    echo "❌ flyctl not found. Please install it:"
    echo "   curl -L https://fly.io/install.sh | sh"
    exit 1
fi

# Check if logged in
if ! fly auth whoami &> /dev/null; then
    echo "❌ Not logged in to fly.io. Please run:"
    echo "   fly auth login"
    exit 1
fi

# Check if .env exists for local testing
if [ ! -f .env ]; then
    echo "⚠️  No .env file found. Creating from template..."
    if [ -f .env.example ]; then
        cp .env.example .env
        echo "✅ Created .env from template. Please fill in your credentials."
        exit 1
    else
        echo "❌ No .env.example found"
        exit 1
    fi
fi

# Confirm deployment
read -p "Deploy to fly.io? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Deployment cancelled."
    exit 1
fi

echo "📦 Building and deploying..."

# Deploy
fly deploy

echo "✅ Deployment complete!"
echo ""
echo "📊 Check status:"
echo "   fly status"
echo ""
echo "📋 View logs:"
echo "   fly logs"
echo ""
echo "🏥 Health check:"
echo "   curl https://navi-temporal-agents.fly.dev/health"
echo ""
echo "🎯 Temporal Web UI:"
echo "   https://cloud.temporal.io"

