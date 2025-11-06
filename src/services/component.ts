import { ComponentResult, CreateComponentOptions, ServiceResult } from "./types.ts";

export class ComponentService {
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

  async createComponent(
    changeSetId: string, 
    schemaName: string, 
    name: string, 
    options: CreateComponentOptions = {}
  ): Promise<ComponentResult> {
    try {
      const requestBody: any = {
        schemaName,
        name,
        ...options
      };
      
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

  async getComponent(changeSetId: string, componentId: string, waitForToken = false, timeoutMs = 60000): Promise<ServiceResult> {
    try {
      const startTime = Date.now();
      
      while (true) {
        const url = `${this.apiUrl}/v1/w/${this.workspaceId}/change-sets/${changeSetId}/components/${componentId}`;
        console.log(`🌐 Making GET request to: ${url}`);
        console.log(`🔑 Headers:`, JSON.stringify(this.headers, null, 2));
        
        const response = await fetch(url, {
          method: 'GET',
          headers: this.headers
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`❌ HTTP ${response.status} error:`, errorText);
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const data = await response.json();
        console.log(`📡 Raw API response:`, JSON.stringify(data, null, 2));
        
        if (!waitForToken) {
          return { success: true, data };
        }
        
        // Check if initialApiToken is available in resourceProps
        const tokenProp = data.component?.resourceProps?.find((prop: any) => 
          prop.path === "root/resource_value/initialApiToken/token"
        );
        
        console.log(`🔍 Token prop found:`, tokenProp ? 'YES' : 'NO');
        if (tokenProp) {
          console.log(`🔍 Token prop structure:`, JSON.stringify(tokenProp, null, 2));
        }
        
        // Also check in attributes for comparison
        const attributeToken = data.component?.attributes?.['/resource_value/initialApiToken/token'];
        console.log(`🔍 Attribute token:`, attributeToken ? 'FOUND' : 'NOT FOUND');
        
        // Also check resource payload
        const resourcePayload = data.component?.attributes?.['/resource/payload'];
        console.log(`🔍 Resource payload token:`, resourcePayload?.initialApiToken?.token ? 'FOUND' : 'NOT FOUND');
        
        if (tokenProp?.value || attributeToken || resourcePayload?.initialApiToken?.token) {
          console.log(`✅ Token found! Returning component data.`);
          return { success: true, data };
        }
        
        // Check timeout
        const elapsed = Date.now() - startTime;
        if (elapsed >= timeoutMs) {
          console.warn(`⚠️ Timeout waiting for initialApiToken after ${elapsed}ms`);
          console.warn(`⚠️ Final component state:`, JSON.stringify(data.component, null, 2));
          return { success: true, data }; // Return anyway, caller can handle missing token
        }
        
        console.log(`⏳ initialApiToken not ready yet, polling again in 5s... (${((timeoutMs - elapsed) / 1000).toFixed(1)}s remaining)`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    } catch (error: any) {
      console.error(`❌ getComponent error:`, error);
      return { success: false, error: error.message };
    }
  }

  async disableComponentActions(changeSetId: string, componentId: string, actionNames: string[]): Promise<ServiceResult> {
    try {
      // Get all actions for the component first
      const actionsResponse = await fetch(`${this.apiUrl}/v1/w/${this.workspaceId}/change-sets/${changeSetId}/actions`, {
        method: 'GET',
        headers: this.headers
      });
      
      if (!actionsResponse.ok) {
        const errorText = await actionsResponse.text();
        throw new Error(`Failed to get actions: ${errorText}`);
      }
      
      const actionsData = await actionsResponse.json();
      const actions = actionsData.actions || [];
      
      // Find actions that match the component and action names
      const targetActions = actions.filter((action: any) => 
        action.componentId === componentId && actionNames.includes(action.kind)
      );
      
      if (targetActions.length === 0) {
        console.log(`🔒 No ${actionNames.join(', ')} actions found for component ${componentId}`);
        return { success: true };
      }
      
      console.log(`🔒 Attempting to put ${targetActions.length} actions on hold for component ${componentId}`);
      targetActions.forEach((action: any, index: number) => {
        console.log(`  Target Action ${index + 1}: ${action.kind} | ID: ${action.id} | Component: ${action.componentId}`);
      });
      
      // Put each action on hold
      for (const action of targetActions) {
        const holdResponse = await fetch(`${this.apiUrl}/v1/w/${this.workspaceId}/change-sets/${changeSetId}/actions/${action.id}/put_on_hold`, {
          method: 'POST',
          headers: this.headers
        });
        
        if (!holdResponse.ok) {
          const errorText = await holdResponse.text();
          console.warn(`Warning: Could not put action ${action.id} on hold: ${errorText}`);
          continue;
        }
        
        console.log(`Successfully put ${action.kind} action on hold for component ${componentId}`);
      }
      
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}