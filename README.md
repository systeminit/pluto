# Pluto App

A tenant deployment automation application for System Initiative, built with Deno and TypeScript. Automates the creation of AWS Organizations accounts, SI workspaces, IAM roles via CloudFormation StackSets, and VPC infrastructure using SI templates.

## Features

- 🏢 **AWS Organizations Account Creation** - Automatically creates AWS accounts in Organizations
- 🚀 **SI Workspace Provisioning** - Creates and configures System Initiative workspaces for each tenant
- 🔐 **IAM Role Deployment** - Deploys cross-account IAM roles via CloudFormation StackSets
- 🌐 **VPC Infrastructure** - Deploys production-ready VPC using SI templates (2 public + 2 private subnets with NAT)
- 📊 **Real-time Progress Tracking** - Timeline-based UI showing deployment progress
- 🗄️ **DynamoDB State Management** - Stores deployment history and tenant metadata
- 📦 **Docker containerization** - Ready for ECS deployment

## Local Development

### Prerequisites

- [Deno](https://deno.land/) v2.0 or later installed
- Docker and Docker Compose (for local DynamoDB)
- AWS credentials with Organizations permissions
- System Initiative workspace and API token

### Environment Setup

1. **Clone and create environment file:**
   ```bash
   cd pluto
   cp .env.example .env
   ```

2. **Configure `.env` with required variables:**
   ```bash
   # AWS Credentials (for Organizations management)
   AWS_ACCESS_KEY_ID=your_access_key
   AWS_SECRET_ACCESS_KEY=your_secret_key
   AWS_SESSION_TOKEN=your_session_token_if_needed
   AWS_REGION=us-east-1

   # System Initiative Configuration
   SI_WORKSPACE_ID=your_workspace_id
   WORKSPACE_API_TOKEN=your_si_api_token

   # DynamoDB Configuration (local dev)
   DYNAMODB_ENDPOINT=http://dynamodb-local:8000

   # Server Configuration
   PORT=8080
   ```

### Running the Application

**Option 1: Docker Compose (Recommended)**
```bash
docker-compose up --build
```

**Option 2: Local Development**
```bash
# Start DynamoDB Local separately
docker run -p 8001:8000 amazon/dynamodb-local

# Run the app
deno task dev
```

### Access Points

- **Web UI**: http://localhost:8080
- **Local DynamoDB Admin**: http://localhost:8001

## How It Works

### Deployment Flow

When you deploy a tenant, Pluto orchestrates the following steps:

1. **Create Changeset** - Creates a new changeset in the management SI workspace
2. **AWS Account Component** - Creates AWS Organizations Account component
3. **Workspace Component** - Creates Workspace Management component
4. **Apply Changeset** - Applies changeset, triggering AWS account and workspace creation
5. **Extract Workspace Token** - Polls for and extracts the new workspace API token
6. **Extract AWS Account ID** - Retrieves the created AWS account ID
7. **Store Data** - Saves workspace token and AWS account ID to DynamoDB
8. **Deploy StackSet** - Creates CloudFormation StackSet with IAM roles for SI access
9. **Seed Tenant Workspace** - Configures the new workspace with:
   - AWS Credential component (with assume role ARN)
   - Region component (us-east-1)
10. **Deploy VPC Template** - Runs SI template to create production VPC infrastructure

### SI Template Integration

The VPC deployment uses the `@systeminit/template` CLI via a wrapper script:
- Templates are TypeScript files that define infrastructure as code
- The template runner automatically initializes context and executes the template
- VPC template creates: 2 public subnets, 2 private subnets, NAT gateway, Internet gateway, and routing

## API Endpoints

- `GET /` - Web UI for tenant management
- `POST /api/test-aws` - Test AWS Organizations credentials
- `POST /api/test-dynamodb` - Test DynamoDB connection
- `POST /api/save-config` - Save deployment configuration
- `POST /api/deploy-tenant/start` - Start tenant deployment (returns deploymentId)
- `GET /api/deploy-tenant/progress/:deploymentId` - Get real-time deployment progress
- `GET /api/tenant-deployments` - List all tenant deployments
- `GET /api/tenant-deployments/:deploymentId` - Get specific deployment details
- `POST /api/prune-database` - Clear all database records

## Docker Deployment

### Build Image
```bash
docker build -t pluto-app .
```

### Run Container
```bash
docker run -p 8080:8080 \
  -e AWS_ACCESS_KEY_ID=your_key \
  -e AWS_SECRET_ACCESS_KEY=your_secret \
  -e AWS_REGION=us-east-1 \
  pluto-app
```

### ECS Deployment
The Docker image is ready for ECS deployment. Configure environment variables in your ECS task definition.

## Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `PORT` | Server port | No | `8080` |
| `AWS_ACCESS_KEY_ID` | AWS Organizations admin access key | Yes | - |
| `AWS_SECRET_ACCESS_KEY` | AWS Organizations admin secret key | Yes | - |
| `AWS_SESSION_TOKEN` | AWS session token (if using temp creds) | No | - |
| `AWS_REGION` | AWS region for Organizations API | No | `us-east-1` |
| `DYNAMODB_ENDPOINT` | DynamoDB endpoint (local dev) | No | - |
| `SI_WORKSPACE_ID` | Management SI workspace ID | Yes | - |
| `WORKSPACE_API_TOKEN` | Management SI workspace API token | Yes | - |

## Development

### Project Structure
```
src/
├── main.ts                      # Main Hono server with API routes
├── services/
│   ├── deployment.ts            # Main deployment orchestration
│   ├── changeset.ts             # SI changeset operations
│   ├── component.ts             # SI component management
│   ├── dynamodb.ts              # DynamoDB state persistence
│   ├── aws-credentials.ts       # AWS credential handling
│   ├── workspace.ts             # Workspace API integration
│   └── token-extractor.ts       # Workspace token extraction
├── si-templates/
│   ├── aws-standard-vpc.ts      # VPC infrastructure template
│   ├── aws-standard-vpc-prod-input.yaml  # VPC template inputs
│   └── run-cli.ts               # SI template CLI wrapper
└── templates/
    └── index.html               # Web UI
```

### Key Dependencies

- **Deno Runtime** - Modern TypeScript/JavaScript runtime
- **Hono** - Fast web framework
- **@systeminit/api-client** - SI API TypeScript client
- **@systeminit/template** - SI template engine
- **@aws-sdk/client-dynamodb** - AWS DynamoDB SDK
- **@aws-sdk/credential-providers** - AWS credential management

### Template Development

Templates are located in `src/si-templates/`. To create a new template:

1. Create a TypeScript file exporting a default function
2. Use `TemplateContext` API to define infrastructure
3. Add corresponding input YAML file for parameters
4. Update deployment service to call the template

Example:
```typescript
import { TemplateContext } from "@systeminit/template";

export default function (c: TemplateContext) {
  c.name("My Template");
  c.changeSet(`${c.name()} - ${c.invocationKey()}`);

  // Define components, subscriptions, etc.
}
```

### Running Tests
```bash
deno task test  # When tests are added
```

## Troubleshooting

### Common Issues

**"Context has not been initialized"**
- Ensure you're using the CLI wrapper (`run-cli.ts`) not importing `runTemplate` directly
- The wrapper properly initializes the SI template context

**"Cannot set secrets directly on component"**
- Use `attributes` field with `$source` subscriptions, not `secrets` field
- Check socket names (e.g., `/secrets/credential` not `/secrets/AWS Credential`)

**DynamoDB connection issues**
- Verify `DYNAMODB_ENDPOINT` is set correctly for local dev
- Check Docker Compose network connectivity

**Workspace token not found**
- Token extraction can take time; check polling logs
- Ensure Workspace Management component action completed successfully

## License

MIT