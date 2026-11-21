import type { AntivirusScanner } from './types';

// Заглушка антивируса для машины разработчика и тестов (решение 0027): находит тестовую строку EICAR.
// Сама строка собрана из частей, чтобы исходник не принял за вирус антивирус машины.

const MARK = new TextEncoder().encode(['EICAR', 'STANDARD', 'ANTIVIRUS', 'TEST', 'FILE'].join('-'));

export function createStubScanner(): AntivirusScanner {
  return {
    async scan(stream) {
      const reader = stream.getReader();
      // Хвост предыдущего куска: строка может прийти разорванной.
      let tail = new Uint8Array(0);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return { clean: true };
        const window = new Uint8Array(tail.byteLength + value.byteLength);
        window.set(tail);
        window.set(value, tail.byteLength);
        if (Buffer.from(window).includes(Buffer.from(MARK))) {
          await reader.cancel().catch(() => {});
          return { clean: false, signature: 'Eicar-Test-Signature' };
        }
        tail = window.subarray(Math.max(0, window.byteLength - MARK.byteLength + 1));
      }
    },
  };
}
