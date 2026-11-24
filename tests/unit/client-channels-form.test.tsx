import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { ClientChannelsForm, type ClientChannelsLabels } from '@/ui/components/ClientChannelsForm';

// Таблица каналов клиента: подсказка под таблицей называет настоящую причину, по которой Telegram не действует
// (итоговая проверка M4b, мелкое 3).

const labels: ClientChannelsLabels = {
  title: 'Уведомления',
  intro: 'Куда присылать',
  kind: 'О чём',
  email: 'Почта',
  telegram: 'Telegram',
  ownRule: 'Правило',
  telegramMissing: 'Telegram не привязан.',
  telegramBlocked: 'Бот заблокирован в Telegram.',
  telegramLink: 'Перейти к привязке',
  needTelegram: 'Нужен Telegram',
  ownFallback: 'Письма снова приходят',
  save: 'Сохранить',
  saved: 'Сохранено',
};

const render = (telegram: { active: boolean; blocked: boolean; linkHref: string } | null) =>
  renderToStaticMarkup(
    <ClientChannelsForm
      rows={[{ key: 'own', label: 'О своих', email: true, telegram: true }]}
      labels={labels}
      telegram={telegram}
      status={null}
      ownFallback={false}
      save={async () => {}}
    />,
  );

test('бот заблокирован: подсказка говорит о блокировке, а не "Telegram не привязан"', () => {
  const html = render({ active: false, blocked: true, linkHref: '#telegram' });
  expect(html).toContain(labels.telegramBlocked);
  expect(html).not.toContain(labels.telegramMissing);
  expect(html).toContain('href="#telegram"');
});

test('Telegram не привязан: прежняя подсказка; привязан и действует: подсказки нет', () => {
  const missing = render({ active: false, blocked: false, linkHref: '#telegram' });
  expect(missing).toContain(labels.telegramMissing);
  expect(missing).not.toContain(labels.telegramBlocked);
  const active = render({ active: true, blocked: false, linkHref: '#telegram' });
  expect(active).not.toContain(labels.telegramMissing);
  expect(active).not.toContain(labels.telegramBlocked);
});
