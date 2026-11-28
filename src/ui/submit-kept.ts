import { type FormEvent, startTransition } from 'react';

/**
 * Отправка формы без сброса полей (проверка интерфейса, U5). Отправку через атрибут action React завершает сбросом
 * формы: после ошибки сервера список и переключатели показывают первое значение, хотя состояние помнит выбранное.
 * Здесь действие useActionState вызывается вручную, и сброса нет. До гидратации форму отправляет браузер через action.
 * Отправка формы, в том числе неявная (Enter в поле), всегда идёт в действие самой формы. Кнопке с другим действием
 * нужен type="button" и вызов по нажатию: кнопка отправки с formAction, стоящая в разметке первой, перехватывала
 * Enter (проверка интерфейса, второй проход, F1).
 */
export function submitKept(event: FormEvent<HTMLFormElement>, action: (data: FormData) => void): void {
  const submitter = (event.nativeEvent as SubmitEvent).submitter;
  event.preventDefault();
  const data = new FormData(event.currentTarget, submitter);
  startTransition(() => action(data));
}
