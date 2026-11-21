import { createServer, type Server, type Socket } from 'node:net';

// Ложный clamd для тестов протокола (раздел 11.11): команда zINSTREAM, куски с длиной в 4 байта, ноль в конце.
// Режимы: ok (ищет строку EICAR и отвечает FOUND), drop (рвёт соединение после команды), silent (молчит).

export type FakeClamdMode = 'ok' | 'drop' | 'silent';

export interface FakeClamd {
  port: number;
  /** Размеры принятых кусков по порядку. */
  chunkSizes: number[];
  /** Сколько байт принято в последнем сеансе. */
  received: () => number;
  setMode(mode: FakeClamdMode): void;
  close(): Promise<void>;
}

const COMMAND = Buffer.from('zINSTREAM\0');
const EICAR_MARK = Buffer.from(['EICAR', 'STANDARD', 'ANTIVIRUS', 'TEST', 'FILE'].join('-'));

export async function startFakeClamd(): Promise<FakeClamd> {
  let mode: FakeClamdMode = 'ok';
  const chunkSizes: number[] = [];
  let data = Buffer.alloc(0);
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let commandSeen = false;
    data = Buffer.alloc(0);
    socket.on('data', (piece: Buffer) => {
      buffer = Buffer.concat([buffer, piece]);
      if (!commandSeen) {
        if (buffer.length < COMMAND.length) return;
        if (!buffer.subarray(0, COMMAND.length).equals(COMMAND)) return void socket.end('UNKNOWN COMMAND\0');
        buffer = buffer.subarray(COMMAND.length);
        commandSeen = true;
        if (mode === 'drop') return void socket.destroy();
      }
      for (;;) {
        if (buffer.length < 4) return;
        const size = buffer.readUInt32BE(0);
        if (size === 0) {
          buffer = buffer.subarray(4);
          if (mode === 'silent') return;
          socket.end(data.includes(EICAR_MARK) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
          return;
        }
        if (buffer.length < 4 + size) return;
        chunkSizes.push(size);
        data = Buffer.concat([data, buffer.subarray(4, 4 + size)]);
        buffer = buffer.subarray(4 + size);
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake clamd: нет порта');
  return {
    port: address.port,
    chunkSizes,
    received: () => data.length,
    setMode: (next) => void (mode = next),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Тестовый файл EICAR, собранный из частей: исходник теста сам не похож на вирус для антивируса машины. */
export const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE', '!$H+H*'].join('');
