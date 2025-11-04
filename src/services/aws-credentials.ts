import { fromEnv, fromContainerMetadata, fromInstanceMetadata } from "@aws-sdk/credential-providers";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region?: string;
}

export interface CredentialsTestResult {
  success: boolean;
  error?: string;
  identity?: any;
}

export class AwsCredentialsService {
  private credentials: AwsCredentials | null = null;

  async getCredentials(): Promise<AwsCredentials> {
    if (this.credentials) {
      return this.credentials;
    }

    const accessKeyId = Deno.env.get("AWS_ACCESS_KEY_ID");
    const secretAccessKey = Deno.env.get("AWS_SECRET_ACCESS_KEY");
    
    if (accessKeyId && secretAccessKey) {
      return {
        accessKeyId,
        secretAccessKey,
        sessionToken: Deno.env.get("AWS_SESSION_TOKEN"),
        region: Deno.env.get("AWS_REGION") || "us-east-1"
      };
    }

    try {
      const envCredentials = await fromEnv()();
      return {
        accessKeyId: envCredentials.accessKeyId,
        secretAccessKey: envCredentials.secretAccessKey,
        sessionToken: envCredentials.sessionToken,
        region: Deno.env.get("AWS_REGION") || "us-east-1"
      };
    } catch {
      try {
        const containerCredentials = await fromContainerMetadata()();
        return {
          accessKeyId: containerCredentials.accessKeyId,
          secretAccessKey: containerCredentials.secretAccessKey,
          sessionToken: containerCredentials.sessionToken,
          region: Deno.env.get("AWS_REGION") || "us-east-1"
        };
      } catch {
        try {
          const instanceCredentials = await fromInstanceMetadata()();
          return {
            accessKeyId: instanceCredentials.accessKeyId,
            secretAccessKey: instanceCredentials.secretAccessKey,
            sessionToken: instanceCredentials.sessionToken,
            region: Deno.env.get("AWS_REGION") || "us-east-1"
          };
        } catch (error) {
          throw new Error(`Failed to obtain AWS credentials: ${error.message}. For local development, set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.`);
        }
      }
    }
  }

  setCredentials(creds: AwsCredentials) {
    this.credentials = creds;
  }

  async testCredentials(creds: AwsCredentials): Promise<CredentialsTestResult> {
    try {
      const { STSClient, GetCallerIdentityCommand } = await import("npm:@aws-sdk/client-sts@^3.450.0");
      
      const stsClient = new STSClient({
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken
        },
        region: creds.region || "us-east-1"
      });

      const command = new GetCallerIdentityCommand({});
      const response = await stsClient.send(command);

      this.setCredentials(creds);

      return {
        success: true,
        identity: response
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  getRegion(): string {
    return this.credentials?.region || Deno.env.get("AWS_REGION") || "us-east-1";
  }
}