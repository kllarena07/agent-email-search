#!/bin/bash

set -e

echo "==================================="
echo "Email Thread Search - Starting..."
echo "==================================="

echo ""
echo "Step 1: Fetching ALL emails as threads..."
node fetch-threads.js

echo ""
echo "Step 2: Building TypeScript..."
pnpm build

echo ""
echo "Step 3: Running Claude Agent SDK search..."
node dist/search.js

echo ""
echo "==================================="
echo "Email Thread Search - Completed!"
echo "==================================="
