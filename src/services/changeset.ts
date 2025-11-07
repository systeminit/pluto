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

  async applyChangeSet(changeSetId: string, timeoutSeconds: number = 120, componentIds?: string[]): Promise<ServiceResult> {
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
            console.log(`⏳ DVU Roots still present. Retrying in 5s... (${remaining.toFixed(1)}s remaining)`);
            
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
            console.log(`⏳ ${runningActions.length} component actions still running, polling again in 2s... (${pollRemaining.toFixed(1)}s remaining)`);
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
}