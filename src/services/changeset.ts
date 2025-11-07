import { ChangeSetResult, ServiceResult } from "./types.ts";
import { Configuration, ChangeSetsApi } from "@systeminit/api-client";
import { ComponentService } from "./component.ts";

// Type definitions based on the actual API responses
interface ComponentResource {
  attributes?: Record<string, any>;
  resourceProps?: Array<{
    id: string;
    propId: string;
    value: any;
    path: string;
  }>;
}

interface ComponentResponse {
  component: ComponentResource;
}

export class ChangeSetService {
  private changeSetsApi: ChangeSetsApi;
  private componentService: ComponentService;
  private workspaceId: string;

  private hasValidToken(payload: any): payload is { initialApiToken: { token: string; expiresAt?: string }; id: string } {
    return payload && 
           payload.initialApiToken && 
           payload.initialApiToken.token && 
           typeof payload.initialApiToken.token === 'string' &&
           payload.id;
  }

  private extractTokenFromResourceProps(resourceProps: Array<{ id: string; propId: string; value: any; path: string }>): 
    { token: { token: string; expiresAt?: string }; workspaceId: string } | null {
    
    const tokenProp = resourceProps.find(prop => prop.path === 'root/resource_value/initialApiToken');
    const idProp = resourceProps.find(prop => prop.path === 'root/resource_value/id');
    
    console.log(`🔍 Token prop found:`, tokenProp ? 'YES' : 'NO');
    if (tokenProp) {
      console.log(`🔍 Token prop value structure:`, JSON.stringify(tokenProp.value, null, 2));
    }
    
    if (tokenProp && tokenProp.value && tokenProp.value.token && idProp?.value) {
      return {
        token: tokenProp.value,
        workspaceId: idProp.value
      };
    }
    
    return null;
  }

  constructor(workspaceId: string, apiToken: string) {
    this.workspaceId = workspaceId;
    
    const config = new Configuration({
      basePath: "https://api.systeminit.com",
      accessToken: apiToken,
      baseOptions: {
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        }
      }
    });
    
    this.changeSetsApi = new ChangeSetsApi(config);
    this.componentService = new ComponentService(workspaceId, apiToken);
  }

  async createChangeSet(name: string): Promise<ChangeSetResult> {
    try {
      const response = await this.changeSetsApi.createChangeSet({
        workspaceId: this.workspaceId,
        createChangeSetV1Request: {
          changeSetName: name
        }
      });

      console.log("🔍 CreateChangeSet Response:", JSON.stringify(response.data, null, 2));
      
      // Check different possible response structures
      if (response.data?.changeSet?.id) {
        return { success: true, changeSetId: response.data.changeSet.id };
      } else if (response.data?.id) {
        return { success: true, changeSetId: response.data.id };
      } else {
        console.warn("⚠️ Unexpected response structure - no changeSet ID found");
        return { success: false, error: "No changeSet ID in response" };
      }
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async applyChangeSet(changeSetId: string, timeoutSeconds: number = 120, componentIds?: string[], progressCallback?: (message: string) => void): Promise<ServiceResult> {
    try {
      console.log(`🚀 Applying changeset with 5-second retry pattern for DVU errors (timeout: ${timeoutSeconds}s)`);
      
      const startTime = Date.now();
      
      // Apply changeset with DVU retry logic
      while (Date.now() - startTime < timeoutSeconds * 1000) {
        try {
          await this.changeSetsApi.forceApply({
            workspaceId: this.workspaceId,
            changeSetId: changeSetId
          });
          console.log(`✅ Change set applied successfully`);
          break;
        } catch (error: any) {
          if (error.status === 428) {
            const elapsed = (Date.now() - startTime) / 1000;
            const remaining = timeoutSeconds - elapsed;
            const message = `DVU Roots still present. Retrying in 5s... (${remaining.toFixed(1)}s remaining)`;
            console.log(`⏳ ${message}`);
            progressCallback?.(message);
            
            if (remaining <= 5) {
              break; // Don't wait if we're close to timeout
            }
            
            await new Promise(resolve => setTimeout(resolve, 5000));
            continue;
          }
          
          // Handle other errors
          throw error;
        }
      }
      
      // If component monitoring is requested, poll for all actions to complete
      if (componentIds && componentIds.length > 0) {
        console.log(`🏢 Polling merge status for component actions completion: ${componentIds.join(', ')}`);
        
        const pollStartTime = Date.now();
        const pollTimeout = 60000; // 60 seconds for action polling
        
        while (Date.now() - pollStartTime < pollTimeout) {
          try {
            // Check merge status to see if any monitored component actions still exist
            const mergeResponse = await this.changeSetsApi.mergeStatus({
              workspaceId: this.workspaceId,
              changeSetId: changeSetId
            });
            const mergeData = mergeResponse.data;
            
            // Check if any of our monitored components still have actions running
            const runningActions = mergeData.actions?.filter((action: any) => 
              componentIds.includes(action.component?.id)
            ) || [];
            
            if (runningActions.length === 0) {
              console.log(`✅ All monitored component actions completed - no longer in merge status`);
              return { success: true };
            }
            
            // Some actions still running, continue polling
            const pollRemaining = (pollTimeout - (Date.now() - pollStartTime)) / 1000;
            const message = `${runningActions.length} component actions still running, polling again in 2s... (${pollRemaining.toFixed(1)}s remaining)`;
            console.log(`⏳ ${message}`);
            progressCallback?.(message);
            runningActions.forEach((action: any) => {
              console.log(`  - ${action.kind} action for component ${action.component?.id}`);
            });
            
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (error: any) {
            console.warn(`Warning: Error during merge status polling: ${error.message}`);
            break;
          }
        }
        
        console.log(`⚠️ Component action polling timeout after 60s - some actions may still be processing`);
      }
      
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async getMergeStatus(changeSetId: string): Promise<ServiceResult> {
    try {
      const response = await this.changeSetsApi.mergeStatus({
        workspaceId: this.workspaceId,
        changeSetId: changeSetId
      });
      return { success: true, data: response.data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async seedTenantWorkspace(tenantWorkspaceId: string, tenantApiToken: string, awsAccountId: string): Promise<ServiceResult> {
    try {
      console.log(`🌱 Seeding tenant workspace ${tenantWorkspaceId} with AWS credentials...`);
      
      // Create a new changeset service for the tenant workspace
      const tenantChangeSetService = new ChangeSetService(tenantWorkspaceId, tenantApiToken);
      
      // 1. Create a changeset in the tenant workspace
      console.log('1. Creating changeset in tenant workspace...');
      const changeSetResult = await tenantChangeSetService.createChangeSet('initial-aws-setup');
      if (!changeSetResult.success) {
        throw new Error(`Failed to create changeset: ${changeSetResult.error}`);
      }
      const changeSetId = changeSetResult.changeSetId!;
      console.log(`✅ Created changeset: ${changeSetId}`);

      // 2. Create AWS Credential component
      console.log('2. Creating AWS Credential component...');
      const credentialResult = await this.createTenantComponent(tenantWorkspaceId, tenantApiToken, changeSetId, 'AWS Credential', 'tenant-aws-credential');
      if (!credentialResult.success) {
        throw new Error(`Failed to create AWS Credential: ${credentialResult.error}`);
      }
      const credentialComponentId = credentialResult.componentId!;
      console.log(`✅ Created AWS Credential component: ${credentialComponentId}`);

      // 3. Create Region component
      console.log('3. Creating Region component...');
      const regionResult = await this.createTenantComponent(tenantWorkspaceId, tenantApiToken, changeSetId, 'Region', 'tenant-aws-region');
      if (!regionResult.success) {
        throw new Error(`Failed to create Region: ${regionResult.error}`);
      }
      const regionComponentId = regionResult.componentId!;
      console.log(`✅ Created Region component: ${regionComponentId}`);

      // 4. Create AWS Credential secret
      console.log('4. Creating AWS Credential secret...');
      const secretResult = await this.createTenantSecret(tenantWorkspaceId, tenantApiToken, changeSetId, 'tenant-aws-credential', 'AWS Credential', {
        AssumeRole: `arn:aws:iam::${awsAccountId}:role/si-access-prod-manager`
      });
      if (!secretResult.success) {
        throw new Error(`Failed to create secret: ${secretResult.error}`);
      }
      console.log(`✅ Created AWS Credential secret`);

      // 5. Update AWS Credential component with secret
      console.log('5. Updating AWS Credential component with secret...');
      const updateCredentialResult = await this.updateTenantComponent(tenantWorkspaceId, tenantApiToken, changeSetId, credentialComponentId, {
        secrets: {
          'AWS Credential': 'tenant-aws-credential'
        }
      });
      if (!updateCredentialResult.success) {
        throw new Error(`Failed to update AWS Credential: ${updateCredentialResult.error}`);
      }
      console.log(`✅ Updated AWS Credential component with secret`);

      // 6. Update Region component with region us-east-1
      console.log('6. Updating Region component...');
      const updateRegionResult = await this.updateTenantComponent(tenantWorkspaceId, tenantApiToken, changeSetId, regionComponentId, {
        properties: {
          'region': 'us-east-1'
        }
      });
      if (!updateRegionResult.success) {
        throw new Error(`Failed to update Region: ${updateRegionResult.error}`);
      }
      console.log(`✅ Updated Region component with region: us-east-1`);

      // 7. Apply the changeset
      console.log('7. Applying changeset in tenant workspace...');
      const applyResult = await tenantChangeSetService.applyChangeSet(changeSetId, 120);
      if (!applyResult.success) {
        throw new Error(`Failed to apply changeset: ${applyResult.error}`);
      }
      console.log(`✅ Successfully applied changeset in tenant workspace`);

      console.log(`🎉 Successfully seeded tenant workspace ${tenantWorkspaceId} with AWS credentials for account ${awsAccountId}`);
      
      return { 
        success: true, 
        data: { 
          changeSetId,
          credentialComponentId,
          regionComponentId,
          awsAccountId,
          awsRegion: 'us-east-1'
        } 
      };

    } catch (error: any) {
      console.error(`❌ Failed to seed tenant workspace:`, error);
      return { success: false, error: error.message };
    }
  }

  private async createTenantComponent(workspaceId: string, apiToken: string, changeSetId: string, schemaName: string, name: string, options: any = {}): Promise<{ success: boolean; componentId?: string; error?: string }> {
    try {
      const response = await fetch(`https://api.systeminit.com/v1/w/${workspaceId}/change-sets/${changeSetId}/components`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          schemaName,
          name,
          ...options
        })
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

  private async createTenantSecret(workspaceId: string, apiToken: string, changeSetId: string, name: string, definitionName: string, rawData: any): Promise<ServiceResult> {
    try {
      const response = await fetch(`https://api.systeminit.com/v1/w/${workspaceId}/change-sets/${changeSetId}/secrets`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name,
          definitionName,
          description: `Secret for ${name}`,
          rawData
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      return { success: true, data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  private async updateTenantComponent(workspaceId: string, apiToken: string, changeSetId: string, componentId: string, options: any): Promise<ServiceResult> {
    try {
      const response = await fetch(`https://api.systeminit.com/v1/w/${workspaceId}/change-sets/${changeSetId}/components/${componentId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(options)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      return { success: true, data };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}