import { createLocalJWKSet, type JSONWebKeySet } from 'jose';
import type { ContextKeySource } from './core/context-keys';

// Заглушки внешних сервисов модуля hdu для тестов (docs/naming.md, раздел 5). Ключи токена контекста без сети и
// без реестра: открытые ключи из памяти для режима jwks, общий секрет для режима secret.

export function staticContextKeySource(keys: { jwks?: JSONWebKeySet; secret?: string }): ContextKeySource {
  return {
    async keyFor(server) {
      if (server.mode === 'secret') {
        if (!keys.secret) throw new Error('Заглушка ключей: секрет не задан');
        return new TextEncoder().encode(keys.secret);
      }
      if (!keys.jwks) throw new Error('Заглушка ключей: JWKS не задан');
      return createLocalJWKSet(keys.jwks);
    },
  };
}
