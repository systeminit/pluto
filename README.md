# Pluto App

A simple web application for managing AWS and Workspace configurations, built with Deno and TypeScript.

## Features

- 🔐 AWS IAM credential management (runtime profile, manual creds, session tokens)
- 🗄️ DynamoDB state management
- 🌐 Workspace API integration for tenant management
- 📦 Docker containerization ready for ECS deployment
- 🎯 Simple web UI for configuration

## Local Development

### Prerequisites

- [Deno](https://deno.land/) installed
- Docker and Docker Compose (for local DynamoDB)

### Quick Start

1. **Clone and setup:**
   ```bash
   cd pluto
   cp .env.example .env
   ```

2. **Edit `.env` with your AWS credentials:**
   ```
   AWS_ACCESS_KEY_ID=your_access_key
   AWS_SECRET_ACCESS_KEY=your_secret_key
   AWS_SESSION_TOKEN=your_session_token_if_needed
   AWS_REGION=us-east-1
   ```

3. **Run with Docker Compose (easiest):**
   ```bash
   docker-compose up --build
   ```

4. **Or run locally with script:**
   ```bash
   ./local-dev.sh
   ```
   (This requires running DynamoDB Local separately)

5. **Access the app:**
   - Web UI: http://localhost:8080
   - Local DynamoDB: http://localhost:8001

## Configuration

The app accepts configuration through:

- **AWS Credentials**: Access Key, Secret Key, Session Token, Region
- **Workspace API**: Token for workspace management
- **Deployment Settings**: Root OU, email sharing list

## API Endpoints

- `GET /` - Simple web UI
- `POST /api/test-aws` - Test AWS credentials
- `POST /api/test-dynamodb` - Test DynamoDB connection  
- `POST /api/save-config` - Save configuration to DynamoDB
- `POST /api/deploy-tenant` - Deploy tenant to workspace

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

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `8080` |
| `AWS_ACCESS_KEY_ID` | AWS access key | - |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key | - |
| `AWS_SESSION_TOKEN` | AWS session token | - |
| `AWS_REGION` | AWS region | `us-east-1` |
| `DYNAMODB_ENDPOINT` | DynamoDB endpoint | - |
| `WORKSPACE_API_BASE_URL` | Workspace API base URL | `https://api.workspace.example.com` |

## Development

### File Structure
```
src/
├── main.ts                 # Main application server
├── services/
│   ├── aws-credentials.ts  # AWS credential handling
│   ├── dynamodb.ts        # DynamoDB state management
│   └── workspace.ts       # Workspace API integration
```

### Running Tests
```bash
deno task test  # When tests are added
```

## License

MIT