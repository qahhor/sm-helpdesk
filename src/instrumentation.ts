// Выполняется один раз при запуске сервера Next.js, до первого запроса.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./instrumentation-node');
}
