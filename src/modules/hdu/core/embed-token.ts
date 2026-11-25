import { randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import * as z from 'zod';
import { CONTEXT_PLATFORMS, type ContextPlatform, EMBED_AUDIENCE, EMBED_TOKEN_TTL_SEC } from '../pref';

// Токен виджета (план M6, решение 16): HS256 на EMBED_TOKEN_SECRET, получатель hub-embed, издатель адрес портала,
// поля пользователь, организация, сервер, платформа и jti, срок 15 минут. Состояния в базе нет: членство, организацию
// и сервер проверяет requireEmbedActor на каждом запросе. Без базы: секрет и адрес портала приходят параметрами.

export type EmbedClaims = { userId: string; orgId: string; serverId: string; platform: ContextPlatform };

/** Токен не прошёл проверку: подпись, срок, получатель, издатель или поля. Подробностей нет. */
export class EmbedTokenInvalid extends Error {
  constructor() {
    super('Токен виджета не принят');
    this.name = 'EmbedTokenInvalid';
  }
}

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signEmbedToken(claims: EmbedClaims, cfg: { secret: string; issuer: string }, now: Date = new Date()): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ org: claims.orgId, srv: claims.serverId, plt: claims.platform })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(cfg.issuer)
    .setAudience(EMBED_AUDIENCE)
    .setSubject(claims.userId)
    .setJti(randomUUID())
    .setIssuedAt(iat)
    .setExpirationTime(iat + EMBED_TOKEN_TTL_SEC)
    .sign(key(cfg.secret));
}

const embedPayload = z.object({ sub: z.uuid(), org: z.uuid(), srv: z.uuid(), plt: z.enum(CONTEXT_PLATFORMS), jti: z.string().min(1) });

/** Проверяет токен виджета: только HS256 своим секретом, свой издатель и получатель, срок без допуска. */
export async function verifyEmbedToken(token: string, cfg: { secret: string; issuer: string }, now: Date = new Date()): Promise<EmbedClaims> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, key(cfg.secret), {
      algorithms: ['HS256'],
      issuer: cfg.issuer,
      audience: EMBED_AUDIENCE,
      requiredClaims: ['exp', 'iat', 'jti', 'sub'],
      currentDate: now,
    }));
  } catch {
    throw new EmbedTokenInvalid();
  }
  const parsed = embedPayload.safeParse(payload);
  if (!parsed.success) throw new EmbedTokenInvalid();
  return { userId: parsed.data.sub, orgId: parsed.data.org, serverId: parsed.data.srv, platform: parsed.data.plt };
}
