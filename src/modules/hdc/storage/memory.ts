import { assertKey, contentDisposition, type DownloadOptions, type MoveOptions, type Storage } from './types';

// Хранилище в памяти для тестов (CLAUDE.md: интерфейс, настоящая реализация и заглушка).

export class MemoryStorage implements Storage {
  readonly objects = new Map<string, Uint8Array>();
  /** Тип, который получил объект при переносе: метаданные копии задаёт портал. */
  readonly contentTypes = new Map<string, string>();
  /** Версия объекта: растёт при каждой записи, служит меткой ETag. */
  private readonly versions = new Map<string, number>();
  private version = 0;
  /** Выданные ссылки на загрузку. */
  readonly presigned: { key: string; mime: string; size: number }[] = [];

  /** Файл, который "загрузил браузер". */
  put(key: string, bytes: Uint8Array): void {
    this.objects.set(assertKey(key), bytes);
    this.versions.set(key, ++this.version);
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  async presignUpload(key: string, mime: string, size: number) {
    this.presigned.push({ key: assertKey(key), mime, size });
    return { url: `https://storage.test/${key}?op=put`, headers: { 'Content-Type': mime } };
  }

  async presignDownload(key: string, { filename, contentType, ttlSeconds, inline = false }: DownloadOptions) {
    const params = new URLSearchParams({ disposition: contentDisposition(inline ? 'inline' : 'attachment', filename), type: contentType, ttl: String(ttlSeconds) });
    return `https://storage.test/${assertKey(key)}?${params}`;
  }

  async head(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? { size: bytes.byteLength } : null;
  }

  async move(fromKey: string, toKey: string, { contentType, ifMatch }: MoveOptions) {
    const bytes = this.objects.get(fromKey);
    if (!bytes) throw new Error('хранилище: объекта нет');
    if (ifMatch !== undefined && ifMatch !== String(this.versions.get(fromKey))) throw new Error('хранилище: объект изменился после чтения');
    this.put(toKey, bytes);
    this.contentTypes.set(toKey, contentType);
    this.objects.delete(fromKey);
    this.versions.delete(fromKey);
  }

  async stream(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error('хранилище: объекта нет');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    return { body, etag: String(this.versions.get(key)) };
  }

  async remove(key: string) {
    this.objects.delete(key);
    this.versions.delete(key);
  }
}
