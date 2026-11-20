import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { STATIC_SECURITY_HEADERS } from './src/security/csp';

// Кеш компонентов (cacheComponents, partialPrefetching) намеренно не включён:
// ТЗ 9.4, правило 6. Причины записаны в docs/decisions/0002-cache-and-image-optimizer-off.md.
const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  images: { unoptimized: true },
  // Заголовки безопасности для каждого ответа: страницы, /api, файлы.
  // Политику CSP с одноразовым кодом ставит src/proxy.ts.
  headers: async () => [{ source: '/:path*', headers: [...STATIC_SECURITY_HEADERS] }],
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

export default withNextIntl(nextConfig);
