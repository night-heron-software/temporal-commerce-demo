import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    'pino',
    // Required synchronously by src/lib/logger.ts (multistream cannot use pino's worker
    // transport), which makes it statically visible to the bundler.
    'pino-pretty',
    'cassandra-driver',
    '@temporalio/client',
    '@temporalio/worker',
    '@temporalio/activity',
    '@temporalio/common',
  ],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'storage.googleapis.com',
        pathname: '/nightheron-temporal-nextjs-catalog/images/**'
      }
    ]
  }
};

export default nextConfig;
