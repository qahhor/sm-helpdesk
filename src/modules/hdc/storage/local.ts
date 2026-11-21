import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { problemResponse } from '../util';
import { assertKey, contentDisposition, type Storage, UPLOAD_LINK_TTL_SEC } from './types';

// Локальная заглушка хранилища для машины разработчика (решение 0027): файлы в каталоге, ссылки ведут
// на обработчик портала /api/uploads/local и подписаны HMAC. Работает только с адресом портала на localhost.

export const LOCAL_STORAGE_PATH = '/api/uploads/local';

export type LocalGrant =
  | { op: 'put'; key: string; mime: string; size: number }
  | { op: 'get'; key: string; disposition: 'attachment' | 'inline'; name: string };

export interface LocalStorage extends Storage {
  /** Запись файла обработчиком загрузки после проверки ссылки. */
  write(key: string, bytes: Uint8Array): Promise<void>;
}

export interface LocalOptions {
  dir: string;
  baseUrl: string;
  secret: string;
  now?: () => Date;
}

const sign = (secret: string, fields: readonly string[]) => createHmac('sha256', secret).update(fields.join('\n')).digest('hex');
const fieldsOf = (grant: LocalGrant, exp: string) =>
  grant.op === 'put' ? ['put', grant.key, grant.mime, String(grant.size), exp] : ['get', grant.key, grant.disposition, grant.name, exp];

function signedUrl(opts: LocalOptions, grant: LocalGrant, ttlSeconds: number): string {
  const exp = String(Math.floor((opts.now ?? (() => new Date()))().getTime() / 1000) + ttlSeconds);
  const url = new URL(LOCAL_STORAGE_PATH, opts.baseUrl);
  for (const [name, value] of Object.entries(grant)) url.searchParams.set(name, String(value));
  url.searchParams.set('exp', exp);
  url.searchParams.set('sig', sign(opts.secret, fieldsOf(grant, exp)));
  return url.toString();
}

/** Разрешение из подписанной ссылки или null: подпись не сошлась, срок вышел или поля неверны. */
export function verifyLocalUrl(params: URLSearchParams, secret: string, now: Date): LocalGrant | null {
  const exp = params.get('exp') ?? '';
  const sig = params.get('sig') ?? '';
  const key = params.get('key') ?? '';
  if (!/^\d{1,12}$/.test(exp) || Number(exp) < Math.floor(now.getTime() / 1000) || !/^[0-9a-f]{64}$/.test(sig)) return null;
  try {
    assertKey(key);
  } catch {
    return null;
  }
  let grant: LocalGrant;
  const op = params.get('op');
  if (op === 'put') {
    const mime = params.get('mime') ?? '';
    const size = params.get('size') ?? '';
    if (!mime || mime.length > 127 || !/^[1-9]\d{0,11}$/.test(size)) return null;
    grant = { op, key, mime, size: Number(size) };
  } else if (op === 'get') {
    const disposition = params.get('disposition');
    const name = params.get('name') ?? '';
    if ((disposition !== 'attachment' && disposition !== 'inline') || !name || name.length > 255) return null;
    grant = { op, key, disposition, name };
  } else return null;
  const expected = Buffer.from(sign(secret, fieldsOf(grant, exp)), 'hex');
  return timingSafeEqual(expected, Buffer.from(sig, 'hex')) ? grant : null;
}

export function createLocalStorage(opts: LocalOptions): LocalStorage {
  const root = resolve(opts.dir);
  const pathOf = (key: string) => {
    const path = join(root, assertKey(key));
    if (!path.startsWith(root + sep)) throw new Error('хранилище: недопустимый ключ');
    return path;
  };
  /**
   * Метка версии файла: размер, время изменения и номер узла файловой системы. Запись идёт во временный файл
   * с переименованием поверх прежнего (write), поэтому у каждой записи свой узел: подмену того же размера в тот же
   * тик часов метка всё равно отличает, а читатель прежней версии дочитывает её целиком.
   */
  const etagOf = async (key: string) => {
    const info = await stat(pathOf(key), { bigint: true });
    return `${info.size}-${info.mtimeNs}-${info.ino}`;
  };
  const sizeOf = async (key: string) => {
    try {
      return (await stat(pathOf(key))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };

  return {
    async presignUpload(key, mime, size) {
      return { url: signedUrl(opts, { op: 'put', key: assertKey(key), mime, size }, UPLOAD_LINK_TTL_SEC), headers: { 'Content-Type': mime } };
    },
    async presignDownload(key, filename, ttlSeconds, inline = false) {
      return signedUrl(opts, { op: 'get', key: assertKey(key), disposition: inline ? 'inline' : 'attachment', name: filename }, ttlSeconds);
    },
    async head(key) {
      const size = await sizeOf(key);
      return size === null ? null : { size };
    },
    async move(fromKey, toKey, ifMatch) {
      if (ifMatch !== undefined && (await etagOf(fromKey)) !== ifMatch) throw new Error('хранилище: файл изменился после чтения');
      const target = pathOf(toKey);
      await mkdir(dirname(target), { recursive: true });
      await rename(pathOf(fromKey), target);
    },
    async stream(key) {
      if ((await sizeOf(key)) === null) throw new Error('хранилище: объекта нет');
      const etag = await etagOf(key);
      return { body: Readable.toWeb(createReadStream(pathOf(key))) as ReadableStream<Uint8Array>, etag };
    },
    async remove(key) {
      await rm(pathOf(key), { force: true });
    },
    async write(key, bytes) {
      const target = pathOf(key);
      await mkdir(dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.part`;
      await writeFile(temp, bytes);
      await rename(temp, target);
    },
  };
}

/** Картинки, которые локальное хранилище показывает на странице. Остальное отдаётся как поток байт на скачивание. */
const INLINE_TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** Тело запроса ровно в size байт или null: больше или меньше заявленного. */
async function readExactly(request: Request, size: number): Promise<Uint8Array | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(size);
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (read + value.byteLength > size) {
      await reader.cancel().catch(() => {});
      return null;
    }
    bytes.set(value, read);
    read += value.byteLength;
  }
  return read === size ? bytes : null;
}

/**
 * Обработчик /api/uploads/local: PUT кладёт файл по подписанной ссылке, GET отдаёт его. Тип и размер
 * сверяются с подписанными, как это делает R2. Выключенный (не local или не localhost) отвечает 404.
 */
export function createLocalHandler(opts: { storage: LocalStorage; secret: string; enabled: boolean; now?: () => Date }) {
  return async (request: Request): Promise<Response> => {
    if (!opts.enabled) return problemResponse(404, 'not_found');
    const grant = verifyLocalUrl(new URL(request.url).searchParams, opts.secret, (opts.now ?? (() => new Date()))());
    if (request.method === 'PUT') {
      if (grant?.op !== 'put') return problemResponse(403, 'forbidden');
      if (request.headers.get('content-type') !== grant.mime) return problemResponse(400, 'invalid_input');
      const bytes = await readExactly(request, grant.size);
      if (!bytes) return problemResponse(400, 'invalid_input');
      await opts.storage.write(grant.key, bytes);
      return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
    }
    if (request.method !== 'GET') return problemResponse(405, 'method_not_allowed');
    if (grant?.op !== 'get') return problemResponse(403, 'forbidden');
    if (!(await opts.storage.head(grant.key))) return problemResponse(404, 'not_found');
    const ext = grant.name.toLowerCase().split('.').pop() ?? '';
    const type = grant.disposition === 'inline' ? INLINE_TYPES[ext] : undefined;
    return new Response((await opts.storage.stream(grant.key)).body, {
      headers: {
        'Content-Type': type ?? 'application/octet-stream',
        'Content-Disposition': contentDisposition(type ? 'inline' : 'attachment', grant.name),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'no-store',
      },
    });
  };
}
