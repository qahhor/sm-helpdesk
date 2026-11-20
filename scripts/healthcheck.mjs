// Проверка контейнера web: процесс отвечает на /api/health.
// Код возврата 0, если ответ получен и статус ok, иначе 1.
const port = process.env.PORT ?? '3000';

try {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2500) });
  const body = await response.json();
  process.exit(response.ok && body.status === 'ok' ? 0 : 1);
} catch {
  process.exit(1);
}
