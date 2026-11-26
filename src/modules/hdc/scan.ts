import 'server-only';
import { createHash } from 'node:crypto';
import { getScanner } from './antivirus';
import { sniffFileType, SNIFF_BYTES } from './filetype';
import { getStorage } from './storage';

// Модуль hdc: проверка изображения из карантина (решение 0027; изображения решений M5 и идей M7). Один порядок для
// всех: настоящий тип по первым байтам, затем антивирус по тому же чтению, перенос из карантина в постоянный ключ
// только прочитанной версии (ifMatch). Принимаются только PNG, JPEG и WebP с заявленным типом. Запись итога в свою
// таблицу делает модуль-владелец файла: здесь только хранилище и антивирус.

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export type QuarantineResult =
  | { scanStatus: 'clean'; storageKey: string; sha256?: string }
  | { scanStatus: 'rejected' }
  | { scanStatus: 'infected'; signature: string };

/** Первые bytes байт потока и поток всего файла с теми же байтами в начале: одно чтение объекта. */
async function splitHead(stream: ReadableStream<Uint8Array>, bytes: number): Promise<{ head: Uint8Array; whole: ReadableStream<Uint8Array> }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  let finished = false;
  while (read < bytes) {
    const { done, value } = await reader.read();
    if (done) {
      finished = true;
      break;
    }
    chunks.push(value);
    read += value.byteLength;
  }
  const buffered = new Uint8Array(read);
  let offset = 0;
  for (const chunk of chunks) {
    buffered.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let sentHead = false;
  const whole = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentHead) {
        sentHead = true;
        if (buffered.byteLength > 0) return controller.enqueue(buffered);
      }
      if (finished) return controller.close();
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { head: buffered.subarray(0, bytes), whole };
}

/**
 * Проверяет изображение в карантине и при успехе переносит его в target. Файла в карантине нет, а в target есть:
 * перенос уже был (повтор задачи), итог clean. Нет нигде: rejected. Тип по содержимому не совпал с заявленным, размер
 * не тот или антивирус нашёл заражение: файл удаляется из карантина. Антивирус не ответил: исключение, файл остаётся
 * в карантине, задача повторится.
 */
export async function scanQuarantinedImage(input: { quarantineKey: string; targetKey: string; mime: string; size: number }): Promise<QuarantineResult> {
  const storage = getStorage();
  if (!(await storage.head(input.quarantineKey))) {
    if (await storage.head(input.targetKey)) return { scanStatus: 'clean', storageKey: input.targetKey };
    return { scanStatus: 'rejected' };
  }
  const { body, etag } = await storage.stream(input.quarantineKey);
  const { head, whole } = await splitHead(body, SNIFF_BYTES);
  if (IMAGE_MIME[sniffFileType(head)] !== input.mime) {
    await whole.cancel().catch(() => {});
    await storage.remove(input.quarantineKey);
    return { scanStatus: 'rejected' };
  }
  const hash = createHash('sha256');
  let scanned = 0;
  const hashing = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      hash.update(chunk);
      scanned += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const verdict = await getScanner().scan(whole.pipeThrough(hashing));
  if (!verdict.clean || scanned !== input.size) {
    await storage.remove(input.quarantineKey);
    return verdict.clean ? { scanStatus: 'rejected' } : { scanStatus: 'infected', signature: verdict.signature ?? 'unknown' };
  }
  await storage.move(input.quarantineKey, input.targetKey, { contentType: input.mime, ifMatch: etag });
  return { scanStatus: 'clean', storageKey: input.targetKey, sha256: hash.digest('hex') };
}
