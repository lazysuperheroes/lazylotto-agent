import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
  transpilePackages: ['@hashgraph/hedera-wallet-connect'],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'docs.lazysuperheroes.com' },
      { protocol: 'https', hostname: 'lsh-cache.b-cdn.net' },
      { protocol: 'https', hostname: 'lazysuperheroes.myfilebase.com' },
    ],
  },
  // Empty turbopack config to silence the migration warning
  turbopack: {},
  webpack: (config, { isServer }) => {
    // Resolve .js imports to .ts files (ESM Node.js convention → bundler)
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };

    if (isServer) {
      // Externalize the MCP SDK for server-side bundles. Webpack's minification
      // breaks the StreamableHTTPClientTransport ("b is not a function") because
      // it mangles class/method names the SDK relies on at runtime.
      //
      // Note: @lazysuperheroes/lazy-lotto was previously externalized for a
      // similar reason (fs.readFileSync for ABI loading), fixed upstream in
      // v1.4.1 which ships require()-based .js wrappers. No longer needed.
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : []),
        '@modelcontextprotocol/sdk',
        /^@modelcontextprotocol\/sdk\/.*/,
      ];
    }

    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        crypto: false,
      };
    }
    return config;
  },
};

export default config;
