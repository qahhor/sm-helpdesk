import 'server-only';
import { getTranslations } from 'next-intl/server';
import type { ServerFormLabels } from './ServerForm';

/** Подписи формы сервера на языке страницы. В режиме изменения подсказка секрета говорит, что он задан. */
export async function serverFormLabels(mode: 'new' | 'edit'): Promise<ServerFormLabels> {
  const t = await getTranslations('agent.settings.servers');
  const f = (key: string) => t(`fields.${key}`);
  return {
    code: f('code'),
    codeHint: f('codeHint'),
    name: f('name'),
    baseUrl: f('baseUrl'),
    baseUrlHint: f('baseUrlHint'),
    issuer: f('issuer'),
    issuerHint: f('issuerHint'),
    clientId: f('clientId'),
    clientSecret: f('clientSecret'),
    clientSecretHint: mode === 'new' ? f('clientSecretHint') : f('clientSecretSetHint'),
    isDefault: f('isDefault'),
    roleMap: f('roleMap'),
    roleMapHint: f('roleMapHint'),
    endpoints: f('endpoints'),
    endpointsHint: f('endpointsHint'),
    authorization: f('authorization'),
    token: f('token'),
    userinfo: f('userinfo'),
    jwks: f('jwks'),
    save: t('save'),
    reauth: t('reauth'),
  };
}
