export interface DeploymentProgress {
  step: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  message: string;
  timestamp: string;
  details?: any;
}

export interface DeploymentResult {
  success: boolean;
  error?: string;
  changeSetId?: string;
  deploymentId?: string;
  progress: DeploymentProgress[];
}

import { DynamoDBService } from "./dynamodb.ts";

export class DeploymentService {
  private apiUrl = "https://api.systeminit.com";
  private workspaceId: string;
  private apiToken: string;
  private dynamoService: DynamoDBService;
  
  constructor(workspaceId: string, apiToken: string, dynamoService?: DynamoDBService) {
    this.workspaceId = workspaceId;
    this.apiToken = apiToken;
    this.dynamoService = dynamoService || new DynamoDBService();
  }

  private get headers() {
    return {
      'Authorization': `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json'
    };
  }

  private createProgressUpdate(
    step: string, 
    status: DeploymentProgress['status'], 
    message: string, 
    details?: any
  ): DeploymentProgress {
    return {
      step,
      status,
      message,
      timestamp: new Date().toISOString(),
      details
    };
  }

  async createChangeSet(name: string): Promise<{ success: boolean; changeSetId?: string; error?: string }> {
    try {
      const requestBody = { changeSetName: name };
      console.log(`createChangeSet request body:`, JSON.stringify(requestBody));
      console.log(`API URL: ${this.apiUrl}/v1/w/${this.workspaceId}/change-sets`);
      
      const response = await fetch(`${this.apiUrl}/v1/w/${this.workspaceId}/change-sets`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      return { success: true, changeSetId: data.changeSet.id };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async forceApplyChangeSet(changeSetId: string, timeoutSeconds: number = 120): Promise<{ success: boolean; error?: string }> {
    const startTime = Date.now();
    const retryInterval = 5000; // 5 seconds

    while (Date.now() - startTime < timeoutSeconds * 1000) {
      try {
        const response = await fetch(`${this.apiUrl}/v1/w/${this.workspaceId}/change-sets/${changeSetId}/force_apply`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiToken}`,
            'accept': 'application/json'
          },
          body: ''
        });

        if (response.ok) {
          return { success: true };
        } else if (response.status === 428) {
          // PRECONDITION_REQUIRED - DVU roots still exist
          const remaining = timeoutSeconds * 1000 - (Date.now() - startTime);
          if (remaining > retryInterval) {
            await new Promise(resolve => setTimeout(resolve, retryInterval));
            continue;
          } else {
            break;
          }
        } else {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }

    return { success: false, error: 'Force apply timeout: DVU roots still processing' };
  }

  async waitForMergeSuccess(changeSetId: string, timeoutSeconds: number = 300): Promise<{ success: boolean; error?: string; details?: any }> {
    const startTime = Date.now();
    const pollInterval = 10000; // 10 seconds

    while (Date.now() - startTime < timeoutSeconds * 1000) {
      try {
        const response = await fetch(`${this.apiUrl}/v1/w/${this.workspaceId}/change-sets/${changeSetId}/merge_status`, {
          method: 'GET',
          headers: this.headers
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const mergeData = await response.json();
        const changeSet = mergeData.changeSet || {};
        const actions = mergeData.actions || [];

        if (!actions.length) {
          const status = changeSet.status;
          if (status === "Applied") {
            return { success: true, details: { message: "Change set applied with no actions" } };
          }
          // Continue waiting if not applied yet
        } else {
          const states = actions.map((action: any) => action.state);
          if (states.every((state: string) => state === "Success")) {
            return { success: true, details: { message: "All actions succeeded" } };
          }

          const failedActions = actions.filter((action: any) => action.state === "Failed");
          if (failedActions.length > 0) {
            return { 
              success: false, 
              error: `${failedActions.length} action(s) failed`,
              details: { failedActions }
            };
          }
        }

        await new Promise(resolve => setTimeout(resolve, pollInterval));
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }

    return { success: false, error: `Merge timeout after ${timeoutSeconds} seconds` };
  }

  async deleteChangeSet(changeSetId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch(`${this.apiUrl}/v1/w/${this.workspaceId}/change-sets/${changeSetId}`, {
        method: 'DELETE',
        headers: this.headers
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async createComponent(
    changeSetId: string, 
    schemaName: string, 
    name: string, 
    options?: { attributes?: any; viewName?: string }
  ): Promise<{ success: boolean; componentId?: string; error?: string }> {
    try {
      const requestBody: any = { schemaName, name };
      if (options) {
        Object.assign(requestBody, options);
      }

      const response = await fetch(`${this.apiUrl}/v1/w/${this.workspaceId}/change-sets/${changeSetId}/components`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      return { success: true, componentId: data.component.id };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async deployTenant(configId: string, accountName: string, progressCallback?: (progress: DeploymentProgress[]) => void): Promise<DeploymentResult> {
    const progress: DeploymentProgress[] = [];
    let changeSetId: string | undefined;
    const deploymentId = crypto.randomUUID();

    const updateProgress = async (step: string, status: DeploymentProgress['status'], message: string, details?: any) => {
      progress.push(this.createProgressUpdate(step, status, message, details));
      
      // Log to tenant audit table
      await this.dynamoService.updateTenantDeploymentStep(deploymentId, step, status, message, details);
      
      if (progressCallback) {
        progressCallback([...progress]);
      }
    };

    try {
      // Get config data for audit logging
      const configData = await this.dynamoService.getConfigById(configId);
      
      // Create initial tenant deployment record
      await this.dynamoService.createTenantDeployment(deploymentId, configId, configData);

      // Step 1: Generate unique changeset name
      await updateProgress('initialize', 'in_progress', 'Initializing deployment...');
      const environmentUuid = crypto.randomUUID();
      const changeSetName = `Tenant Deployment ${environmentUuid}`;
      await updateProgress('initialize', 'completed', `Generated deployment ID: ${environmentUuid}`);

      // Step 2: Create changeset
      await updateProgress('changeset', 'in_progress', 'Creating change set...');
      console.log(`Creating changeset with name: "${changeSetName}" (length: ${changeSetName.length})`);
      const createResult = await this.createChangeSet(changeSetName);
      if (!createResult.success) {
        await updateProgress('changeset', 'failed', `Failed to create change set: ${createResult.error}`);
        return { success: false, error: createResult.error, progress };
      }
      changeSetId = createResult.changeSetId!;
      await updateProgress('changeset', 'completed', `Change set created: ${changeSetId}`);

      // Step 3: Create AWS Organizations Account component
      await updateProgress('component', 'in_progress', 'Creating AWS Organizations Account component...');
      const componentResult = await this.createComponent(changeSetId, 'AWS::Organizations::Account', `${accountName}`, {
        attributes: {
          "/domain/AccountName": accountName,
          "/domain/Email": `technical-operations+${accountName}@systeminit.com`,
          "/domain/ParentIds/0": {
            "$source": {
              "component": "Root/experimental/pluto",
              "path": "/resource_value/Id"
            }
          },
          "/domain/extra/Region": {
            "$source": {
              "component": "AWS Region",
              "path": "/domain/region"
            }
          },
          "/secrets/AWS Credential": {
            "$source": {
              "component": "Org Root Account ADMIN",
              "path": "/secrets/AWS Credential"
            }
          }
        },
        viewName: "Tenants"
      });
      
      if (!componentResult.success) {
        await updateProgress('component', 'failed', `Failed to create component: ${componentResult.error}`);
        return { success: false, error: componentResult.error, changeSetId, progress };
      }
      await updateProgress('component', 'completed', `AWS Account component created: ${componentResult.componentId}`);

      // Step 4: Create Workspace Management component
      await updateProgress('workspace', 'in_progress', 'Creating Workspace Management component...');
      const workspaceResult = await this.createComponent(changeSetId, 'Workspace Management', `${accountName}-workspace`, {
        attributes: {
          "/domain/displayName": accountName,
          "/domain/description": `System Initiative workspace for ${accountName} tenant - automated deployment`,
          "/domain/instanceUrl": "https://app.systeminit.com",
          "/domain/isDefault": false,
          "/secrets/SI Credential": {
            "$source": {
              "component": "Pluto API Token",
              "path": "/secrets/SI Credential"
            }
          }
        },
        viewName: "Tenants"
      });
      
      if (!workspaceResult.success) {
        await updateProgress('workspace', 'failed', `Failed to create workspace component: ${workspaceResult.error}`);
        return { success: false, error: workspaceResult.error, changeSetId, progress };
      }
      await updateProgress('workspace', 'completed', `Workspace component created: ${workspaceResult.componentId}`);

      // Step 5: Skip apply for review (as requested)
      await updateProgress('review', 'completed', 'Change set ready for review - apply skipped as requested');

      // Success - changeset created but not applied
      await updateProgress('complete', 'completed', 'Tenant deployment prepared successfully (ready for review)');
      return { success: true, changeSetId, progress, deploymentId };

    } catch (error: any) {
      await updateProgress('error', 'failed', `Unexpected error: ${error.message}`);
      return { success: false, error: error.message, changeSetId, progress, deploymentId };
    }
  }
}