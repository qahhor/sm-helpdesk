import { getEnv } from '@/env';
import { showcaseEnabled } from '@/ui/showcase';

// Образец изображения для пробы редактора (план M5, задача 1): условный снимок экрана 160 на 90 точек.
// Загрузка настоящих файлов решения появится в задаче 3. Открыт только при HUB_SHOWCASE=1, как сама проба.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAIAAACwpMoFAAAA00lEQVR42u3ZQQ2AMAyG0TpBIn5QgARkIGYh2W0WSE9b95JPQd+tfxznq8KFEwAWYC0B3L6uAgEGLMACLMACLMACDBgwYAEWYAEWYAEGnAG+7keJAAMGDBgwYMCAAQMWYAEGDBgwYMCAAQMGDHgPYNmDBViABViAAQMGLMACLMACLGPDKpMAYMCAAQMGDBgwYMCAAQMGDBgwYK9Kr0rAgAVYgAVYgAVYgAEDBizAAizAAizAgAEDFmABFmABFmABBizAAizAAizA+gusegEGLMCatgH6mByeLwmrsQAAAABJRU5ErkJggg==',
  'base64',
);

export function GET() {
  if (!showcaseEnabled(getEnv())) return new Response(null, { status: 404 });
  return new Response(PNG, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
}
