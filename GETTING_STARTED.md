# Getting Started

Get the Temporal Commerce Demo running on your Mac from a fresh clone.

> *This document was drafted with AI assistance.*

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

Download and install [Docker Desktop for Mac](https://www.docker.com/products/docker-desktop/). The app requires ~2.5 GB of RAM for the six core Docker containers (Cassandra, Elasticsearch ×2, Temporal Server, Temporal UI, PostgreSQL). Add ~1 GB if you enable the optional observability stack (Jaeger, Prometheus, Grafana).

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

## Observability (Optional)

The observability stack (Jaeger, Prometheus, Grafana) is **not started by default** to save memory and speed up startup. To enable it:

### Option A: Persistent (recommended)

Add to your `.env.local`:

```
OTEL_ENABLED=true
```

Then `npm run infra:up` will automatically include the observability containers.

### Option B: One-off

```bash
npm run infra:up:obs
```

### Observability URLs

| Resource | URL |
| --- | --- |
| Jaeger UI | [http://localhost:16686](http://localhost:16686) |
| Prometheus | [http://localhost:9090](http://localhost:9090) |
| Grafana | [http://localhost:3200](http://localhost:3200) (admin/admin) |

---

## Verify It's Working

1. **Browse the catalog** — [http://localhost:3000/shop](http://localhost:3000/shop) should show a product grid with images and prices
2. **Add an item to the cart** — click a product and click "Add to Cart"
3. **Check the Temporal UI** — [http://localhost:8233](http://localhost:8233) should show a running `cart-{uuid}` workflow

If all three work, you're fully operational.

---

## Daily Usage

### Starting up (database already initialized)

To start the database backend and boot storefront and workers concurrently:

```bash
npm run dev:start-all
```

To run only storefront and workers (assuming Docker containers are already running):

```bash
npm run dev:up
```

### Shutting down

To cleanly stop Next.js storefront and worker processes:

```bash
npm run dev:down
```

To stop all active storefront, worker, and database Docker containers:

```bash
npm run dev:stop-all
```

### Full reset

```bash
npm run dev:init
```

Wipes all data volumes, recreates the Cassandra schemas, and re-seeds the catalog and inventory data from scratch.

---

## NPM Scripts Reference

| Script | Description |
| --- | --- |
| `npm run dev:start-all` | Start infrastructure (Docker) + storefront + workers |
| `npm run dev:stop-all` | Stop everything (storefront, workers + infrastructure) |
| `npm run dev:up` | Start storefront app (Next.js) + Temporal workers |
| `npm run dev:down` | Stop storefront app and Temporal worker processes |
| `npm run dev:init` | Full reset: wipe volumes ➔ start containers ➔ seed catalog ➔ stop app |
| `npm run dev:status` | Check status of all backend databases, services, and apps |
| `npm run dev:storefront` | Start storefront app only |
| `npm run dev:worker` | Start Temporal workers only |
| `npm run dev:seed` | Populate catalog and inventory data manually |
| `npm run db:init` | Apply Cassandra schema |
| `npm run db:verify` | Verify Cassandra schema consistency |
| `npm run infra:up` | Start Docker database infrastructure only |
| `npm run infra:up:obs` | Start infrastructure + observability (Jaeger, Prometheus, Grafana) |
| `npm run infra:down` | Stop Docker containers |
| `npm run infra:clean` | Stop Docker containers + wipe all data volumes |
| `npm run infra:ps` | List running Docker containers |

---

## Infrastructure Services

The project runs six core Docker containers via `docker-compose.yml`:

| Service | Port | Container | Purpose |
| --- | --- | --- | --- |
| Cassandra | 9042 | `demo-cassandra` | Product catalog, orders, inventory |
| Elasticsearch | 9200 | `demo-elasticsearch` | Product search + read-side projections |
| Temporal Server | 7233 | `demo-temporal` | Workflow orchestration engine |
| Temporal UI | 8233 | `demo-temporal-ui` | Workflow visualization and debugging |
| Temporal PostgreSQL | 5432 | `demo-temporal-postgresql` | Temporal's internal persistence |
| Temporal Elasticsearch | 9201 | `demo-temporal-elasticsearch` | Temporal's internal visibility store |

Three additional containers are available via `docker-compose.observability.yml` (opt-in):

| Service | Port | Container | Purpose |
| --- | --- | --- | --- |
| Jaeger | 16686 | `demo-jaeger` | Distributed tracing UI + OTLP collector |
| Prometheus | 9090 | `demo-prometheus` | Metrics scraping |
| Grafana | 3200 | `demo-grafana` | Metrics dashboards (admin/admin) |

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

### Elasticsearch containers crash on Apple Silicon (SIGILL / `Exited (134)`)

**Symptoms:** On a fresh `npm run dev:init`, the script appears to hang forever (often at "Waiting for storefront..." or with no visible progress). `docker ps -a` shows the Elasticsearch containers as `Exited (134)`:

```
demo-elasticsearch            Exited (134)
demo-temporal-elasticsearch   Exited (134)
```

`docker logs demo-elasticsearch` shows a fatal JVM error:

```
# A fatal error has been detected by the Java Runtime Environment:
#  SIGILL (0x4) ... linux-aarch64
# Problematic frame: j java.lang.System.registerNatives()
```

**Cause:** This is a CPU/JDK incompatibility, **not** a config error in this project. Newer Apple Silicon (**M4 / M5**) expose newer Arm vector features (SVE2 / SME) through Docker Desktop's Apple Virtualization framework. JDKs older than the fixed releases (24, 23.0.2, 21.0.6, 17.0.14) mishandle those instructions and abort with `SIGILL` the moment the JVM starts. Elasticsearch images bundle their own JDK, so older Elasticsearch tags (e.g. `8.15.x`, `7.17.x`) crash on these chips while everything else in the stack — Cassandra (JDK 11), PostgreSQL, the Temporal server — runs fine.

**This repo already works around it** by pinning Elasticsearch to **`8.19.4`** (a build whose bundled JDK disables SVE on macOS) for both the application search store and Temporal's visibility store. You should not hit this unless you change those image tags.

**If you do hit it** (e.g. after editing `docker-compose.yml`):

- Use an Elasticsearch image that bundles a fixed JDK — `8.19.x` or newer is known good.
- Temporal's visibility store has no fixed `7.17` image available, so it is run on Elasticsearch 8 as well, matched by `ES_VERSION=v8` on the `temporal` service in `docker-compose.yml`.
- General rule for **any** Dockerized Java service that `SIGILL`s on startup on an M-series Mac: bump to an image whose JDK is ≥ 24 / 23.0.2 / 21.0.6 / 17.0.14 rather than chasing Docker Desktop VM settings.

**Things that do _not_ fix it** (verified): toggling Docker Desktop's "Use Rosetta" option, passing `-XX:UseSVE=0` via `ES_JAVA_OPTS`, or switching the Virtual Machine Manager (recent Docker Desktop on current macOS forces the Apple Virtualization framework — QEMU is not selectable).

### Port conflicts

| Port | Service | Check with |
| --- | --- | --- |
| 3000 | Next.js | `lsof -i :3000` |
| 7233 | Temporal Server | `lsof -i :7233` |
| 8233 | Temporal UI | `lsof -i :8233` |
| 9042 | Cassandra | `lsof -i :9042` |
| 9200 | Elasticsearch | `lsof -i :9200` |
| 5432 | PostgreSQL | `lsof -i :5432` |
| 16686 | Jaeger (observability) | `lsof -i :16686` |
| 9090 | Prometheus (observability) | `lsof -i :9090` |
| 3200 | Grafana (observability) | `lsof -i :3200` |

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
