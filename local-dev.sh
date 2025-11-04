#!/bin/bash

echo "🚀 Setting up Pluto App for local development"

if [ ! -f .env ]; then
    echo "📝 Creating .env file from template..."
    cp .env.example .env
    echo "⚠️  Please edit .env with your actual AWS credentials"
    echo "   - AWS_ACCESS_KEY_ID"
    echo "   - AWS_SECRET_ACCESS_KEY" 
    echo "   - AWS_SESSION_TOKEN (if using temporary credentials)"
    echo ""
fi

echo "📦 Installing/caching dependencies..."
deno cache src/main.ts

echo "🗄️ Starting local DynamoDB..."
echo "   Make sure you have DynamoDB Local running on port 8001"
echo "   You can run it with: docker run -p 8001:8080 amazon/dynamodb-local"
echo ""

echo "🌟 Starting Pluto App..."
echo "   App will be available at: http://localhost:8080"
echo ""

deno task dev