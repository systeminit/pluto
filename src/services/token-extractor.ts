// Simple token extractor that replicates the working test script approach
export interface TokenExtractionResult {
  success: boolean;
  token?: string;
  workspaceId?: string;
  expiresAt?: string;
  error?: string;
}

export class TokenExtractor {
  private workspaceApiToken: string;
  private siWorkspaceId: string;

  constructor(workspaceApiToken: string, siWorkspaceId: string) {
    this.workspaceApiToken = workspaceApiToken;
    this.siWorkspaceId = siWorkspaceId;
  }

  async extractToken(changeSetId: string, componentId: string): Promise<TokenExtractionResult> {
    try {
      const url = `https://api.systeminit.com/v1/w/${this.siWorkspaceId}/change-sets/${changeSetId}/components/${componentId}`;
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.workspaceApiToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `HTTP ${response.status}: ${errorText}`
        };
      }

      const data = await response.json();
      
      const component = data.component;
      if (!component) {
        return {
          success: false,
          error: 'No component found in response'
        };
      }

      // Extract token from resource payload (same as test script)
      const resourcePayload = component.attributes?.['/resource/payload'];
      if (resourcePayload?.initialApiToken?.token) {
        return {
          success: true,
          token: resourcePayload.initialApiToken.token,
          workspaceId: resourcePayload.id,
          expiresAt: resourcePayload.initialApiToken.expiresAt
        };
      }

      // Fallback: check resourceProps (same as test script)
      const resourceProps = component.resourceProps || [];
      
      const tokenProp = resourceProps.find((prop: any) => 
        prop.path === "root/resource_value/initialApiToken/token"
      );
      
      if (tokenProp?.value) {
        return {
          success: true,
          token: tokenProp.value,
          workspaceId: component.resourceId
        };
      }

      // No token found
      return {
        success: false,
        error: 'initialApiToken not found in component'
      };

    } catch (error: any) {
      console.error(`❌ Token Extractor - Error:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Polling version that waits for token to be available
  async extractTokenWithPolling(changeSetId: string, componentId: string, timeoutMs = 60000): Promise<TokenExtractionResult> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const result = await this.extractToken(changeSetId, componentId);
      
      if (result.success) {
        return result;
      }
      
      if (result.error && !result.error.includes('initialApiToken not found')) {
        // Real error, not just token not ready
        return result;
      }
      
      const elapsed = Date.now() - startTime;
      const remaining = (timeoutMs - elapsed) / 1000;
      
      if (remaining <= 0) {
        return {
          success: false,
          error: `Timeout waiting for initialApiToken after ${elapsed}ms`
        };
      }
      
      console.log(`⏳ Token Extractor - initialApiToken not ready yet, polling again in 5s... (${remaining.toFixed(1)}s remaining)`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    return {
      success: false,
      error: 'Timeout reached'
    };
  }
}