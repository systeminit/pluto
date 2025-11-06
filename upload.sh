#!/bin/bash

# Pluto App Upload Script - Shell version
# This builds and pushes the Docker image to ECR

set -e

AWS_ACCOUNT_ID="300264401084"
AWS_REGION="us-east-1"
ECR_REPOSITORY="pluto-app"
IMAGE_TAG="latest"
ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
ECR_IMAGE_URI="${ECR_REGISTRY}/${ECR_REPOSITORY}:${IMAGE_TAG}"

echo "🚀 Starting Pluto App upload to ECR..."
echo "📦 Target: ${ECR_IMAGE_URI}"
echo ""

# Check prerequisites
echo "📋 Checking prerequisites..."
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed or not running"
    exit 1
fi

if ! command -v aws &> /dev/null; then
    echo "❌ AWS CLI is not installed"
    exit 1
fi

echo "✅ Prerequisites check passed"

# Authenticate with ECR
echo "🔐 Authenticating with AWS ECR..."
aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${ECR_REGISTRY}
if [ $? -ne 0 ]; then
    echo "❌ ECR authentication failed"
    exit 1
fi
echo "✅ ECR authentication successful"

# Build Docker image
echo "🏗️  Building Docker image..."
docker build -t ${ECR_IMAGE_URI} -t pluto-app:latest .
if [ $? -ne 0 ]; then
    echo "❌ Docker build failed"
    exit 1
fi
echo "✅ Docker image built successfully"

# Push to ECR
echo "🚀 Pushing image to ECR..."
docker push ${ECR_IMAGE_URI}
if [ $? -ne 0 ]; then
    echo "❌ Docker push failed"
    exit 1
fi
echo "✅ Image pushed successfully to ECR"

echo ""
echo "🎉 Upload completed successfully!"
echo "📍 Image available at: ${ECR_IMAGE_URI}"
echo "💡 The ECS service will automatically deploy the new image."