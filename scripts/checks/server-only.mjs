// Серверный код не попадает в браузер (ТЗ 9.4, правило 5):
// файл окружения, слой базы и сервисы модулей начинаются с `import 'server-only'`.

const SCOPE = [/^src\/env\.ts$/, /^src\/db\/[^/]+\.ts$/, /^src\/modules\/[^/]+\/(?:api|core)\.ts$/];

/**
 * @param {string} path путь от корня репозитория
 * @returns {boolean} обязан ли файл начинаться с `import 'server-only'`
 */
export function requiresServerOnly(path) {
  return SCOPE.some((re) => re.test(path));
}

/**
 * @param {string} path путь от корня репозитория
 * @param {string} text
 * @returns {boolean} true, если файл обязан начинаться с `import 'server-only'` и не начинается
 */
export function findMissingServerOnly(path, text) {
  if (!requiresServerOnly(path)) return false;
  // Первая строка кода: пропускаются пустые строки и комментарии.
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const first = withoutComments.split('\n').find((line) => line.trim() !== '' && !line.trim().startsWith('//'));
  return !/^\s*import\s+['"]server-only['"]\s*;?\s*$/.test(first ?? '');
}
