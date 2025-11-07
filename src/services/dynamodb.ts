import { DynamoDBClient, ListTablesCommand, CreateTableCommand, PutItemCommand, GetItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { AwsCredentialsService } from "./aws-credentials.ts";

export interface PlutoConfig {
  id: string;
  name?: string;
  workspace: {
    rootOu: string;
    emails: string[];
  };
  createdAt: string;
  updatedAt: string;
}

export interface TestResult {
  success: boolean;
  error?: string;
}

export class DynamoDBService {
  private client: DynamoDBClient | null = null;
  private tableName = "pluto-config";
  private sensitiveTableName = "pluto-sensitive";
  private tenantsTableName = "pluto-tenants";
  private credentialsService = new AwsCredentialsService();

  private async getClient(): Promise<DynamoDBClient> {
    if (!this.client) {
      const endpoint = Deno.env.get("DYNAMODB_ENDPOINT");
      
      if (endpoint) {
        // Local DynamoDB - use dummy credentials
        this.client = new DynamoDBClient({
          region: "us-east-1",
          credentials: {
            accessKeyId: "local",
            secretAccessKey: "local"
          },
          endpoint
        });
      } else {
        // Production DynamoDB - use real credentials
        const creds = await this.credentialsService.getCredentials();
        this.client = new DynamoDBClient({
          region: creds.region,
          credentials: {
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
            sessionToken: creds.sessionToken
          }
        });
      }
    }
    return this.client;
  }

  async testConnection(): Promise<TestResult> {
    try {
      const client = await this.getClient();
      const command = new ListTablesCommand({});
      await client.send(command);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async ensureTable(): Promise<void> {
    try {
      const client = await this.getClient();
      
      const listCommand = new ListTablesCommand({});
      const tables = await client.send(listCommand);
      let tablesCreated = false;
      
      // Create config table only if it doesn't exist
      if (!tables.TableNames?.includes(this.tableName)) {
        const createCommand = new CreateTableCommand({
          TableName: this.tableName,
          KeySchema: [
            {
              AttributeName: "id",
              KeyType: "HASH"
            }
          ],
          AttributeDefinitions: [
            {
              AttributeName: "id",
              AttributeType: "S"
            }
          ],
          BillingMode: "PAY_PER_REQUEST"
        });
        
        await client.send(createCommand);
        console.log(`✅ Created table: ${this.tableName}`);
        tablesCreated = true;
      } else {
        console.log(`✅ Table ${this.tableName} already exists`);
      }

      // Create sensitive data table only if it doesn't exist
      if (!tables.TableNames?.includes(this.sensitiveTableName)) {
        const createSensitiveCommand = new CreateTableCommand({
          TableName: this.sensitiveTableName,
          KeySchema: [
            {
              AttributeName: "workspaceId",
              KeyType: "HASH"
            }
          ],
          AttributeDefinitions: [
            {
              AttributeName: "workspaceId",
              AttributeType: "S"
            }
          ],
          BillingMode: "PAY_PER_REQUEST"
        });
        
        await client.send(createSensitiveCommand);
        console.log(`✅ Created table: ${this.sensitiveTableName}`);
        tablesCreated = true;
      } else {
        console.log(`✅ Table ${this.sensitiveTableName} already exists`);
      }

      // Create tenants audit table only if it doesn't exist
      if (!tables.TableNames?.includes(this.tenantsTableName)) {
        const createTenantsCommand = new CreateTableCommand({
          TableName: this.tenantsTableName,
          KeySchema: [
            {
              AttributeName: "deploymentId",
              KeyType: "HASH"
            }
          ],
          AttributeDefinitions: [
            {
              AttributeName: "deploymentId",
              AttributeType: "S"
            },
            {
              AttributeName: "timestamp",
              AttributeType: "S"
            }
          ],
          GlobalSecondaryIndexes: [
            {
              IndexName: "TimestampIndex",
              KeySchema: [
                {
                  AttributeName: "timestamp",
                  KeyType: "HASH"
                }
              ],
              Projection: {
                ProjectionType: "ALL"
              }
            }
          ],
          BillingMode: "PAY_PER_REQUEST"
        });
        
        await client.send(createTenantsCommand);
        console.log(`✅ Created table: ${this.tenantsTableName}`);
        tablesCreated = true;
      } else {
        console.log(`✅ Table ${this.tenantsTableName} already exists`);
      }

      // Only wait for tables to be ready if we actually created new ones
      if (tablesCreated) {
        console.log("⏳ Waiting for new tables to be ready...");
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    } catch (error) {
      console.error("Error ensuring tables exist:", error);
      throw error;
    }
  }

  async saveConfig(config: any): Promise<TestResult> {
    try {
      const client = await this.getClient();
      const timestamp = new Date().toISOString();
      
      let configId: string;
      let isUpdate = false;

      // If config name is provided, check if it exists and overwrite
      if (config.configName) {
        const existingConfig = await this.getConfigByName(config.configName);
        if (existingConfig) {
          configId = existingConfig.id;
          isUpdate = true;
        } else {
          configId = `config-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        }
      } else {
        configId = `config-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      }
      
      const plutoConfig: PlutoConfig = {
        id: configId,
        name: config.configName || undefined,
        workspace: {
          rootOu: config.rootOu,
          emails: config.emails
        },
        createdAt: isUpdate ? (await this.getConfigById(configId))?.createdAt || timestamp : timestamp,
        updatedAt: timestamp
      };

      const item: any = {
        id: { S: plutoConfig.id },
        workspace_rootOu: { S: plutoConfig.workspace.rootOu },
        workspace_emails: { SS: plutoConfig.workspace.emails },
        createdAt: { S: plutoConfig.createdAt },
        updatedAt: { S: plutoConfig.updatedAt }
      };

      if (plutoConfig.name) {
        item.name = { S: plutoConfig.name };
      }

      const command = new PutItemCommand({
        TableName: this.tableName,
        Item: item
      });

      await client.send(command);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getConfig(): Promise<PlutoConfig | null> {
    try {
      const client = await this.getClient();
      const command = new ScanCommand({
        TableName: this.tableName
      });

      const result = await client.send(command);
      
      if (!result.Items || result.Items.length === 0) {
        return null;
      }

      // Sort by createdAt timestamp to get the most recent config
      const sortedItems = result.Items.sort((a, b) => {
        const aTime = a.createdAt?.S || '';
        const bTime = b.createdAt?.S || '';
        return bTime.localeCompare(aTime); // Descending order (newest first)
      });

      const mostRecent = sortedItems[0];

      return {
        id: mostRecent.id.S!,
        name: mostRecent.name?.S,
        workspace: {
          rootOu: mostRecent.workspace_rootOu?.S || '',
          emails: mostRecent.workspace_emails?.SS || []
        },
        createdAt: mostRecent.createdAt?.S || '',
        updatedAt: mostRecent.updatedAt?.S || ''
      };
    } catch (error) {
      console.error("Error getting config:", error);
      return null;
    }
  }

  async getAllConfigs(): Promise<PlutoConfig[]> {
    try {
      const client = await this.getClient();
      const command = new ScanCommand({
        TableName: this.tableName
      });

      const result = await client.send(command);
      
      if (!result.Items) {
        return [];
      }

      return result.Items.map(item => ({
        id: item.id.S!,
        name: item.name?.S,
        workspace: {
          rootOu: item.workspace_rootOu?.S || '',
          emails: item.workspace_emails?.SS || []
        },
        createdAt: item.createdAt?.S || '',
        updatedAt: item.updatedAt?.S || ''
      }));
    } catch (error) {
      console.error("Error getting all configs:", error);
      return [];
    }
  }

  async saveWorkspaceToken(workspaceId: string, token: string, externalId?: string, awsAccountId?: string): Promise<TestResult> {
    try {

      const client = await this.getClient();
      const timestamp = new Date().toISOString();

      const item: any = {
        workspaceId: { S: workspaceId },
        token: { S: token },
        createdAt: { S: timestamp },
        updatedAt: { S: timestamp }
      };

      if (externalId) {
        item.externalId = { S: externalId };
      }

      if (awsAccountId) {
        item.awsAccountId = { S: awsAccountId };
      }

      const command = new PutItemCommand({
        TableName: this.sensitiveTableName,
        Item: item
      });

      await client.send(command);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getWorkspaceToken(workspaceId: string): Promise<string | null> {
    try {
      const client = await this.getClient();
      const command = new GetItemCommand({
        TableName: this.sensitiveTableName,
        Key: {
          workspaceId: { S: workspaceId }
        }
      });

      const result = await client.send(command);
      
      if (!result.Item) {
        return null;
      }

      return result.Item.token.S || null;
    } catch (error) {
      console.error("Error getting workspace token:", error);
      return null;
    }
  }

  async getAllSensitiveData(): Promise<any[]> {
    try {
      const client = await this.getClient();
      const command = new ScanCommand({
        TableName: this.sensitiveTableName
      });

      const result = await client.send(command);

      if (!result.Items) {
        return [];
      }

      return result.Items.map(item => ({
        workspaceId: item.workspaceId?.S || '',
        token: item.token?.S || '',
        externalId: item.externalId?.S || '',
        awsAccountId: item.awsAccountId?.S || '',
        createdAt: item.createdAt?.S || '',
        updatedAt: item.updatedAt?.S || ''
      }));
    } catch (error) {
      console.error("Error getting all sensitive data:", error);
      return [];
    }
  }

  async pruneDatabase(): Promise<TestResult> {
    try {
      const client = await this.getClient();
      
      // Get all items from config table
      const configScanCommand = new ScanCommand({
        TableName: this.tableName
      });
      const configItems = await client.send(configScanCommand);
      
      // Delete all items from config table
      if (configItems.Items && configItems.Items.length > 0) {
        for (const item of configItems.Items) {
          const deleteCommand = new (await import("@aws-sdk/client-dynamodb")).DeleteItemCommand({
            TableName: this.tableName,
            Key: {
              id: item.id
            }
          });
          await client.send(deleteCommand);
        }
      }
      
      // Get all items from sensitive table
      const sensitiveScanCommand = new ScanCommand({
        TableName: this.sensitiveTableName
      });
      const sensitiveItems = await client.send(sensitiveScanCommand);
      
      // Delete all items from sensitive table
      if (sensitiveItems.Items && sensitiveItems.Items.length > 0) {
        for (const item of sensitiveItems.Items) {
          const deleteCommand = new (await import("@aws-sdk/client-dynamodb")).DeleteItemCommand({
            TableName: this.sensitiveTableName,
            Key: {
              workspaceId: item.workspaceId
            }
          });
          await client.send(deleteCommand);
        }
      }
      
      return { success: true };
    } catch (error) {
      console.error("Error pruning database:", error);
      return { success: false, error: error.message };
    }
  }

  async getConfigByName(name: string): Promise<PlutoConfig | null> {
    try {
      const allConfigs = await this.getAllConfigs();
      return allConfigs.find(config => config.name === name) || null;
    } catch (error) {
      console.error("Error getting config by name:", error);
      return null;
    }
  }

  async getConfigById(id: string): Promise<PlutoConfig | null> {
    try {
      const client = await this.getClient();
      const command = new GetItemCommand({
        TableName: this.tableName,
        Key: {
          id: { S: id }
        }
      });

      const result = await client.send(command);
      
      if (!result.Item) {
        return null;
      }

      return {
        id: result.Item.id.S!,
        name: result.Item.name?.S,
        workspace: {
          rootOu: result.Item.workspace_rootOu?.S || '',
          emails: result.Item.workspace_emails?.SS || []
        },
        createdAt: result.Item.createdAt?.S || '',
        updatedAt: result.Item.updatedAt?.S || ''
      };
    } catch (error) {
      console.error("Error getting config by ID:", error);
      return null;
    }
  }

  async createTenantDeployment(deploymentId: string, configId: string, configData: any): Promise<{ success: boolean; error?: string }> {
    try {
      const client = await this.getClient();
      const timestamp = new Date().toISOString();

      const command = new PutItemCommand({
        TableName: this.tenantsTableName,
        Item: {
          deploymentId: { S: deploymentId },
          configId: { S: configId },
          configData: { S: JSON.stringify(configData) },
          status: { S: 'started' },
          startTime: { S: timestamp },
          timestamp: { S: timestamp },
          currentStep: { S: 'initialize' },
          steps: { L: [] }
        }
      });

      await client.send(command);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async updateTenantDeploymentStep(deploymentId: string, step: string, status: string, message: string, details?: any): Promise<{ success: boolean; error?: string }> {
    try {
      const client = await this.getClient();
      const timestamp = new Date().toISOString();

      // First get the current deployment to append the new step
      const getCommand = new GetItemCommand({
        TableName: this.tenantsTableName,
        Key: {
          deploymentId: { S: deploymentId }
        }
      });

      const result = await client.send(getCommand);
      const currentSteps = result.Item?.steps?.L || [];

      // Add the new step
      const newStep = {
        M: {
          step: { S: step },
          status: { S: status },
          message: { S: message },
          timestamp: { S: timestamp },
          ...(details && { details: { S: JSON.stringify(details) } })
        }
      };

      currentSteps.push(newStep);

      // Update the deployment record
      const updateCommand = new PutItemCommand({
        TableName: this.tenantsTableName,
        Item: {
          ...result.Item,
          currentStep: { S: step },
          status: { S: status },
          steps: { L: currentSteps },
          lastUpdated: { S: timestamp },
          ...(status === 'completed' && { endTime: { S: timestamp } }),
          ...(status === 'failed' && { endTime: { S: timestamp }, error: { S: message } })
        }
      });

      await client.send(updateCommand);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async getTenantDeployment(deploymentId: string): Promise<any | null> {
    try {
      const client = await this.getClient();
      const command = new GetItemCommand({
        TableName: this.tenantsTableName,
        Key: {
          deploymentId: { S: deploymentId }
        }
      });

      const result = await client.send(command);
      
      if (!result.Item) {
        return null;
      }

      return {
        deploymentId: result.Item.deploymentId.S!,
        configId: result.Item.configId?.S || '',
        configData: result.Item.configData?.S ? JSON.parse(result.Item.configData.S) : {},
        status: result.Item.status?.S || '',
        currentStep: result.Item.currentStep?.S || '',
        startTime: result.Item.startTime?.S || '',
        endTime: result.Item.endTime?.S,
        lastUpdated: result.Item.lastUpdated?.S || '',
        error: result.Item.error?.S,
        steps: result.Item.steps?.L?.map((step: any) => ({
          step: step.M.step?.S || '',
          status: step.M.status?.S || '',
          message: step.M.message?.S || '',
          timestamp: step.M.timestamp?.S || '',
          details: step.M.details?.S ? JSON.parse(step.M.details.S) : null
        })) || []
      };
    } catch (error) {
      console.error("Error getting tenant deployment:", error);
      return null;
    }
  }

  async getAllTenantDeployments(): Promise<any[]> {
    try {
      const client = await this.getClient();
      const command = new ScanCommand({
        TableName: this.tenantsTableName
      });

      const result = await client.send(command);
      
      if (!result.Items) {
        return [];
      }

      return result.Items.map(item => {
        const steps = item.steps?.L || [];
        const latestStep = steps.length > 0 ? steps[steps.length - 1].M : null;
        const latestMessage = latestStep?.message?.S || item.error?.S || 'No message available';
        
        return {
          deploymentId: item.deploymentId.S!,
          configId: item.configId?.S || '',
          configData: item.configData?.S ? JSON.parse(item.configData.S) : {},
          status: item.status?.S || '',
          currentStep: item.currentStep?.S || '',
          startTime: item.startTime?.S || '',
          endTime: item.endTime?.S || '',
          lastUpdated: item.lastUpdated?.S || item.timestamp?.S || '',
          error: item.error?.S || '',
          message: latestMessage,
          stepsCount: steps.length
        };
      }).sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
    } catch (error) {
      console.error("Error getting all tenant deployments:", error);
      return [];
    }
  }
}