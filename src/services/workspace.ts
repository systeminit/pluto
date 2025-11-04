import { DynamoDBService } from "./dynamodb.ts";

export interface WorkspaceApiResponse {
  success: boolean;
  data?: any;
  error?: string;
}

export interface TenantDeploymentResult {
  success: boolean;
  error?: string;
  tenantId?: string;
}

export class WorkspaceService {
  private dynamoService = new DynamoDBService();

  async deployTenant(configId?: string): Promise<TenantDeploymentResult> {
    try {
      let config;
      if (configId) {
        config = await this.dynamoService.getConfigById(configId);
      } else {
        config = await this.dynamoService.getConfig();
      }
      
      if (!config) {
        return { success: false, error: "No configuration found. Please save configuration first." };
      }

      if (!config.workspace.rootOu) {
        return { success: false, error: "Root OU not configured" };
      }

      if (!config.workspace.emails || config.workspace.emails.length === 0) {
        return { success: false, error: "No email addresses configured for sharing" };
      }

      const workspaceId = Deno.env.get("SI_WORKSPACE_ID");
      if (!workspaceId) {
        return { success: false, error: "SI_WORKSPACE_ID environment variable not set" };
      }

      const workspaceToken = await this.dynamoService.getWorkspaceToken(workspaceId);
      if (!workspaceToken) {
        return { success: false, error: "Workspace API token not found. Please save configuration first." };
      }

      console.log("Deploying tenant with configuration:", {
        rootOu: config.workspace.rootOu,
        emails: config.workspace.emails,
        workspaceId
      });

      const tenantData = {
        rootOu: config.workspace.rootOu,
        emails: config.workspace.emails,
        workspaceId,
        deploymentTimestamp: new Date().toISOString()
      };

      const result = await this.callWorkspaceApi("/api/tenants/deploy", "POST", tenantData, workspaceToken);

      if (result.success) {
        return {
          success: true,
          tenantId: result.data?.tenantId || `tenant-${Date.now()}`
        };
      } else {
        return {
          success: false,
          error: result.error || "Unknown deployment error"
        };
      }

    } catch (error) {
      console.error("Error deploying tenant:", error);
      return { success: false, error: error.message };
    }
  }

  async testWorkspaceConnection(token: string): Promise<WorkspaceApiResponse> {
    try {
      return await this.callWorkspaceApi("/api/health", "GET", null, token);
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async listTenants(token: string): Promise<WorkspaceApiResponse> {
    try {
      return await this.callWorkspaceApi("/api/tenants", "GET", null, token);
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async shareTenantWorkspace(tenantId: string, emails: string[], token: string): Promise<WorkspaceApiResponse> {
    try {
      const payload = {
        tenantId,
        emails,
        permissions: ["read", "write"]
      };
      
      return await this.callWorkspaceApi(`/api/tenants/${tenantId}/share`, "POST", payload, token);
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  private async callWorkspaceApi(endpoint: string, method: string, data: any, token: string): Promise<WorkspaceApiResponse> {
    try {
      const workspaceBaseUrl = Deno.env.get("WORKSPACE_API_BASE_URL") || "https://api.workspace.example.com";
      const url = `${workspaceBaseUrl}${endpoint}`;

      const headers: Record<string, string> = {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "PlutoApp/1.0"
      };

      const requestOptions: RequestInit = {
        method,
        headers
      };

      if (data && (method === "POST" || method === "PUT" || method === "PATCH")) {
        requestOptions.body = JSON.stringify(data);
      }

      console.log(`Making ${method} request to ${url}`);

      const response = await fetch(url, requestOptions);

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `API request failed: ${response.status} ${response.statusText} - ${errorText}`
        };
      }

      let responseData;
      const contentType = response.headers.get("content-type");
      
      if (contentType && contentType.includes("application/json")) {
        responseData = await response.json();
      } else {
        responseData = await response.text();
      }

      return {
        success: true,
        data: responseData
      };

    } catch (error) {
      console.error("Workspace API call failed:", error);
      
      if (error.name === "TypeError" && error.message.includes("fetch")) {
        return {
          success: false,
          error: "Network error: Could not connect to Workspace API. Please check the API endpoint and your internet connection."
        };
      }

      return {
        success: false,
        error: `API call failed: ${error.message}`
      };
    }
  }

  async getOrganizationalUnits(rootOu: string, token: string): Promise<WorkspaceApiResponse> {
    try {
      return await this.callWorkspaceApi(`/api/orgs/ous?parent=${rootOu}`, "GET", null, token);
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async validateRootOu(rootOu: string, token: string): Promise<boolean> {
    try {
      const result = await this.callWorkspaceApi(`/api/orgs/ous/${rootOu}`, "GET", null, token);
      return result.success;
    } catch (error) {
      console.error("Error validating root OU:", error);
      return false;
    }
  }
}