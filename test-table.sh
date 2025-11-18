#!/bin/bash
# Helper script to test DynamoDB table names
# Usage: ./test-table.sh <table-name>

TABLE_NAME=$1

if [ -z "$TABLE_NAME" ]; then
  echo "Usage: ./test-table.sh <table-name>"
  exit 1
fi

echo "Testing table: $TABLE_NAME"
echo "---"

# Try to scan the table and get a sample item
aws dynamodb scan \
  --table-name "$TABLE_NAME" \
  --limit 1 \
  --output json 2>&1 | head -50

