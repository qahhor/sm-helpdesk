import 'server-only';

// Модуль hdt, слой api: сообщение рассылки по известной проблеме (план M5c, задача 5). Узкий файл без страниц: его тянет
// фоновый процесс. Модуль проблем вызывает функции внутри транзакции своей задачи.

export { broadcastDeliveredTx, type ProblemMessageInput, type ProblemMessageResult, postProblemMessageTx } from '../core/problem-messages';
