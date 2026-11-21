// Проверка файла на вирусы (раздел 11.11): интерфейс, общий для ClamAV и заглушки.

export interface AntivirusScanner {
  /** Проверяет поток целиком. Нет ответа или ошибка протокола: исключение, задача остаётся на повтор. */
  scan(stream: ReadableStream<Uint8Array>): Promise<{ clean: boolean; signature?: string }>;
}
