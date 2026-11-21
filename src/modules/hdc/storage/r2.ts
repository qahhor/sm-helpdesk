import { AwsV4Signer } from 'aws4fetch';
import { assertKey, contentDisposition, type Storage, UPLOAD_LINK_TTL_SEC } from './types';

// Cloudflare R2 по протоколу S3 (решение 0027): подпись SigV4 библиотекой aws4fetch, адреса вида
// {endpoint}/{bucket}/{key}. Ключ доступа в ссылки, ошибки и журнал не попадает: в ссылке только его идентификатор.

export interface R2Options {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Для тестов: запросы к бакету и часы подписи. */
  fetch?: typeof fetch;
  now?: () => Date;
}

export function createR2Storage(opts: R2Options): Storage {
  const send = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  const urlOf = (key: string) => new URL(`${opts.endpoint}/${opts.bucket}/${assertKey(key)}`);

  const sign = (method: string, url: URL, headers: Record<string, string>, signQuery: boolean) =>
    new AwsV4Signer({
      method,
      url: url.toString(),
      headers,
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      service: 's3',
      region: 'auto',
      datetime: now().toISOString().replace(/[:-]|\.\d{3}/g, ''),
      signQuery,
      // В подписанной ссылке подписываются и тип с размером: aws4fetch по умолчанию их пропускает.
      allHeaders: signQuery,
    }).sign();

  async function call(method: string, key: string, headers: Record<string, string> = {}): Promise<Response> {
    const signed = await sign(method, urlOf(key), headers, false);
    return send(signed.url, { method, headers: signed.headers });
  }

  async function fail(op: string, response: Response): Promise<never> {
    await response.body?.cancel().catch(() => {});
    throw new Error(`хранилище R2: ${op} ответило ${response.status}`);
  }

  return {
    async presignUpload(key, mime, size) {
      const url = urlOf(key);
      url.searchParams.set('X-Amz-Expires', String(UPLOAD_LINK_TTL_SEC));
      const signed = await sign('PUT', url, { 'Content-Type': mime, 'Content-Length': String(size) }, true);
      return { url: signed.url.toString(), headers: { 'Content-Type': mime } };
    },

    async presignDownload(key, filename, ttlSeconds, inline = false) {
      const url = urlOf(key);
      url.searchParams.set('X-Amz-Expires', String(ttlSeconds));
      url.searchParams.set('response-content-disposition', contentDisposition(inline ? 'inline' : 'attachment', filename));
      return (await sign('GET', url, {}, true)).url.toString();
    },

    async head(key) {
      const response = await call('HEAD', key);
      if (response.status === 404) return null;
      if (!response.ok) return fail('HEAD', response);
      return { size: Number(response.headers.get('content-length')) };
    },

    async move(fromKey, toKey, ifMatch) {
      const copied = await call('PUT', toKey, {
        'x-amz-copy-source': `/${opts.bucket}/${assertKey(fromKey)}`,
        // Подменённый после чтения объект не копируется: R2 отвечает 412.
        ...(ifMatch ? { 'x-amz-copy-source-if-match': ifMatch } : {}),
      });
      if (!copied.ok) return fail('COPY', copied);
      await copied.body?.cancel().catch(() => {});
      await this.remove(fromKey);
    },

    async stream(key) {
      const response = await call('GET', key);
      if (!response.ok || !response.body) return fail('GET', response);
      return { body: response.body, etag: response.headers.get('etag') ?? '' };
    },

    async remove(key) {
      const response = await call('DELETE', key);
      if (!response.ok && response.status !== 404) return fail('DELETE', response);
      await response.body?.cancel().catch(() => {});
    },
  };
}
