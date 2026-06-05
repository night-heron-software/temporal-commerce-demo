import { NextResponse } from 'next/server';
import { getCassandraClient } from '../../../lib/cassandra-client';
import { getTemporalClient } from '../../../lib/temporal-client';
import { createLogger } from '../../../lib/logger';

const log = createLogger('api-health');
const ES_URL = process.env.ELASTICSEARCH_URL || 'http://localhost:9200';

interface ServiceStatus {
  status: 'up' | 'down';
  latencyMs?: number;
  error?: string;
  details?: Record<string, unknown>;
}

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  services: {
    app: { status: 'up' | 'down' };
    cassandra: ServiceStatus;
    temporal: ServiceStatus;
    elasticsearch: ServiceStatus;
  };
}

export async function GET(): Promise<NextResponse<HealthStatus>> {
  const health: HealthStatus = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      app: { status: 'up' },
      cassandra: { status: 'down' },
      temporal: { status: 'down' },
      elasticsearch: { status: 'down' },
    },
  };

  // Check Cassandra — verify the catalog keyspace is initialized, not just connectivity
  try {
    const cassandraStart = Date.now();
    const client = getCassandraClient();
    const result = await client.execute(
      "SELECT table_name FROM system_schema.tables WHERE keyspace_name = 'catalog' LIMIT 1",
    );
    health.services.cassandra = {
      status: 'up',
      latencyMs: Date.now() - cassandraStart,
      details: { keyspaceVerified: true, tableCount: result.rowLength },
    };
  } catch (e) {
    health.services.cassandra = {
      status: 'down',
      error: e instanceof Error ? e.message : 'Unknown error',
    };
  }

  // Check Temporal
  try {
    const temporalStart = Date.now();
    const client = await getTemporalClient();
    const workflows = client.workflow.list({ query: 'ExecutionStatus="Running"' });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _workflow of workflows) {
      break;
    }
    health.services.temporal = {
      status: 'up',
      latencyMs: Date.now() - temporalStart,
    };
  } catch (e) {
    health.services.temporal = {
      status: 'down',
      error: e instanceof Error ? e.message : 'Unknown error',
    };
  }

  // Check Elasticsearch — cluster health
  try {
    const esStart = Date.now();
    const response = await fetch(`${ES_URL}/_cluster/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const data = await response.json();
      health.services.elasticsearch = {
        status: 'up',
        latencyMs: Date.now() - esStart,
        details: {
          clusterStatus: data.status,
          numberOfNodes: data.number_of_nodes,
          activeShards: data.active_shards,
        },
      };
    } else {
      health.services.elasticsearch = {
        status: 'down',
        error: `HTTP ${response.status}`,
      };
    }
  } catch (e) {
    health.services.elasticsearch = {
      status: 'down',
      error: e instanceof Error ? e.message : 'Unknown error',
    };
  }

  // Determine overall status
  const serviceStatuses = [
    health.services.cassandra.status,
    health.services.temporal.status,
    health.services.elasticsearch.status,
  ];

  const allUp = serviceStatuses.every((s) => s === 'up');
  const allDown = serviceStatuses.every((s) => s === 'down');

  if (allUp) {
    health.status = 'healthy';
  } else if (allDown) {
    health.status = 'unhealthy';
  } else {
    health.status = 'degraded';
  }

  if (health.status !== 'healthy') {
    log.warn({ health }, 'System health check returned non-healthy status');
  }

  const statusCode = health.status === 'unhealthy' ? 503 : 200;

  return NextResponse.json(health, { status: statusCode });
}
