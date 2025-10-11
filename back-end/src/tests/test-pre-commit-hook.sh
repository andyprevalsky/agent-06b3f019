#!/bin/bash
# Test script to verify pre-commit hook blocks commits when tests fail

echo "🧪 Testing pre-commit hook behavior..."
echo ""

# Test 1: Server not running
echo "Test 1: Backend server not running"
echo "--------------------------------------"
echo "Stopping backend server (if running)..."

# Find and kill any running backend server on port 3001
lsof -ti:3001 | xargs kill -9 2>/dev/null || true
sleep 1

# Try to commit (should fail)
echo "Attempting commit with server down..."
git add .husky/pre-commit 2>/dev/null
git commit --dry-run -m "test: should fail" 2>&1 | head -n 5

echo ""
echo "Expected: ❌ Backend server not running"
echo ""

# Test 2: Server running (tests should pass)
echo "Test 2: Backend server running"
echo "--------------------------------------"
echo "Start backend server with: npm run dev"
echo "Then run this script again"
echo ""

if curl -s http://localhost:3001/health > /dev/null 2>&1; then
  echo "✅ Server is running!"
  echo ""
  echo "Pre-commit hook will:"
  echo "  1. Check if server is running ✅"
  echo "  2. Run all API tests (23 tests)"
  echo "  3. Allow commit if all tests pass ✅"
  echo "  4. Block commit if any tests fail ❌"
else
  echo "❌ Server is not running"
  echo "   Start it with: cd back-end && npm run dev"
fi

