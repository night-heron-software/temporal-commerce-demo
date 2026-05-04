import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    'pino',
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
