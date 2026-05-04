# Cloud Deployment Guide

Deploy the Temporal Commerce Demo to Temporal Cloud + AWS for live presentation.

## Architecture

```
┌──────────────────┐     ┌──────────────────────────┐
│  Vercel / App     │     │  Temporal Cloud           │
│  Runner           │     │  (mTLS, managed)          │
│  ┌──────────────┐ │     │                           │
│  │ Next.js App  │─┼────▶│  Namespace: your-ns       │
│  │ (Storefront  │ │     │  ┌─────────┐ ┌─────────┐ │
│  │  + Admin)    │ │     │  │ Cart WF │ │ OMS WF  │ │
│  └──────────────┘ │     │  └─────────┘ └─────────┘ │
└──────────────────┘     └──────────┬───────────────┘
                                     │
                          ┌──────────┴───────────────┐
                          │  ECS Fargate              │
                          │  ┌──────────────────────┐ │
                          │  │ Temporal Worker       │ │
                          │  │ (all 6 domains)      │ │
                          │  └──────────────────────┘ │
                          └──────────────────────────┘
         ┌─────────────────────┐  ┌──────────────────────┐
         │  Astra DB / AWS     │  │  Elastic Cloud /     │
         │  Keyspaces           │  │  Amazon OpenSearch    │
         │  (Cassandra)         │  │  (Search)             │
         └─────────────────────┘  └──────────────────────┘
```

## Prerequisites

- AWS CLI configured with appropriate credentials
- Temporal Cloud account ([https://cloud.temporal.io](https://cloud.temporal.io))
- Docker installed locally (for building images)

---

## Step 1: Temporal Cloud Setup

### Create Namespace

1. Log in to [Temporal Cloud](https://cloud.temporal.io)
2. Create a new namespace (e.g., `temporal-commerce-demo`)
3. Generate mTLS certificates:

```bash
# Generate client certificate and key
temporal cloud cert generate \
  --namespace temporal-commerce-demo \
  --output-dir ./certs
```

4. Base64-encode the certificates for env vars:

```bash
export TEMPORAL_TLS_CERT=$(base64 < ./certs/client.pem)
export TEMPORAL_TLS_KEY=$(base64 < ./certs/client.key)
export TEMPORAL_ADDRESS="temporal-commerce-demo.xxxxx.tmprl.cloud:7233"
export TEMPORAL_NAMESPACE="temporal-commerce-demo"
```

---

## Step 2: Cassandra (Astra DB)

### Option A: DataStax Astra DB (Recommended — Free Tier)

1. Create a free account at [astra.datastax.com](https://astra.datastax.com)
2. Create a database with keyspace `catalog`
3. Download the secure connect bundle
4. Run schema:

```bash
cqlsh --secure-connect-bundle=./secure-connect-bundle.zip \
  -u YOUR_CLIENT_ID -p YOUR_CLIENT_SECRET \
  -f cassandra/schema.cql
```

5. Set env vars:

```bash
export CASSANDRA_CONTACT_POINTS=xxx.astra.datastax.com:29042
export CASSANDRA_USE_TLS=true
export CASSANDRA_SECURE_BUNDLE_PATH=./secure-connect-bundle.zip
export CASSANDRA_KEYSPACE=catalog
```

### Option B: AWS Keyspaces

```bash
aws keyspaces create-keyspace --keyspace-name catalog

# Apply schema (remove unsupported features like CUSTOM types)
# AWS Keyspaces has CQL compatibility limits
```

---

## Step 3: Elasticsearch (Elastic Cloud or OpenSearch)

### Option A: Elastic Cloud

1. Create a deployment at [cloud.elastic.co](https://cloud.elastic.co)
2. Get the Cloud ID and API key:

```bash
export ELASTICSEARCH_URL="https://your-deployment.es.us-east-1.aws.found.io"
export ELASTICSEARCH_API_KEY="your-api-key"
```

### Option B: Amazon OpenSearch

```bash
aws opensearch create-domain \
  --domain-name temporal-commerce \
  --engine-version OpenSearch_2.11 \
  --cluster-config InstanceType=t3.small.search,InstanceCount=1
```

---

## Step 4: Deploy Worker (ECS Fargate)

### Build and Push Image

```bash
# Build
docker build -f deploy/worker.Dockerfile -t temporal-commerce-worker .

# Tag and push to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com

docker tag temporal-commerce-worker:latest $AWS_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/temporal-commerce-worker:latest
docker push $AWS_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/temporal-commerce-worker:latest
```

### Store Secrets in SSM Parameter Store

```bash
aws ssm put-parameter --name /temporal-commerce/TEMPORAL_ADDRESS --value "$TEMPORAL_ADDRESS" --type SecureString
aws ssm put-parameter --name /temporal-commerce/TEMPORAL_NAMESPACE --value "$TEMPORAL_NAMESPACE" --type SecureString
aws ssm put-parameter --name /temporal-commerce/TEMPORAL_TLS_CERT --value "$TEMPORAL_TLS_CERT" --type SecureString
aws ssm put-parameter --name /temporal-commerce/TEMPORAL_TLS_KEY --value "$TEMPORAL_TLS_KEY" --type SecureString
aws ssm put-parameter --name /temporal-commerce/CASSANDRA_CONTACT_POINTS --value "$CASSANDRA_CONTACT_POINTS" --type SecureString
aws ssm put-parameter --name /temporal-commerce/CASSANDRA_KEYSPACE --value "$CASSANDRA_KEYSPACE" --type SecureString
aws ssm put-parameter --name /temporal-commerce/CASSANDRA_USE_TLS --value "true" --type String
aws ssm put-parameter --name /temporal-commerce/ELASTICSEARCH_URL --value "$ELASTICSEARCH_URL" --type SecureString
aws ssm put-parameter --name /temporal-commerce/ELASTICSEARCH_API_KEY --value "$ELASTICSEARCH_API_KEY" --type SecureString
```

### Register and Run Task

```bash
# Substitute template variables
envsubst < deploy/ecs-task-definition.json > /tmp/task-def.json

# Register
aws ecs register-task-definition --cli-input-json file:///tmp/task-def.json

# Create service (or run task directly)
aws ecs create-service \
  --cluster default \
  --service-name temporal-commerce-worker \
  --task-definition temporal-commerce-worker \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=ENABLED}"
```

---

## Step 5: Deploy Next.js App

### Option A: Vercel (Recommended)

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel --prod

# Set env vars in Vercel dashboard:
# TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_TLS_CERT, TEMPORAL_TLS_KEY
# CASSANDRA_CONTACT_POINTS, CASSANDRA_KEYSPACE, CASSANDRA_USE_TLS
# ELASTICSEARCH_URL, ELASTICSEARCH_API_KEY
```

### Option B: AWS App Runner

```bash
# Create App Runner service from source
aws apprunner create-service \
  --service-name temporal-commerce-app \
  --source-configuration '{
    "ImageRepository": {
      "ImageIdentifier": "'$AWS_ACCOUNT_ID'.dkr.ecr.us-east-1.amazonaws.com/temporal-commerce-app:latest",
      "ImageRepositoryType": "ECR"
    }
  }'
```

---

## Step 6: Seed Cloud Data

With the Next.js app running against cloud infrastructure:

```bash
# Point seed script at the cloud app URL
APP_URL=https://your-app.vercel.app npm run seed
```

Or run directly:

```bash
tsx scripts/seed.ts https://your-app.vercel.app
```

---

## Step 7: Verify

1. Browse the storefront at your deployed URL
2. Add items to cart, proceed through checkout
3. Check order appears in the admin panel
4. View workflow execution in [Temporal Cloud UI](https://cloud.temporal.io)
5. Use manual fulfillment controls to step the order through delivery

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|:---------|:---------|:--------|:------------|
| `TEMPORAL_ADDRESS` | Yes | `localhost:7233` | Temporal server address |
| `TEMPORAL_NAMESPACE` | Yes | `default` | Temporal namespace |
| `TEMPORAL_TLS_CERT` | Cloud only | — | Base64-encoded mTLS client cert |
| `TEMPORAL_TLS_KEY` | Cloud only | — | Base64-encoded mTLS client key |
| `CASSANDRA_CONTACT_POINTS` | Yes | `localhost:9042` | Cassandra contact points |
| `CASSANDRA_KEYSPACE` | Yes | `catalog` | Cassandra keyspace name |
| `CASSANDRA_USE_TLS` | Cloud only | `false` | Enable TLS for Cassandra |
| `CASSANDRA_SECURE_BUNDLE_PATH` | Astra only | — | Path to Astra secure bundle |
| `ELASTICSEARCH_URL` | Yes | `http://localhost:9200` | Elasticsearch endpoint |
| `ELASTICSEARCH_API_KEY` | Cloud only | — | Elasticsearch API key |
| `NEXT_PUBLIC_APP_URL` | Yes | `http://localhost:3000` | Public app URL |
