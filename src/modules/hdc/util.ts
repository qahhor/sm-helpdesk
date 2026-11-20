// Модуль hdc, слой util: чистые функции без обращения к базе (docs/naming.md, раздел 5).

const NO_STORE = { 'Cache-Control': 'no-store' };

/** Ответ проверки "процесс жив". От базы и внешних сервисов не зависит. */
export function healthResponse(): Response {
  return Response.json({ status: 'ok' }, { headers: NO_STORE });
}

/**
 * Ответ проверки "готов принимать запросы".
 * Подробности отказа в тело не попадают: адрес проверки открыт без входа.
 */
export async function readyResponse(ping: () => Promise<boolean>): Promise<Response> {
  let dbOk = false;
  try {
    dbOk = await ping();
  } catch {
    dbOk = false;
  }
  return Response.json(
    { status: dbOk ? 'ready' : 'not_ready', checks: { db: dbOk ? 'ok' : 'fail' } },
    { status: dbOk ? 200 : 503, headers: NO_STORE },
  );
}
