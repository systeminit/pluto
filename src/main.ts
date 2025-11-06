import { load } from "@std/dotenv";
import { Hono } from "@hono/hono";
import { serve } from "https://deno.land/std@0.204.0/http/server.ts";
import { DynamoDBService } from "./services/dynamodb.ts";
import { AwsCredentialsService } from "./services/aws-credentials.ts";
import { WorkspaceService } from "./services/workspace.ts";
import { DeploymentService } from "./services/deployment.ts";

// Load environment variables from .env file
await load({ export: true });

const app = new Hono();

const dynamoService = new DynamoDBService();
const awsService = new AwsCredentialsService();
const workspaceService = new WorkspaceService();

// Store for deployment progress tracking
const deploymentProgress = new Map<string, any>();

// Initialize tables on startup with retry logic
console.log("🗄️ Initializing DynamoDB tables...");
const maxRetries = 10;
let retryCount = 0;
let tablesInitialized = false;

while (!tablesInitialized && retryCount < maxRetries) {
  try {
    await dynamoService.ensureTable();
    console.log("✅ DynamoDB tables initialized successfully");
    tablesInitialized = true;
  } catch (error) {
    retryCount++;
    if (retryCount < maxRetries) {
      const waitTime = Math.min(1000 * Math.pow(2, retryCount - 1), 5000); // Exponential backoff, max 5s
      console.log(`⏳ DynamoDB not ready yet (attempt ${retryCount}/${maxRetries}), retrying in ${waitTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    } else {
      console.error("❌ Failed to initialize DynamoDB tables after", maxRetries, "attempts:", error);
      console.error("The app will continue but may not work properly without database tables");
    }
  }
}

app.get("/", async (c) => {
  try {
    const template = await Deno.readTextFile("./src/templates/index.html");
    return c.html(template);
  } catch (error) {
    console.error("Error reading template file:", error);
    return c.html("<h1>Error loading template</h1><p>Could not load the HTML template file.</p>");
  }
});

app.post("/api/test-aws", async (c) => {
  try {
    const creds = await awsService.getCredentials();
    const result = await awsService.testCredentials(creds);
    return c.json({ success: result.success, error: result.error });
  } catch (error) {
    return c.json({ success: false, error: error.message });
  }
});

app.post("/api/test-dynamodb", async (c) => {
  try {
    const result = await dynamoService.testConnection();
    return c.json({ success: result.success, error: result.error });
  } catch (error) {
    return c.json({ success: false, error: error.message });
  }
});

app.post("/api/save-config", async (c) => {
  try {
    const body = await c.req.json();
    const workspaceId = Deno.env.get("SI_WORKSPACE_ID");
    const workspaceToken = Deno.env.get("WORKSPACE_API_TOKEN");
    
    if (!workspaceId) {
      return c.json({ success: false, error: "SI_WORKSPACE_ID environment variable not set" });
    }
    
    if (!workspaceToken) {
      return c.json({ success: false, error: "WORKSPACE_API_TOKEN environment variable not set" });
    }

    // Save workspace token to sensitive table
    const tokenResult = await dynamoService.saveWorkspaceToken(workspaceId, workspaceToken);
    if (!tokenResult.success) {
      return c.json({ success: false, error: `Failed to save workspace token: ${tokenResult.error}` });
    }
    
    // Save config data (without sensitive info)
    const config = {
      configName: body.configName,
      rootOu: body.rootOu,
      emails: body.emails
    };
    
    const result = await dynamoService.saveConfig(config);
    return c.json({ success: result.success, error: result.error });
  } catch (error) {
    return c.json({ success: false, error: error.message });
  }
});

app.post("/api/deploy-tenant/start", async (c: any) => {
  try {
    const body = await c.req.json();
    const configId = body.configId;
    const accountName = body.accountName;
    
    if (!configId) {
      return c.json({ success: false, error: "Configuration ID is required" });
    }
    
    if (!accountName || !accountName.trim()) {
      return c.json({ success: false, error: "Account name is required" });
    }
    
    // Generate unique deployment ID
    const deploymentId = crypto.randomUUID();
    
    // Get workspace token from sensitive data
    const workspaceId = Deno.env.get("SI_WORKSPACE_ID");
    if (!workspaceId) {
      return c.json({ success: false, error: "SI_WORKSPACE_ID not configured" });
    }
    
    const workspaceToken = await dynamoService.getWorkspaceToken(workspaceId);
    if (!workspaceToken) {
      return c.json({ success: false, error: "Workspace token not found" });
    }
    
    // Initialize deployment progress
    deploymentProgress.set(deploymentId, {
      completed: false,
      success: false,
      error: null,
      progress: []
    });
    
    // Start deployment asynchronously
    const deploymentService = new DeploymentService(workspaceId, workspaceToken, dynamoService);
    
    deploymentService.deployTenant(configId, accountName.trim(), (progress) => {
      const deployment = deploymentProgress.get(deploymentId);
      if (deployment) {
        deployment.progress = progress;
        deploymentProgress.set(deploymentId, deployment);
      }
    }).then((result) => {
      // Mark deployment as completed
      deploymentProgress.set(deploymentId, {
        completed: true,
        success: result.success,
        error: result.error,
        progress: result.progress
      });
      
      // Clean up after 10 minutes
      setTimeout(() => {
        deploymentProgress.delete(deploymentId);
      }, 10 * 60 * 1000);
    }).catch((error) => {
      deploymentProgress.set(deploymentId, {
        completed: true,
        success: false,
        error: error.message,
        progress: []
      });
    });
    
    return c.json({ success: true, deploymentId });
  } catch (error: any) {
    return c.json({ success: false, error: error.message });
  }
});

app.get("/api/deploy-tenant/progress/:deploymentId", async (c: any) => {
  try {
    const deploymentId = c.req.param('deploymentId');
    const deployment = deploymentProgress.get(deploymentId);
    
    if (!deployment) {
      return c.json({ success: false, error: "Deployment not found" });
    }
    
    return c.json({
      success: true,
      completed: deployment.completed,
      deploymentSuccess: deployment.success,
      error: deployment.error,
      progress: deployment.progress
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message });
  }
});

app.get("/api/dynamodb-data", async (c) => {
  try {
    const configs = await dynamoService.getAllConfigs();
    return c.json({ success: true, data: configs });
  } catch (error) {
    return c.json({ success: false, error: error.message });
  }
});

app.get("/api/sensitive-data", async (c: any) => {
  try {
    const sensitiveData = await dynamoService.getAllSensitiveData();
    return c.json({ success: true, data: sensitiveData });
  } catch (error: any) {
    return c.json({ success: false, error: error.message });
  }
});

app.get("/api/tenant-deployments", async (c: any) => {
  try {
    const deployments = await dynamoService.getAllTenantDeployments();
    return c.json({ success: true, data: deployments });
  } catch (error: any) {
    return c.json({ success: false, error: error.message });
  }
});

app.get("/api/tenant-deployments/:deploymentId", async (c: any) => {
  try {
    const deploymentId = c.req.param('deploymentId');
    const deployment = await dynamoService.getTenantDeployment(deploymentId);
    if (!deployment) {
      return c.json({ success: false, error: "Deployment not found" });
    }
    return c.json({ success: true, data: deployment });
  } catch (error: any) {
    return c.json({ success: false, error: error.message });
  }
});

app.post("/api/prune-database", async (c: any) => {
  try {
    const result = await dynamoService.pruneDatabase();
    return c.json({ success: result.success, error: result.error });
  } catch (error: any) {
    return c.json({ success: false, error: error.message });
  }
});

const port = parseInt(Deno.env.get("PORT") || "8080");
console.log(`🚀 Pluto App running on http://localhost:${port}`);

serve(app.fetch, { port });