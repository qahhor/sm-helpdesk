// Сборка команды консоли hub в один файл dist/hub.mjs со всеми зависимостями.
// Файл кладётся в образ и запускается там без каталога node_modules: node hub.mjs <команда>.
import { resolve } from 'node:path';
import { build } from 'rolldown';

const root = resolve(import.meta.dirname, '..');

/** @returns {Promise<string>} путь собранного файла */
export async function buildCli() {
  const file = resolve(root, 'dist/hub.mjs');
  await build({
    cwd: root,
    input: resolve(root, 'src/cli/main.ts'),
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

if (import.meta.main) {
  try {
    const file = await buildCli();
    console.log(`Команда hub собрана: ${file}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
