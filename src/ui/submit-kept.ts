import { type FormEvent, startTransition } from 'react';

/**
 * Отправка формы без сброса полей (проверка интерфейса, U5). Отправку через атрибут action React завершает сбросом
 * формы: после ошибки сервера список и переключатели показывают первое значение, хотя состояние помнит выбранное.
 * Здесь действие useActionState вызывается вручную, и сброса нет. До гидратации форму отправляет браузер через action.
 * Кнопка с атрибутом data-own-action отправляет форму своим действием: её ведёт браузер.
 */
export function submitKept(event: FormEvent<HTMLFormElement>, action: (data: FormData) => void): void {
  const submitter = (event.nativeEvent as SubmitEvent).submitter;
  if (submitter?.hasAttribute('data-own-action')) return;
  event.preventDefault();
  const data = new FormData(event.currentTarget, submitter);
  startTransition(() => action(data));
}
