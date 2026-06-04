---
description: Verify the temporal-commerce-demo platform health, types, schema, and end-to-end checkout flow
---

# Demo Verify

Run verification checks against the running demo to ensure all services are healthy and data is consistent.

## Prerequisites

- Infrastructure running (`npm run infra:up`)
- Application running (`npm run dev:up`)

## Steps

### 1. Type Check

// turbo

```bash
cd /Users/jeffromine/src/portfolio/temporal-commerce-demo && npx tsc --noEmit
```

### 2. Lint Check

// turbo

```bash
cd /Users/jeffromine/src/portfolio/temporal-commerce-demo && npm run lint
```

### 3. Schema Verification

// turbo

```bash
cd /Users/jeffromine/src/portfolio/temporal-commerce-demo && npm run db:verify
```

### 4. System Validation

// turbo

```bash
cd /Users/jeffromine/src/portfolio/temporal-commerce-demo && npm run dev:validate
```

### 5. Deep Health Check

// turbo

```bash
curl -sf http://localhost:3000/api/health | python3 -m json.tool
```

## Reporting

Present all results as a summary table with PASS/FAIL status for each step.
