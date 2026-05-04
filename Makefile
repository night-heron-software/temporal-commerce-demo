.PHONY: dev stop clean db-init seed app-start app-stop workers help

# ==============================================================================
# Local Development Orchestration
# ==============================================================================

dev: ## Start local infrastructure (Cassandra, Elasticsearch, Temporal)
	@echo "Starting local infrastructure..."
	@docker-compose up -d
	@echo "⏳ Waiting for Cassandra..."
	@until docker inspect --format='{{.State.Health.Status}}' demo-cassandra 2>/dev/null | grep -q healthy; do sleep 5; echo "  Cassandra starting..."; done
	@echo "✓ Cassandra ready"
	@echo "⏳ Waiting for Elasticsearch..."
	@until curl -sf http://localhost:9200/_cluster/health > /dev/null 2>&1; do sleep 5; echo "  ES starting..."; done
	@echo "✓ Elasticsearch ready"
	@echo "⏳ Waiting for Temporal..."
	@until docker inspect --format='{{.State.Health.Status}}' demo-temporal 2>/dev/null | grep -q healthy; do sleep 5; echo "  Temporal starting..."; done
	@echo "✓ Temporal ready"
	@echo ""
	@echo "✨ Infrastructure ready!"
	@echo "   Temporal UI → http://localhost:8233"

stop: ## Stop all infrastructure containers
	@echo "Stopping infrastructure..."
	@docker-compose stop
	@echo "✓ Stopped"

clean: stop ## Stop infrastructure and wipe all data volumes
	@docker-compose down -v
	@echo "✓ All data wiped"

# ==============================================================================
# Database
# ==============================================================================

db-init: ## Initialize Cassandra schema
	@echo "Initializing Cassandra schema..."
	@docker exec -i demo-cassandra cqlsh < cassandra/schema.cql
	@echo "✓ Schema initialized"

# ==============================================================================
# Application
# ==============================================================================

app-start: ## Start storefront + workers together
	@echo "Starting Temporal Commerce Demo..."
	@echo "  Storefront → http://localhost:3000/shop"
	@echo "  Temporal UI → http://localhost:8233"
	@npx concurrently \
		--names "next,workers" \
		--prefix-colors "cyan,magenta" \
		--kill-others-on-fail \
		"npm run dev" \
		"npm run temporal:worker"

app-stop: ## Stop application processes
	@echo "Stopping application..."
	@-pkill -f "next-server" 2>/dev/null || true
	@-pkill -f "next dev" 2>/dev/null || true
	@-pkill -f "tsx.*worker" 2>/dev/null || true
	@sleep 1
	@echo "✓ Application stopped"

workers: ## Start Temporal workers only
	npm run temporal:worker

seed: ## Seed demo data (requires storefront running at localhost:3000)
	npx tsx scripts/seed.ts

# ==============================================================================
# Full Initialization
# ==============================================================================

init: dev db-init ## Full init: start infra → create schema → ready for seeding
	@echo ""
	@echo "✨ Init complete! Next steps:"
	@echo "   1. make app-start   (starts storefront + workers)"
	@echo "   2. make seed        (populates demo data)"
	@echo ""
	@echo "Quick start (after init):"
	@echo "   make app-start"
	@echo "   # In another terminal:"
	@echo "   make seed"

# ==============================================================================
# Help
# ==============================================================================

help: ## Show this help message
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
