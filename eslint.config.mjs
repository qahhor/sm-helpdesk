import { readdirSync } from 'node:fs';
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const DB_BOUNDARY = 'К базе ходят только сервисы модулей (ТЗ 9.4, правило 2)';
const AUTH_DB_BOUNDARY =
  'Подключение hub_auth доступно только слою базы и модулю идентичности hdu (ТЗ 10.3)';
const MODULE_BOUNDARY =
  'Страницы и интерфейс работают с модулем только через его слой api (ТЗ 9.4, правило 1; docs/naming.md, раздел 5)';

// Подключение роли hub_auth: таблицы библиотеки входа и таблицы идентичности.
const AUTH_DB_PATTERN = {
  group: ['@/db/auth-client', '@/db/with-identity', '**/db/auth-client', '**/db/with-identity'],
  message: AUTH_DB_BOUNDARY,
};

const MODULE_TO_MODULE =
  'Модуль берёт у другого модуля только его api (api.ts, api/) и pref.ts, внутренние файлы не видны (docs/naming.md, раздел 5)';

// Модули портала (docs/naming.md, раздел 1) и каталоги src/modules/*. Для каждого своё правило:
// чужие внутренности закрыты, свои открыты. Модуль из перечня получает правило ещё до своего каталога.
const PLANNED_MODULES = ['hdc', 'hdu', 'hdr', 'hdt', 'hdk', 'hdi', 'hdn', 'hdp', 'hda', 'hdw', 'hdh'];
const MODULES = [
  ...new Set([
    ...PLANNED_MODULES,
    ...readdirSync(new URL('./src/modules', import.meta.url), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  ]),
];

const moduleBoundary = (name) => ({
  group: ['@/modules/*/*', `!@/modules/${name}/**`, '!@/modules/*/api', '!@/modules/*/pref', '../hd?/**', '../../hd?/**', '../../../hd?/**'],
  message: MODULE_TO_MODULE,
  allowTypeImports: true,
});

// Слои модулей (аудит 23.11.2026, находка A1): чей api модуль может брать. Зависимость идёт в одну сторону:
// hdc ни от кого, hdn и hdr только от hdc, hdu ещё от hdn, hdt от всех четырёх. Общие понятия, которые нужны
// нижним модулям от верхних (справочник контактов, контекст сотрудника), объявлены в hdc. Константы (pref)
// слоями не ограничены: это общий словарь без обращений к базе. Типы тоже под запретом: тип тянет понятие.
const MODULE_LAYERS = { hdc: [], hdn: ['hdc'], hdr: ['hdc'], hdu: ['hdc', 'hdn'], hdt: ['hdc', 'hdn', 'hdr', 'hdu'], hdw: ['hdc', 'hdn', 'hdr', 'hdu', 'hdt'] };
const LAYER_BOUNDARY =
  'Слои модулей: зависимость идёт в одну сторону (hdc, затем hdn и hdr, затем hdu, затем hdt, затем hdw). Общее понятие объявляется в hdc (решение 0039)';
const layerBoundary = (name) => {
  const allowed = MODULE_LAYERS[name];
  if (!allowed) return [];
  const closed = Object.keys(MODULE_LAYERS).filter((other) => other !== name && !allowed.includes(other));
  if (closed.length === 0) return [];
  return [{ group: closed.flatMap((other) => [`@/modules/${other}/api`, `@/modules/${other}/api/**`]), message: LAYER_BOUNDARY }];
};

// Редактор решения (план M5, задача 1): пакеты Tiptap и ProseMirror живут только в src/ui/doc/editor, а сам
// редактор не попадает в страницы кабинета клиента и открытые страницы: их бюджет скриптов 170 КБ (ТЗ 8.9).
const EDITOR_BOUNDARY = 'Пакеты редактора (Tiptap, ProseMirror) подключаются только в src/ui/doc/editor (план M5, задача 1)';
const CLIENT_EDITOR_BOUNDARY = 'Редактор решения только для рабочего места: страницы клиента показывают документ через DocView (план M5, задача 1)';
const EDITOR_PACKAGES = { group: ['@tiptap/*', 'prosemirror-*'], message: EDITOR_BOUNDARY };
const EDITOR_UI = { group: ['@/ui/doc/editor', '@/ui/doc/editor/*', '**/ui/doc/editor/*'], message: CLIENT_EDITOR_BOUNDARY };

// Ключи серверов Smartup скачивает только сетевой слой исходящих запросов src/security/outbound.ts (угроза T16,
// план M6, решение 3). Функции jose, которые ходят в сеть сами, запрещены везде: и прямым импортом, и через объект модуля.
const JOSE_REMOTE =
  'Открытые ключи скачиваются только через src/security/outbound.ts (src/modules/hdu/core/context-keys.ts), createRemoteJWKSet ходит в сеть мимо него (план M6, решение 3)';
const JOSE_REMOTE_NAMES = '/^(createRemoteJWKSet|customFetch|jwksCache)$/';

const PUBLIC_BOUNDARY = 'Открытые страницы (public) не читают сессию и не берут актора, кроме public (CLAUDE.md)';

// Общие запреты для страниц, обработчиков, интерфейса и команды консоли.
const APP_PATHS = [
  { name: 'pg', message: DB_BOUNDARY },
  { name: 'drizzle-orm/node-postgres', message: DB_BOUNDARY },
];
const APP_PATTERNS = [
  {
    group: ['@/db/client', '@/db/with-actor', '**/db/client', '**/db/with-actor'],
    message: DB_BOUNDARY,
    // Типы актора нужны и страницам: импорт типа к базе не обращается.
    allowTypeImports: true,
  },
  AUTH_DB_PATTERN,
  {
    // Разрешён только слой api модуля: файл api.ts и файлы каталога api/.
    // Импорт типов не ограничен: он не создаёт связи во время работы.
    group: ['@/modules/*/*', '!@/modules/*/api', '**/modules/*/*', '!**/modules/*/api'],
    message: MODULE_BOUNDARY,
    allowTypeImports: true,
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Страницы, обработчики, интерфейс, команда консоли: клиент базы и внутренности модулей им не видны.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/db/**', 'src/modules/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: APP_PATHS, patterns: [...APP_PATTERNS, EDITOR_PACKAGES] }],
    },
  },
  {
    // Сам редактор: пакеты Tiptap разрешены, остальные запреты те же.
    files: ['src/ui/doc/editor/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { paths: APP_PATHS, patterns: APP_PATTERNS }],
    },
  },
  {
    // Кабинет клиента: редактор не подключается.
    files: ['src/app/**/\\(portal\\)/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { paths: APP_PATHS, patterns: [...APP_PATTERNS, EDITOR_PACKAGES, EDITOR_UI] }],
    },
  },
  {
    // Группа маршрутов (public): ни сессии, ни куки, ни модуля идентичности. Правило заменяет общее,
    // поэтому общие запреты повторены.
    files: ['src/app/**/\\(public\\)/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...APP_PATHS, { name: 'next/headers', message: PUBLIC_BOUNDARY }, { name: '@/modules/hdu/api', message: PUBLIC_BOUNDARY }],
          patterns: [...APP_PATTERNS, EDITOR_PACKAGES, EDITOR_UI, { group: ['@/modules/hdu/**', '**/modules/hdu/**'], message: PUBLIC_BOUNDARY }],
        },
      ],
    },
  },
  {
    // Во всём репозитории: исходники, сценарии, тесты.
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: `ImportDeclaration[source.value='jose'] ImportSpecifier[imported.name=${JOSE_REMOTE_NAMES}]`, message: JOSE_REMOTE },
        { selector: `ExportNamedDeclaration[source.value='jose'] ExportSpecifier[local.name=${JOSE_REMOTE_NAMES}]`, message: JOSE_REMOTE },
        { selector: `MemberExpression[property.name=${JOSE_REMOTE_NAMES}]`, message: JOSE_REMOTE },
        { selector: "ImportDeclaration[source.value=/^jose\\/.+/]", message: JOSE_REMOTE },
      ],
    },
  },
  // Модули: только api и pref других модулей (проверка main, Q6). Кроме hdu, модули работают с базой
  // только под ролью hub_app.
  ...MODULES.map((name) => ({
    files: [`src/modules/${name}/**/*.{ts,tsx}`],
    rules: {
      'no-restricted-imports': ['error', { patterns: [moduleBoundary(name), ...layerBoundary(name), EDITOR_PACKAGES, ...(name === 'hdu' ? [] : [AUTH_DB_PATTERN])] }],
    },
  })),
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Собранная команда консоли (scripts/build-cli.mjs).
    'dist/**',
    // Собранный загрузчик виджета (pnpm widget:build): исходник src/widget/loader.js проверяется.
    'public/widget/**',
  ]),
]);

export default eslintConfig;
