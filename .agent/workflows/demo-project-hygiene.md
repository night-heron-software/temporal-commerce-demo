---
description: Full workspace hygiene audit for temporal-commerce-demo — gitignore, secrets, stale artifacts, and more
---

# Demo Project Hygiene

Comprehensive project hygiene audit for temporal-commerce-demo.

## Steps

### 1. Gitignore Hygiene — Tracked-but-Ignored Files

// turbo

```bash
cd /Users/jeffromine/src/portfolio/temporal-commerce-demo && git ls-files | git check-ignore --no-index --stdin 2>/dev/null || echo "✅ No tracked-but-ignored files found"
```

### 2. Secrets Audit — Ensure No .env Files Are Staged

// turbo

```bash
cd /Users/jeffromine/src/portfolio/temporal-commerce-demo && git status --short | grep -E '\.env\.local|\.env$' || echo "✅ No env files staged"
```

### 3. Format Check

// turbo

```bash
cd /Users/jeffromine/src/portfolio/temporal-commerce-demo && npm run format:check 2>&1 || echo "⚠️  Some files are not formatted"
```

### 4. Lint Check

// turbo

```bash
cd /Users/jeffromine/src/portfolio/temporal-commerce-demo && npm run lint 2>&1 || echo "⚠️  Lint issues found"
```

### 5. Type Check

// turbo

```bash
cd /Users/jeffromine/src/portfolio/temporal-commerce-demo && npx tsc --noEmit 2>&1 || echo "⚠️  Type errors found"
```

## Reporting

Present results as a table with PASS/WARN/FAIL for each check. Only flag actionable issues.
