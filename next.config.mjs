import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
    NEXT_PUBLIC_HEDERA_NETWORK: process.env.HEDERA_NETWORK ?? 'testnet',
  },
  transpilePackages: ['@hashgraph/hedera-wallet-connect'],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'docs.lazysuperheroes.com' },
      { protocol: 'https', hostname: 'lsh-cache.b-cdn.net' },
      { protocol: 'https', hostname: 'lazysuperheroes.myfilebase.com' },
    ],
  },
  // KNOWN LIMITATION — Turbopack (Next.js 16 default bundler for
  // `next dev`) does NOT support webpack's `extensionAlias` for
  // rewriting `.js` imports to `.ts` files. The src/ tree uses the
  // standard Node.js ESM convention where TypeScript files are
  // imported with `.js` suffixes (e.g. `import './session.js'` that
  // actually resolves to `session.ts`). This works in the CLI
  // (Node + tsx) and in webpack (via the extensionAlias below) but
  // fails in Turbopack.
  //
  // Workaround: the `dev:web` package.json script forces `--webpack`
  // so dev mode uses the same bundler as the production build and
  // honors the extensionAlias. Slightly slower than Turbopack but
  // guaranteed to match production resolution.
  //
  // Revisit: when Turbopack ships extension-rewriting (tracked in
  // vercel/next.js issues) or when we migrate src/ imports to
  // extensionless paths (would require changing the Node/tsx side
  // of the build to match).
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
