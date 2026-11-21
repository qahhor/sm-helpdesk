import { connect, type Socket } from 'node:net';
import type { AntivirusScanner } from './types';

// ClamAV по его протоколу (решение 0027, без пакета): команда zINSTREAM, затем куски с длиной в 4 байта
// (порядок байт сетевой), пустой кусок в конце. Ответ "stream: OK" или "stream: <подпись> FOUND" и ноль.

/** Предел куска: значение StreamMaxLength у clamd больше, но крупные куски не дают выигрыша. */
export const CLAMAV_CHUNK_BYTES = 64 * 1024;

export interface ClamavOptions {
  host: string;
  port: number;
  /** Тайм-аут на всю проверку: по умолчанию 30 секунд. */
  timeoutMs?: number;
}

const fail = (reason: string) => new Error(`ClamAV: ${reason}`);

function write(socket: Socket, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (error) => (error ? reject(fail('ошибка записи')) : resolve()));
  });
}

export function createClamavScanner(opts: ClamavOptions): AntivirusScanner {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return {
    async scan(stream) {
      const socket = connect({ host: opts.host, port: opts.port });
      const reader = stream.getReader();
      let reply = '';
      const done = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy();
          reject(fail('нет ответа за отведённое время'));
        }, timeoutMs);
        socket.setEncoding('utf8');
        socket.on('data', (piece: string) => {
          reply += piece;
          if (reply.includes('\0')) {
            clearTimeout(timer);
            socket.end();
            resolve(reply.slice(0, reply.indexOf('\0')));
          }
        });
        socket.on('error', () => {
          clearTimeout(timer);
          reject(fail('соединение не удалось'));
        });
        socket.on('close', () => {
          clearTimeout(timer);
          reject(fail('соединение закрыто без ответа'));
        });
      });
      // Ошибка ожидания ответа не должна стать необработанной, пока поток ещё пишется.
      done.catch(() => {});
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('error', () => reject(fail('соединение не удалось')));
        });
        await write(socket, new TextEncoder().encode('zINSTREAM\0'));
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          for (let offset = 0; offset < value.byteLength; offset += CLAMAV_CHUNK_BYTES) {
            const piece = value.subarray(offset, offset + CLAMAV_CHUNK_BYTES);
            const frame = new Uint8Array(4 + piece.byteLength);
            new DataView(frame.buffer).setUint32(0, piece.byteLength);
            frame.set(piece, 4);
            await write(socket, frame);
          }
        }
        await write(socket, new Uint8Array(4));
      } catch (error) {
        await reader.cancel().catch(() => {});
        socket.destroy();
        // Сервер закрыл соединение, пока писали: причину скажет ожидание ответа.
        await done;
        throw error;
      }
      const answer = (await done).trim();
      if (answer === 'stream: OK') return { clean: true };
      const found = /^stream: (.+) FOUND$/.exec(answer);
      if (found?.[1]) return { clean: false, signature: found[1].slice(0, 200) };
      throw fail('неожиданный ответ');
    },
  };
}
