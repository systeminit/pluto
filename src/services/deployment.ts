import { DeploymentProgress, DeploymentResult } from "./types.ts";

// Re-export types for backward compatibility
export type { DeploymentProgress, DeploymentResult } from "./types.ts";
import { DynamoDBService } from "./dynamodb.ts";
import { ChangeSetService } from "./changeset.ts";
import { ComponentService } from "./component.ts";
import { TokenExtractor } from "./token-extractor.ts";
import { runTemplate } from "@systeminit/template";

export class DeploymentService {
  private workspaceId: string;
  private dynamoService: DynamoDBService;
  private changeSetService: ChangeSetService;
  private componentService: ComponentService;
  private tokenExtractor: TokenExtractor;
  
  constructor(workspaceId: string, apiToken: string, dynamoService?: DynamoDBService) {
    this.workspaceId = workspaceId;
    this.dynamoService = dynamoService || new DynamoDBService();
    
    // Initialize the specialized services
    this.changeSetService = new ChangeSetService(workspaceId, apiToken);
    this.componentService = new ComponentService(workspaceId, apiToken);
    this.tokenExtractor = new TokenExtractor(apiToken, workspaceId);
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

      // Step 5: Apply changeset with both components (AWS Account and Workspace will both run)
      await updateProgress('apply', 'in_progress', 'Applying changeset with both components...');
      const applyResult = await this.changeSetService.applyChangeSet(changeSetId, 120, [componentResult.componentId!, workspaceResult.componentId!]);
      if (!applyResult.success) {
        await updateProgress('apply', 'failed', `Failed to apply changeset: ${applyResult.error}`);
        return { success: false, error: applyResult.error, changeSetId, progress };
      }
      await updateProgress('apply', 'completed', 'Changeset applied successfully - both component actions completed');

      // Step 6: Extract workspace token (using TokenExtractor)
      await updateProgress('workspace-extraction', 'in_progress', 'Extracting workspace API token...');
      let workspaceData = null;
      try {
        const tokenResult = await this.tokenExtractor.extractTokenWithPolling("HEAD", workspaceResult.componentId!, 60000);
        if (tokenResult.success) {
          workspaceData = {
            workspaceId: tokenResult.workspaceId!,
            token: tokenResult.token!,
            externalId: null // We'll get this from component attributes if available
          };
          // Try to get externalId from component attributes
          const workspaceResponse = await this.componentService.getComponent("HEAD", workspaceResult.componentId!, false);
          if (workspaceResponse.success) {
            const resourcePayload = workspaceResponse.data.component?.attributes?.['/resource/payload'];
            workspaceData.externalId = resourcePayload?.externalId || null;
          }
          
          await updateProgress('workspace-extraction', 'completed', `Workspace token extracted: ${workspaceData.workspaceId}`);
        } else {
          throw new Error(`Workspace token extraction failed: ${tokenResult.error}`);
        }
      } catch (error: any) {
        console.warn(`Warning: Error extracting workspace token: ${error.message}`);
        await updateProgress('workspace-extraction', 'failed', `Workspace token extraction failed: ${error.message}`);
        return { success: false, error: error.message, changeSetId, progress };
      }

      // Step 7: Extract AWS Account ID from component
      await updateProgress('aws-extraction', 'in_progress', 'Extracting AWS Account ID...');
      let awsAccountId = null;
      try {
        const startTime = Date.now();
        const timeout = 60000; // 60 seconds
        
        while (Date.now() - startTime < timeout) {
          const accountResponse = await this.componentService.getComponent("HEAD", componentResult.componentId!, false);
          if (accountResponse.success) {
            const awsComponent = accountResponse.data.component;
            
            // Check resource payload first
            const resourcePayload = awsComponent?.attributes?.['/resource/payload'];
            if (resourcePayload?.AccountId) {
              awsAccountId = resourcePayload.AccountId;
              break;
            }
            
            // Check resourceProps as fallback
            const accountIdProp = awsComponent?.resourceProps?.find((prop: any) => 
              prop.path === "root/resource_value/AccountId"
            );
            if (accountIdProp?.value) {
              awsAccountId = accountIdProp.value;
              break;
            }
            
            await new Promise(resolve => setTimeout(resolve, 5000));
          } else {
            console.warn(`Warning: Could not fetch AWS Account component: ${accountResponse.error}`);
            break;
          }
        }
        
        if (awsAccountId) {
          await updateProgress('aws-extraction', 'completed', `AWS Account ID extracted: ${awsAccountId}`);
        } else {
          console.warn('Warning: AWS Account ID not found after polling');
          await updateProgress('aws-extraction', 'completed', 'AWS Account ID not found after polling');
        }
      } catch (error: any) {
        console.warn(`Warning: Error extracting AWS Account ID: ${error.message}`);
        await updateProgress('aws-extraction', 'completed', `AWS Account extraction failed: ${error.message}`);
      }

      // Step 8: Store both workspace token and AWS Account ID together
      if (workspaceData) {
        await updateProgress('data-storage', 'in_progress', 'Storing workspace and AWS account data...');
        try {
          const storeResult = await this.dynamoService.saveWorkspaceToken(
            workspaceData.workspaceId, 
            workspaceData.token, 
            workspaceData.externalId || undefined, 
            awsAccountId || undefined
          );
          
          if (storeResult.success) {
            await updateProgress('data-storage', 'completed', `Data stored successfully for workspace ${workspaceData.workspaceId}`);
            console.log(`✅ All data stored successfully:`);
            console.log(`   Workspace ID: ${workspaceData.workspaceId}`);
            console.log(`   External ID: ${workspaceData.externalId || 'Not available'}`);
            console.log(`   AWS Account ID: ${awsAccountId || 'Not available'}`);
            console.log(`   Token: [REDACTED]`);
          } else {
            await updateProgress('data-storage', 'failed', `Failed to store data: ${storeResult.error}`);
            console.warn(`Warning: Could not store data: ${storeResult.error}`);
          }
        } catch (error: any) {
          await updateProgress('data-storage', 'failed', `Storage error: ${error.message}`);
          console.warn(`Warning: Storage error: ${error.message}`);
        }
      } else {
        await updateProgress('data-storage', 'completed', 'No workspace data available to store');
        console.warn('Warning: No workspace data available to store');
      }

      // Step 9: Create StackSet changeset for IAM role seeding
      if (workspaceData && awsAccountId) {
        await updateProgress('stackset-creation', 'in_progress', 'Creating StackSet for IAM role seeding...');
        try {
          const stacksetResult = await this.createStackSetForTenant(accountName, awsAccountId, workspaceData.externalId!);
          if (stacksetResult.success) {
            await updateProgress('stackset-creation', 'completed', `StackSet changeset created and applied: ${stacksetResult.changeSetId}`);
          } else {
            await updateProgress('stackset-creation', 'failed', `StackSet creation failed: ${stacksetResult.error}`);
            console.warn(`Warning: StackSet creation failed: ${stacksetResult.error}`);
          }
        } catch (error: any) {
          await updateProgress('stackset-creation', 'failed', `StackSet creation error: ${error.message}`);
          console.warn(`Warning: StackSet creation error: ${error.message}`);
        }
      } else {
        await updateProgress('stackset-creation', 'completed', 'StackSet creation skipped - missing required data');
      }

      // Step 10: Run AWS Standard VPC template in the newly created workspace
      if (workspaceData && workspaceData.token) {
        await updateProgress('vpc-template', 'in_progress', 'Running AWS Standard VPC template...');
        try {
          // Set the SI_API_TOKEN environment variable to the newly created workspace token
          const originalToken = Deno.env.get("SI_API_TOKEN");
          Deno.env.set("SI_API_TOKEN", workspaceData.token);

          try {
            await runTemplate('./src/si-templates/aws-standard-vpc.ts', {
              key: `${accountName}-vpc-${environmentUuid}`,
              input: './src/si-templates/aws-standard-vpc-prod-input.yaml',
              dryRun: false
            });
            await updateProgress('vpc-template', 'completed', 'VPC template executed successfully');
          } finally {
            // Restore original token
            if (originalToken) {
              Deno.env.set("SI_API_TOKEN", originalToken);
            } else {
              Deno.env.delete("SI_API_TOKEN");
            }
          }
        } catch (error: any) {
          await updateProgress('vpc-template', 'failed', `VPC template execution failed: ${error.message}`);
          console.warn(`Warning: VPC template execution failed: ${error.message}`);
        }
      } else {
        await updateProgress('vpc-template', 'completed', 'VPC template execution skipped - missing workspace token');
      }

      // Success - changeset created and applied
      await updateProgress('complete', 'completed', 'Tenant deployment completed successfully');
      return { success: true, changeSetId, progress, deploymentId };

    } catch (error: any) {
      await updateProgress('error', 'failed', `Unexpected error: ${error.message}`);
      return { success: false, error: error.message, changeSetId, progress, deploymentId };
    }
  }

  private async createStackSetForTenant(accountName: string, awsAccountId: string, externalId: string): Promise<{ success: boolean; changeSetId?: string; error?: string }> {
    try {
      console.log(`🗂️ Creating StackSet changeset for tenant ${accountName} (Account: ${awsAccountId})`);

      // Step 1: Create new changeset for StackSet
      const changesetResult = await this.changeSetService.createChangeSet(`${accountName}-stackset-seeding`);
      if (!changesetResult.success || !changesetResult.changeSetId) {
        return { success: false, error: `Failed to create StackSet changeset: ${changesetResult.error}` };
      }
      const stacksetChangeSetId = changesetResult.changeSetId;
      console.log(`📋 Created StackSet changeset: ${stacksetChangeSetId}`);

      // Step 2: Create CloudFormation template for IAM role
      const cloudFormationTemplate = {
        "AWSTemplateFormatVersion": "2010-09-09",
        "Description": `SI access role for tenant account ${awsAccountId}`,
        "Resources": {
          "SIAccessProdManagerRole": {
            "Type": "AWS::IAM::Role",
            "Properties": {
              "RoleName": "si-access-prod-manager",
              "AssumeRolePolicyDocument": {
                "Version": "2012-10-17",
                "Statement": [
                  {
                    "Effect": "Allow",
                    "Principal": {
                      "AWS": "arn:aws:iam::058264381944:user/si-access-prod-manager"
                    },
                    "Action": "sts:AssumeRole",
                    "Condition": {
                      "StringEquals": {
                        "sts:ExternalId": externalId
                      }
                    }
                  }
                ]
              },
              "ManagedPolicyArns": [
                "arn:aws:iam::aws:policy/AdministratorAccess"
              ]
            }
          }
        },
        "Outputs": {
          "SIAccessRoleArn": {
            "Description": "ARN of the SI access role",
            "Value": {
              "Fn::GetAtt": [
                "SIAccessProdManagerRole",
                "Arn"
              ]
            }
          }
        }
      };

      // Step 3: Create String Template component
      console.log(`📝 Creating String Template component...`);
      const templateResult = await this.componentService.createComponent(
        stacksetChangeSetId,
        'String Template',
        `${accountName}-iam-template`,
        {
          attributes: {
            "/domain/Template": JSON.stringify(cloudFormationTemplate, null, 2)
          },
          viewName: "Tenants"
        }
      );
      
      if (!templateResult.success) {
        return { success: false, error: `Failed to create String Template: ${templateResult.error}` };
      }
      console.log(`✅ Created String Template component: ${templateResult.componentId}`);

      // Step 4: Create CloudFormation StackSet component
      console.log(`🗂️ Creating StackSet component...`);
      const stackSetResult = await this.componentService.createComponent(
        stacksetChangeSetId,
        'AWS::CloudFormation::StackSet',
        `${accountName}-iam-seeding`,
        {
          attributes: {
            "/domain/StackSetName": `${accountName}-iam-seeding`,
            "/domain/PermissionModel": "SELF_MANAGED",
            "/domain/Description": `SI access role for tenant account ${awsAccountId}`,
            "/domain/Capabilities/0": "CAPABILITY_NAMED_IAM",
            "/domain/StackInstancesGroup/0/DeploymentTargets/Accounts/0": awsAccountId,
            "/domain/StackInstancesGroup/0/Regions/0": "us-east-1",
            "/domain/TemplateBody": {
              "$source": {
                "component": templateResult.componentId,
                "path": "/domain/Rendered/Value"
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
        }
      );

      if (!stackSetResult.success) {
        return { success: false, error: `Failed to create StackSet: ${stackSetResult.error}` };
      }
      console.log(`✅ Created StackSet component: ${stackSetResult.componentId}`);

      // Step 5: Wait for CloudFormation IAM Execution Role Seeding in New Tenant
      console.log(`📋 StackSet changeset created: ${stacksetChangeSetId}`);
      console.log(`🔍 Components created - String Template: ${templateResult.componentId}, StackSet: ${stackSetResult.componentId}`);
      console.log(`⏳ Waiting for CloudFormation IAM Execution Role Seeding in New Tenant...`);
      
      // Wait 4 minutes for IAM role seeding to complete
      await new Promise(resolve => setTimeout(resolve, 4 * 60 * 1000)); // 4 minutes
      
      // Step 6: Apply the StackSet changeset and wait for completion
      console.log(`🚀 Applying StackSet changeset...`);
      const applyResult = await this.changeSetService.applyChangeSet(
        stacksetChangeSetId, 
        120, 
        [templateResult.componentId!, stackSetResult.componentId!]
      );
      
      if (!applyResult.success) {
        return { success: false, error: `Failed to apply StackSet changeset: ${applyResult.error}` };
      }

      console.log(`✅ StackSet changeset applied successfully for tenant ${accountName}`);
      return { success: true, changeSetId: stacksetChangeSetId };

    } catch (error: any) {
      console.error(`❌ Error creating StackSet for tenant ${accountName}:`, error);
      return { success: false, error: error.message };
    }
  }
}