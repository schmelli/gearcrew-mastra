/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',

  // Disable ESLint during build (we run it separately)
  eslint: {
    ignoreDuringBuilds: true,
  },

  // Disable TypeScript checking during build (we run it separately)
  typescript: {
    ignoreBuildErrors: true,
  },

  // Experimental features
  experimental: {
    // Externalize Node.js-only packages from bundling
    serverComponentsExternalPackages: [
      '@mastra/core',
      '@mastra/libsql',
      '@libsql/client',
      'libsql',
      'neo4j-driver',
    ],
  },

  // Custom webpack config for proper externalization
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Mark problematic packages as external
      config.externals = config.externals || [];
      config.externals.push({
        '@libsql/client': 'commonjs @libsql/client',
        '@mastra/libsql': 'commonjs @mastra/libsql',
        '@mastra/core': 'commonjs @mastra/core',
        'libsql': 'commonjs libsql',
        'neo4j-driver': 'commonjs neo4j-driver',
      });
    }
    return config;
  },
};

export default nextConfig;
