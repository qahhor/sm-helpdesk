import { assertKey, contentDisposition, type Storage } from './types';

// Хранилище в памяти для тестов (CLAUDE.md: интерфейс, настоящая реализация и заглушка).

export class MemoryStorage implements Storage {
  readonly objects = new Map<string, Uint8Array>();
  /** Выданные ссылки на загрузку. */
  readonly presigned: { key: string; mime: string; size: number }[] = [];

  /** Файл, который "загрузил браузер". */
  put(key: string, bytes: Uint8Array): void {
    this.objects.set(assertKey(key), bytes);
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  async presignUpload(key: string, mime: string, size: number) {
    this.presigned.push({ key: assertKey(key), mime, size });
    return { url: `https://storage.test/${key}?op=put`, headers: { 'Content-Type': mime } };
  }

  async presignDownload(key: string, filename: string, ttlSeconds: number, inline = false) {
    const params = new URLSearchParams({ disposition: contentDisposition(inline ? 'inline' : 'attachment', filename), ttl: String(ttlSeconds) });
    return `https://storage.test/${assertKey(key)}?${params}`;
  }

  async head(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? { size: bytes.byteLength } : null;
  }

  async move(fromKey: string, toKey: string) {
    const bytes = this.objects.get(fromKey);
    if (!bytes) throw new Error('хранилище: объекта нет');
    this.objects.set(assertKey(toKey), bytes);
    this.objects.delete(fromKey);
  }

  async stream(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error('хранилище: объекта нет');
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async remove(key: string) {
    this.objects.delete(key);
  }
}
