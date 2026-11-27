import 'server-only';
import * as z from 'zod';
import { cleanUserText } from '@/modules/hdc/pref';
import { ensureAgentBotTx } from '../core/agent-bots';
import { HduError } from '../error';

// Модуль hdu, слой api: учётная запись AI-сотрудника для выпуска токена (веха M8b, задача 3; план M8b, решение 16).
// Вызывает только модуль hda при выпуске токена администратором: права и свежесть входа проверяет он. Здесь только
// проверка имени схемой.

const nameInput = z.string().overwrite(cleanUserText).trim().min(1).max(80);

/** Учётная запись agent_bot для имени токена: одна на имя, создаётся при первом выпуске. */
export async function ensureAgentBot(tokenName: string): Promise<{ userId: string }> {
  const parsed = nameInput.safeParse(tokenName);
  if (!parsed.success) throw new HduError('invalid_input');
  const { userId } = await ensureAgentBotTx(parsed.data);
  return { userId };
}
