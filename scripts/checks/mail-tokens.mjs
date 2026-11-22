// Значения оформления писем совпадают с токенами портала (решение 4 вехи M4).
import { buildMailTokens } from '../gen-mail-tokens.mjs';

/**
 * @param {string} css текст src/ui/tokens.css
 * @param {string} json текст src/modules/hdn/mail/mail-tokens.json
 * @returns {string[]} описание расхождений
 */
export function mailTokensDrift(css, json) {
  let saved;
  try {
    saved = JSON.parse(json);
  } catch {
    return ['mail-tokens.json не разбирается: выполните node scripts/gen-mail-tokens.mjs'];
  }
  const expected = JSON.stringify(buildMailTokens(css));
  return JSON.stringify(saved) === expected ? [] : ['mail-tokens.json не совпадает с src/ui/tokens.css: выполните node scripts/gen-mail-tokens.mjs'];
}
