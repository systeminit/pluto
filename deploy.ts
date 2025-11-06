#!/usr/bin/env -S deno run --allow-run --allow-env
/**
 * Pluto App Deployment Script
 * 
 * This script builds the Docker image and pushes it to the AWS ECR repository
 * for the pluto-production account.
 * 
 * Usage: deno task deploy
 */

const AWS_ACCOUNT_ID = "300264401084";
const AWS_REGION = "us-east-1";
const ECR_REPOSITORY = "pluto-app";
const IMAGE_TAG = "latest";

const ECR_REGISTRY = `${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com`;
const ECR_IMAGE_URI = `${ECR_REGISTRY}/${ECR_REPOSITORY}:${IMAGE_TAG}`;

interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  console.log(`🔧 Running: ${command} ${args.join(' ')}`);
  
  const process = new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await process.output();
  
  return {
    success: code === 0,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

async function checkPrerequisites(): Promise<boolean> {
  console.log("📋 Checking prerequisites...");
  
  // Check if Docker is installed and running
  const dockerCheck = await runCommand("docker", ["version"]);
  if (!dockerCheck.success) {
    console.error("❌ Docker is not installed or not running");
    console.error(dockerCheck.stderr);
    return false;
  }
  
  // Check if AWS CLI is installed
  const awsCheck = await runCommand("aws", ["--version"]);
  if (!awsCheck.success) {
    console.error("❌ AWS CLI is not installed");
    console.error(awsCheck.stderr);
    return false;
  }
  
  console.log("✅ Prerequisites check passed");
  return true;
}

async function authenticateECR(): Promise<boolean> {
  console.log("🔐 Authenticating with AWS ECR...");
  
  // Get ECR login password and authenticate Docker
  const loginCommand = await runCommand("aws", [
    "ecr", "get-login-password",
    "--region", AWS_REGION
  ]);
  
  if (!loginCommand.success) {
    console.error("❌ Failed to get ECR login password");
    console.error(loginCommand.stderr);
    return false;
  }
  
  // Pipe the password to docker login
  const dockerLogin = new Deno.Command("docker", {
    args: ["login", "--username", "AWS", "--password-stdin", ECR_REGISTRY],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  
  const loginProcess = dockerLogin.spawn();
  const writer = loginProcess.stdin.getWriter();
  await writer.write(new TextEncoder().encode(loginCommand.stdout));
  await writer.close();
  
  const { success, stderr } = await loginProcess.output();
  
  if (!success) {
    console.error("❌ Docker ECR authentication failed");
    console.error(new TextDecoder().decode(stderr));
    return false;
  }
  
  console.log("✅ ECR authentication successful");
  return true;
}

async function buildDockerImage(): Promise<boolean> {
  console.log("🏗️  Building Docker image...");
  
  const buildResult = await runCommand("docker", [
    "build",
    "-t", ECR_IMAGE_URI,
    "-t", "pluto-app:latest",
    "."
  ]);
  
  if (!buildResult.success) {
    console.error("❌ Docker build failed");
    console.error(buildResult.stderr);
    return false;
  }
  
  console.log("✅ Docker image built successfully");
  return true;
}

async function pushDockerImage(): Promise<boolean> {
  console.log("🚀 Pushing image to ECR...");
  
  const pushResult = await runCommand("docker", [
    "push", ECR_IMAGE_URI
  ]);
  
  if (!pushResult.success) {
    console.error("❌ Docker push failed");
    console.error(pushResult.stderr);
    return false;
  }
  
  console.log("✅ Image pushed successfully to ECR");
  return true;
}

async function main(): Promise<void> {
  console.log("🚀 Starting Pluto App deployment to ECR...");
  console.log(`📦 Target: ${ECR_IMAGE_URI}\n`);
  
  try {
    // Check prerequisites
    if (!(await checkPrerequisites())) {
      Deno.exit(1);
    }
    
    // Authenticate with ECR
    if (!(await authenticateECR())) {
      Deno.exit(1);
    }
    
    // Build Docker image
    if (!(await buildDockerImage())) {
      Deno.exit(1);
    }
    
    // Push to ECR
    if (!(await pushDockerImage())) {
      Deno.exit(1);
    }
    
    console.log("\n🎉 Deployment completed successfully!");
    console.log(`📍 Image available at: ${ECR_IMAGE_URI}`);
    console.log("💡 The ECS service will automatically deploy the new image.");
    
  } catch (error) {
    console.error("❌ Deployment failed:", error);
    Deno.exit(1);
  }
}

// Run the deployment
if (import.meta.main) {
  await main();
}