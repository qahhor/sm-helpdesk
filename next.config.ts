import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { LOCALES } from './src/i18n/locales';
import { staticHeaderRules } from './src/security/csp';

// Кеш компонентов (cacheComponents, partialPrefetching) намеренно не включён:
// ТЗ 9.4, правило 6. Причины записаны в docs/decisions/0002-cache-and-image-optimizer-off.md.
const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  images: { unoptimized: true },
  // Заголовки безопасности для каждого ответа: страницы, /api, файлы. Страницы виджета /{язык}/embed получают
  // статическую политику без frame-ancestors (план M6, задача 3). Политику CSP с одноразовым кодом ставит src/proxy.ts.
  headers: async () => staticHeaderRules(LOCALES),
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
