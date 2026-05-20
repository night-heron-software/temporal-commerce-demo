# Getting Started

Get the Temporal Commerce Demo running on your Mac from a fresh clone.

---

## Prerequisites

Install these before cloning the repository:

### 1. Node.js (v20+)

```bash
# Using Homebrew
brew install node

# Or using nvm (recommended for version management)
nvm install 20
nvm use 20
```

Verify: `node --version` should show v20 or higher.

### 2. Docker Desktop

Download and install [Docker Desktop for Mac](https://www.docker.com/products/docker-desktop/). The app requires ~4 GB of RAM for the six Docker containers (Cassandra, Elasticsearch ×2, Temporal Server, Temporal UI, PostgreSQL).

After installation, open Docker Desktop at least once to complete setup. The project scripts will auto-start Docker Desktop if it's installed but not running.

### 3. Git

```bash
brew install git
```

---

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/night-heron-software/temporal-commerce-demo.git
cd temporal-commerce-demo
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env.local
```

No changes are needed — the defaults are configured for the local Docker Compose environment.

### 4. Initialize and run

You have two options:

#### Option A: Fully automated (one command)

This wipes any previous data, starts all infrastructure, starts the application, seeds the product catalog, and stops the application storefront/workers (leaving infrastructure running in Docker):

```bash
npm run dev:init
```

This takes 2–4 minutes on first run (Docker images need to download). When you see `✨ Full reset & seeding complete!`, the database is ready and seeded.

#### Option B: Step by step

```bash
# Start infrastructure + apply Cassandra schema
npm run infra:up && npm run db:init

# Start storefront + Temporal workers (in one terminal)
npm run dev:up

# Seed demo data (in another terminal, after storefront is ready)
npm run dev:seed
```

### 5. Open the app

| Resource | URL |
| --- | --- |
| Storefront | [http://localhost:3000/shop](http://localhost:3000/shop) |
| Admin Panel | [http://localhost:3000/admin](http://localhost:3000/admin) |
| Temporal UI | [http://localhost:8233](http://localhost:8233) |

---

## Verify It's Working

1. **Browse the catalog** — [http://localhost:3000/shop](http://localhost:3000/shop) should show a product grid with images and prices
2. **Add an item to the cart** — click a product and click "Add to Cart"
3. **Check the Temporal UI** — [http://localhost:8233](http://localhost:8233) should show a running `cart-{uuid}` workflow

If all three work, you're fully operational.

---

## Daily Usage

### Starting up (database already initialized)

```bash
npm run dev:up
```

This starts Docker infrastructure (Cassandra, Elasticsearch, Temporal), waits for health checks, then launches the Next.js storefront and Temporal workers.

### Shutting down

```bash
npm run dev:down
```

This stops the application processes and all Docker containers. Data is preserved for next time.

### Full reset

```bash
npm run dev:init
```

Wipes all data, recreates the schema, and re-seeds the catalog from scratch.

---

## NPM Scripts Reference

| Script | Description |
| --- | --- |
| `npm run dev:up` | Start infrastructure + storefront + workers |
| `npm run dev:down` | Stop everything (app + infrastructure) |
| `npm run dev:init` | Full reset: wipe → init → start → seed → stop app |
| `npm run dev:storefront` | Start storefront app (Next.js) only |
| `npm run dev:worker` | Start Temporal workers only |
| `npm run dev:seed` | Populate demo catalog data |
| `npm run dev:status` | Check status of all services and processes |
| `npm run db:init` | Apply Cassandra schema |
| `npm run db:verify` | Verify Cassandra schema consistency |
| `npm run infra:up` | Start Docker infrastructure only |
| `npm run infra:down` | Stop Docker containers |
| `npm run infra:clean` | Stop + wipe all data volumes |
| `npm run infra:ps` | List running containers |

---

## Infrastructure Services

The project runs six Docker containers via `docker-compose.yml`:

| Service | Port | Container | Purpose |
| --- | --- | --- | --- |
| Cassandra | 9042 | `demo-cassandra` | Product catalog, orders, inventory |
| Elasticsearch | 9200 | `demo-elasticsearch` | Product search + read-side projections |
| Temporal Server | 7233 | `demo-temporal` | Workflow orchestration engine |
| Temporal UI | 8233 | `demo-temporal-ui` | Workflow visualization and debugging |
| Temporal PostgreSQL | 5432 | `demo-temporal-postgresql` | Temporal's internal persistence |
| Temporal Elasticsearch | 9201 | `demo-temporal-elasticsearch` | Temporal's internal visibility store |

---

## Troubleshooting

### Docker won't start

- Ensure Docker Desktop is installed and has been opened at least once
- Check available disk space — the containers need ~4 GB
- On Apple Silicon (M1/M2/M3/M4), Docker Desktop runs natively — no Rosetta needed

### `npm install` fails with native module errors

The Temporal SDK includes native Node.js addons. If you see compilation errors:

```bash
# Ensure Xcode command line tools are installed
xcode-select --install

# Clear npm cache and retry
rm -rf node_modules package-lock.json
npm install
```

### Cassandra takes a long time to start

- First startup can take 60–90 seconds while Cassandra initializes. The `npm run infra:up` script waits for the health check automatically — don't interrupt it.

### Port conflicts

| Port | Service | Check with |
| --- | --- | --- |
| 3000 | Next.js | `lsof -i :3000` |
| 7233 | Temporal Server | `lsof -i :7233` |
| 8233 | Temporal UI | `lsof -i :8233` |
| 9042 | Cassandra | `lsof -i :9042` |
| 9200 | Elasticsearch | `lsof -i :9200` |
| 5432 | PostgreSQL | `lsof -i :5432` |

Kill the conflicting process or stop the other service before starting the demo.

### Seed shows "fetch failed"

- The seed script calls the running Next.js app's API endpoints. Make sure the storefront is running and healthy at `http://localhost:3000` before running `npm run dev:seed`.

### Temporal workers crash on startup

Check that the Temporal Server is healthy:

```bash
npm run infra:ps
```

The `demo-temporal` container should show `Up (healthy)`. If it shows `starting`, wait for it to finish.

---

## What's Next

- [Developer Guide](docs/developer-guide.md) — Architecture, code organization, and Temporal patterns
- [Project Description](docs/project-description.md) — What the demo covers and why
- [Presentation Script](docs/presentation-script.md) — 30–40 minute talk script with code excerpts
- [Demo Instructions](docs/demo-instructions.md) — Streamlined 4–5 minute live demo walkthrough
