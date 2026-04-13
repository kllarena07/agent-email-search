#!/bin/bash

set -e

echo "==================================="
echo "Email Thread Search - Starting..."
echo "==================================="

echo ""
echo "Step 1: Validating environment and threads directory..."

# Check if SEARCH_QUERY is set and non-empty
if [ -z "$SEARCH_QUERY" ]; then
  echo "❌ Error: SEARCH_QUERY environment variable is not set"
  echo "Please set SEARCH_QUERY in your .env file or via docker-compose"
  exit 1
fi

if [ -z "$(echo "$SEARCH_QUERY" | tr -d '[:space:]')" ]; then
  echo "❌ Error: SEARCH_QUERY is empty"
  exit 1
fi

echo "✓ Search query: \"$SEARCH_QUERY\""

# Check if threads directory exists
if [ ! -d "threads" ]; then
  echo "❌ Error: threads/ directory not found"
  echo "Please ensure the threads/ directory exists and is mounted"
  exit 1
fi

# Check if threads directory contains .md files
if [ -z "$(find threads -name '*.md' -type f | head -1)" ]; then
  echo "❌ Error: threads/ directory does not contain any .md files"
  echo "Please ensure the threads/ directory contains email files"
  exit 1
fi

EMAIL_COUNT=$(find threads -name '*.md' -type f | wc -l)
echo "✓ Found $EMAIL_COUNT email files in threads/ directory"

echo ""
echo "Step 2: Running Claude Agent SDK search..."
node dist/search-threads.js

echo ""
echo "==================================="
echo "Email Thread Search - Completed!"
echo "==================================="
