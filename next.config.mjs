/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
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
