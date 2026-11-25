import 'server-only';
import { getTranslations } from 'next-intl/server';
import type { ServerFormLabels } from './ServerForm';
import type { WidgetFormLabels } from './WidgetForm';

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

/** Подписи формы виджета сервера на языке страницы (план M6, задача 1). */
export async function widgetFormLabels(): Promise<WidgetFormLabels> {
  const t = await getTranslations('agent.settings.servers');
  const w = (key: string) => t(`widget.${key}`);
  return {
    mode: w('mode'),
    modeHint: w('modeHint'),
    modes: { none: w('modes.none'), jwks: w('modes.jwks'), secret: w('modes.secret') },
    contextIssuer: w('contextIssuer'),
    contextIssuerHint: w('contextIssuerHint'),
    jwksUrl: w('jwksUrl'),
    jwksUrlHint: w('jwksUrlHint'),
    embedOrigins: w('embedOrigins'),
    embedOriginsHint: w('embedOriginsHint'),
    save: w('save'),
    saved: w('saved'),
    secret: w('secret'),
    secretSet: w('secretSet'),
    secretMissing: w('secretMissing'),
    secretShownTitle: w('secretShownTitle'),
    secretShownText: w('secretShownText'),
    rotate: w('rotate'),
    rotateHint: w('rotateHint'),
    copy: w('copy'),
    copied: w('copied'),
    reauth: t('reauth'),
  };
}
