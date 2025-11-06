import { DeploymentProgress, DeploymentResult } from "./types.ts";

// Re-export types for backward compatibility
export type { DeploymentProgress, DeploymentResult } from "./types.ts";
import { DynamoDBService } from "./dynamodb.ts";
import { ChangeSetService } from "./changeset.ts";
import { ComponentService } from "./component.ts";

export class DeploymentService {
  private workspaceId: string;
  private dynamoService: DynamoDBService;
  private changeSetService: ChangeSetService;
  private componentService: ComponentService;
  
  constructor(workspaceId: string, apiToken: string, dynamoService?: DynamoDBService) {
    this.workspaceId = workspaceId;
    this.dynamoService = dynamoService || new DynamoDBService();
    
    // Initialize the specialized services
    this.changeSetService = new ChangeSetService(workspaceId, apiToken);
    this.componentService = new ComponentService(workspaceId, apiToken);
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
      const createResult = await this.changeSetService.createChangeSet(changeSetName);
      if (!createResult.success) {
        await updateProgress('changeset', 'failed', `Failed to create change set: ${createResult.error}`);
        return { success: false, error: createResult.error, progress };
      }
      changeSetId = createResult.changeSetId!;
      await updateProgress('changeset', 'completed', `Change set created: ${changeSetId}`);

      // Step 3: Create AWS Organizations Account component
      await updateProgress('component', 'in_progress', 'Creating AWS Organizations Account component...');
      const componentResult = await this.componentService.createComponent(changeSetId, 'AWS::Organizations::Account', `${accountName}`, {
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

      // Step 4: Create Workspace Management component (before applying changeset)
      await updateProgress('workspace', 'in_progress', 'Creating Workspace Management component...');
      const workspaceResult = await this.componentService.createComponent(changeSetId, 'Workspace Management', `${accountName}-workspace`, {
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

      // Step 5: Disable Create action for AWS Account component (after both components created)
      await updateProgress('disable-actions', 'in_progress', 'Disabling Create action for AWS Account component...');
      const disableResult = await this.componentService.disableComponentActions(changeSetId, componentResult.componentId!, ['Create']);
      if (!disableResult.success) {
        console.warn(`Warning: Could not disable Create action: ${disableResult.error}`);
        await updateProgress('disable-actions', 'completed', 'Create action disable attempted (with warnings)');
      } else {
        await updateProgress('disable-actions', 'completed', 'Create action disabled for AWS Account component');
      }

      // Step 6: Apply changeset with workspace monitoring (AWS Account CREATE on hold, Workspace CREATE will run)
      await updateProgress('apply', 'in_progress', 'Applying changeset with both components (AWS Account on hold, Workspace active)...');
      const applyResult = await this.changeSetService.applyChangeSet(changeSetId, 120, workspaceResult.componentId);
      if (!applyResult.success) {
        await updateProgress('apply', 'failed', `Failed to apply changeset: ${applyResult.error}`);
        return { success: false, error: applyResult.error, changeSetId, progress };
      }
      await updateProgress('apply', 'completed', 'Changeset applied successfully with workspace monitoring');

      // Step 7: Extract and store API token if available
      if (applyResult.data?.workspaceAction?.payload) {
        await updateProgress('token-extraction', 'in_progress', 'Extracting and storing API token...');
        const payload = applyResult.data.workspaceAction.payload;
        const initialApiToken = payload.initialApiToken;

        if (initialApiToken && payload.id) {
          // Store token, workspace ID, and externalId in sensitive DynamoDB table
          const tokenValue = initialApiToken.token || initialApiToken;
          const externalId = payload.externalId;
          const storeResult = await this.dynamoService.saveWorkspaceToken(payload.id, tokenValue, externalId);
          if (storeResult.success) {
            await updateProgress('token-extraction', 'completed', `API token extracted and stored for workspace ${payload.id}`);
            console.log(`✅ Workspace API token stored for workspace: ${payload.id}`);
            console.log(`External ID: ${externalId || 'Not available'}`);
            console.log(`Token expires at: ${initialApiToken.expiresAt || 'No expiration'}`);
          } else {
            await updateProgress('token-extraction', 'failed', `Failed to store API token: ${storeResult.error}`);
            console.warn(`Warning: Could not store API token: ${storeResult.error}`);
          }
        } else {
          await updateProgress('token-extraction', 'completed', 'No initialApiToken available in workspace component');
          console.warn('Warning: No initialApiToken found in workspace component');
        }
      } else if (applyResult.data?.warning) {
        await updateProgress('token-extraction', 'completed', `Workspace created with warning: ${applyResult.data.warning}`);
        console.warn(`Warning: ${applyResult.data.warning}`);
      } else {
        await updateProgress('token-extraction', 'completed', 'Workspace component processing completed');
      }

      // Success - changeset created and applied
      await updateProgress('complete', 'completed', 'Tenant deployment completed successfully');
      return { success: true, changeSetId, progress, deploymentId };

    } catch (error: any) {
      await updateProgress('error', 'failed', `Unexpected error: ${error.message}`);
      return { success: false, error: error.message, changeSetId, progress, deploymentId };
    }
  }
}