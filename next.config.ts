import type { NextConfig } from 'next';

// Кеш компонентов (cacheComponents, partialPrefetching) намеренно не включён:
// ТЗ 9.4, правило 6. Причины записаны в docs/decisions/0002-cache-and-image-optimizer-off.md.
const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  images: { unoptimized: true },
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
