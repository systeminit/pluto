import { ActionResult } from "./types.ts";

export class WorkspaceMonitorService {
  private apiUrl = "https://api.systeminit.com";
  private workspaceId: string;
  private headers: Record<string, string>;

  constructor(workspaceId: string, apiToken: string) {
    this.workspaceId = workspaceId;
    this.headers = {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    };
  }

  async waitForWorkspaceCreateAction(
    changeSetId: string,
    workspaceComponentId: string,
    timeoutSeconds: number = 120,
    pollInterval: number = 2
  ): Promise<ActionResult> {
    const startTime = Date.now();
    
    console.log(`🏢 Starting to wait for workspace component ${workspaceComponentId} action to complete`);
    
    while (Date.now() - startTime < timeoutSeconds * 1000) {
      try {
        // Check merge status to see current actions and changeset status
        console.log(`🔍 Checking changeset merge status for workspace component action...`);
        const mergeStatusResponse = await fetch(`${this.apiUrl}/v1/w/${this.workspaceId}/change-sets/${changeSetId}/merge_status`, {
          method: 'GET',
          headers: this.headers
        });
        
        if (!mergeStatusResponse.ok) {
          const errorText = await mergeStatusResponse.text();
          console.log(`❌ Could not check merge status: ${mergeStatusResponse.status} - ${errorText}`);
        } else {
          const mergeStatusData = await mergeStatusResponse.json();
          console.log(`📊 Changeset status: ${mergeStatusData.changeSet?.status}`);
          console.log(`📋 Found ${mergeStatusData.actions?.length || 0} actions in changeset`);
          
          // Check if there's still an action for our workspace component
          const workspaceAction = mergeStatusData.actions?.find((action: any) => 
            action.component?.id === workspaceComponentId
          );
          
          if (workspaceAction) {
            console.log(`⏳ Workspace action still present: ${workspaceAction.kind} | State: ${workspaceAction.state} | ID: ${workspaceAction.id}`);
          } else {
            console.log(`✅ Workspace component action no longer in merge status - action completed!`);
            
            // Action completed, now poll for the initialApiToken to appear in component resource
            console.log(`🔍 Polling for initialApiToken in workspace component resource (up to 30s)...`);
            
            const tokenPollStart = Date.now();
            const tokenTimeout = 30000; // 30 seconds
            let lastComponentData: any = null;
            
            while (Date.now() - tokenPollStart < tokenTimeout) {
              const componentResponse = await fetch(`${this.apiUrl}/v1/w/${this.workspaceId}/change-sets/${changeSetId}/components/${workspaceComponentId}`, {
                method: 'GET',
                headers: this.headers
              });
              
              if (!componentResponse.ok) {
                const errorText = await componentResponse.text();
                console.log(`❌ Could not fetch workspace component: ${componentResponse.status} - ${errorText}`);
                return { success: false, error: `Could not fetch workspace component: ${errorText}` };
              }
              
              const componentData = await componentResponse.json();
              lastComponentData = componentData; // Store for timeout logging
              const component = componentData.component;
              
              // Check in component.attributes["/resource/payload"] which is where the API response shows it
              const resourcePayload = component?.attributes?.['/resource/payload'];
              if (resourcePayload && resourcePayload.initialApiToken && resourcePayload.initialApiToken.token) {
                console.log(`✅ Found initialApiToken in component resource payload!`);
                console.log(`🎯 Token expires at: ${resourcePayload.initialApiToken.expiresAt || 'No expiration'}`);
                console.log(`🆔 Workspace ID: ${resourcePayload.id}`);
                console.log(`📝 Display Name: ${resourcePayload.displayName}`);
                
                return { 
                  success: true, 
                  actionResult: { 
                    payload: resourcePayload 
                  } 
                };
              }
              
              // Also check if there's a resource object directly (fallback)
              const resource = component?.resource;
              if (resource && resource.initialApiToken && resource.initialApiToken.token) {
                console.log(`✅ Found initialApiToken in component resource!`);
                console.log(`🎯 Token expires at: ${resource.initialApiToken.expiresAt || 'No expiration'}`);
                console.log(`🆔 Workspace ID: ${resource.id}`);
                console.log(`📝 Display Name: ${resource.displayName}`);
                
                return { 
                  success: true, 
                  actionResult: { 
                    payload: resource 
                  } 
                };
              }
              
              // Check resourceProps as well
              if (component && component.resourceProps) {
                const tokenProp = component.resourceProps.find((prop: any) => 
                  prop.path === '/resource/initialApiToken' || prop.path === 'initialApiToken'
                );
                
                if (tokenProp) {
                  console.log(`✅ Found initialApiToken in resource props!`);
                  return { 
                    success: true, 
                    actionResult: { 
                      payload: JSON.parse(tokenProp.value)
                    } 
                  };
                }
              }
              
              // Token not found yet, wait before next poll
              const elapsed = (Date.now() - tokenPollStart) / 1000;
              const remaining = (tokenTimeout - (Date.now() - tokenPollStart)) / 1000;
              console.log(`⏳ initialApiToken not ready yet, polling again in 1s... (${remaining.toFixed(1)}s remaining)`);
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            // Timeout reached without finding token
            console.log(`❌ Timeout waiting for initialApiToken to appear in workspace component resource`);
            if (lastComponentData) {
              console.log(`🔍 Final component data:`, JSON.stringify(lastComponentData, null, 2));
            }
            
            return { success: false, error: 'Workspace component created but initialApiToken not found after 30s polling' };
          }
        }
        
        // Wait before polling again
        const elapsed = (Date.now() - startTime) / 1000;
        const remaining = timeoutSeconds - elapsed;
        console.log(`⏳ Waiting for workspace action to complete... (${remaining.toFixed(1)}s remaining)`);
        await new Promise(resolve => setTimeout(resolve, pollInterval * 1000));
        
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: `Workspace action timeout: Action not completed after ${timeoutSeconds}s` };
  }
}