// Сборка команды консоли hub и фонового процесса в файлы dist/hub.mjs и dist/worker.mjs со всеми зависимостями.
// Файлы кладутся в образ и запускаются там без каталога node_modules: node hub.mjs <команда>, node worker.mjs.
import { resolve } from 'node:path';
import { build } from 'rolldown';

const root = resolve(import.meta.dirname, '..');

/**
 * @param {string} entry исходный файл точки входа
 * @param {string} name имя собранного файла в dist/
 * @returns {Promise<string>} путь собранного файла
 */
async function bundle(entry, name) {
  const file = resolve(root, 'dist', name);
  await build({
    cwd: root,
    input: resolve(root, entry),
    platform: 'node',
    // Необязательная родная библиотека драйвера pg: в образе её нет, драйвер обходится без неё.
    external: ['pg-native'],
    resolve: {
      alias: {
        '@': resolve(root, 'src'),
        // Пакет-метка "только для сервера" бросает ошибку вне Next.js. Команда и так работает только на сервере.
        'server-only': false,
      },
    },
    logLevel: 'warn',
    output: {
      file,
      format: 'esm',
      codeSplitting: false,
      banner: '// Собрано scripts/build-cli.mjs. Не править вручную.',
    },
  });
  return file;
}

/** @returns {Promise<string>} путь собранного файла */
export const buildCli = () => bundle('src/cli/main.ts', 'hub.mjs');

/** @returns {Promise<string>} путь собранного файла фонового процесса */
export const buildWorker = () => bundle('src/worker/main.ts', 'worker.mjs');

if (import.meta.main) {
  try {
    const file = await buildCli();
    console.log(`Команда hub собрана: ${file}`);
    console.log(`Фоновый процесс собран: ${await buildWorker()}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
