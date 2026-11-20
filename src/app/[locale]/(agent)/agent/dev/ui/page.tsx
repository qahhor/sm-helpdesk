import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { getEnv } from '@/env';
import type { Locale } from '@/i18n/locales';
import { localeNames } from '@/i18n/messages';
import { Logo } from '@/ui/brand/Logo';
import { TezMark } from '@/ui/brand/TezMark';
import { Button } from '@/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/card';
import { EmptyState } from '@/ui/components/EmptyState';
import { Input } from '@/ui/components/input';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/ui/components/sheet';
import { Skeleton } from '@/ui/components/skeleton';
import { StatusLabel, type StatusTone } from '@/ui/components/StatusLabel';
import { LanguageSwitcher } from '@/ui/LanguageSwitcher';
import { showcaseEnabled } from '@/ui/showcase';
import { ThemeSwitch } from '@/ui/theme/ThemeSwitch';

// Витрина компонентов: все базовые компоненты в зоне рабочего места и в зоне клиента.
// Открыта только при HUB_SHOWCASE=1 (docs/decisions/0008-showcase-flag.md).
// Подписи разделов написаны для разработчиков и не переводятся, образцы текста взяты из сообщений.

type Zone = 'agent' | 'client';

const LABEL_TONES: [StatusTone, string][] = [
  ['gray', 'Черновик'],
  ['green', 'Новое'],
  ['orange', 'В работе'],
  ['purple', 'Ждём ответа'],
  ['blue', 'Передано'],
  ['teal', 'Решено'],
  ['danger', 'Срок вышел'],
];

const TEXT_SAMPLES = [
  ['ru', 'Обращение создано. Ответим сегодня до 12:05.'],
  ['uz', "Oʻzbek tili: gʻoya, yoʻnalish, maʼlumot. Ўзбек тили: қ, ғ, ҳ, ў."],
  ['kk', 'Қазақ тілі: ә, ң, ө, ұ, ү, һ, і.'],
  ['tr', 'Türkçe: ğ, İ, ı, ş, ç, ö, ü.'],
] as const;

export default async function ShowcasePage({ searchParams }: PageProps<'/[locale]/agent/dev/ui'>) {
  if (!showcaseEnabled(getEnv())) notFound();
  const only = (await searchParams).section;
  const t = await getTranslations();
  const names = await localeNames();
  const locale = (await getLocale()) as Locale;
  const themeLabels = {
    label: t('common.theme.label'),
    light: t('common.theme.light'),
    dark: t('common.theme.dark'),
    system: t('common.theme.system'),
  };

  const sections: { id: string; title: string; body: (zone: Zone) => ReactNode }[] = [
    {
      id: 'buttons',
      title: 'Кнопки',
      body: () => (
        <div className="flex flex-wrap items-center gap-3">
          <Button>{t('client.home.report')}</Button>
          <Button variant="secondary">{t('client.home.idea')}</Button>
          <Button variant="ghost">{t('common.notFound.home')}</Button>
          <Button variant="danger">{t('client.home.report')}</Button>
          <Button size="small">{t('client.nav.tickets')}</Button>
          <Button disabled>{t('client.nav.ideas')}</Button>
        </div>
      ),
    },
    {
      id: 'labels',
      title: 'Метки статусов',
      body: () => (
        <div className="flex flex-wrap items-center gap-2">
          {LABEL_TONES.map(([tone, text]) => (
            <StatusLabel key={tone} tone={tone}>
              {text}
            </StatusLabel>
          ))}
        </div>
      ),
    },
    {
      id: 'input',
      title: 'Поле ввода',
      body: (zone) => (
        <div className="flex flex-col gap-3">
          <Input aria-label={`${t('client.home.title')} (${zone})`} placeholder={t('client.home.title')} />
          <Input aria-label={`${t('client.nav.profile')} (${zone})`} defaultValue="SUP-1042" aria-invalid />
        </div>
      ),
    },
    {
      id: 'card',
      title: 'Карточка',
      body: () => (
        <Card>
          <CardHeader>
            <CardTitle>{t('client.nav.tickets')}</CardTitle>
          </CardHeader>
          <CardContent className="text-secondary-foreground">{t('client.tickets.empty')}</CardContent>
        </Card>
      ),
    },
    {
      id: 'menu',
      title: 'Выпадающее меню',
      body: () => (
        <div className="flex items-center gap-2">
          <LanguageSwitcher locale={locale} names={names} label={t('common.language.label')} />
          <ThemeSwitch labels={themeLabels} />
        </div>
      ),
    },
    {
      id: 'sheet',
      title: 'Нижний лист',
      body: () => (
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="secondary" className="self-start">
              {t('client.nav.profile')}
            </Button>
          </SheetTrigger>
          <SheetContent closeLabel={t('common.close')}>
            <SheetTitle>{t('client.nav.profile')}</SheetTitle>
            <SheetDescription>{t('client.tickets.empty')}</SheetDescription>
          </SheetContent>
        </Sheet>
      ),
    },
    {
      id: 'skeleton',
      title: 'Скелетон',
      body: () => (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-row w-full" />
          <Skeleton className="h-row w-2/3" />
        </div>
      ),
    },
    {
      id: 'empty-state',
      title: 'Пустое состояние',
      // Крупный Тез на экране один, поэтому он показан только в зоне клиента.
      body: (zone) => (
        <Card>
          <EmptyState
            withTez={zone === 'client'}
            title={t('client.nav.tickets')}
            text={t('client.tickets.empty')}
            action={<Button>{t('client.home.report')}</Button>}
          />
        </Card>
      ),
    },
    {
      id: 'brand',
      title: 'Логотип и значок Теза',
      body: () => (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-4">
            <Logo withProductName />
            <TezMark size={24} />
            <TezMark size={40} />
          </div>
          <div className="flex items-center gap-4 rounded-control bg-header p-3 text-header-foreground">
            <Logo onDark withProductName />
            <TezMark size={24} onDark />
            <TezMark size={40} onDark />
          </div>
        </div>
      ),
    },
    {
      id: 'text',
      title: 'Образец текста',
      body: () => (
        <div className="flex flex-col gap-2">
          {TEXT_SAMPLES.map(([lang, text]) => (
            <p key={lang} lang={lang}>
              {text}
            </p>
          ))}
          <p className="text-muted-foreground">1 250 000 сум, 10.11.2026</p>
        </div>
      ),
    },
  ];

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 p-6">
      <h1 className="text-2xl font-bold">Витрина компонентов</h1>
      {sections
        .filter((section) => !only || section.id === only)
        .map((section) => (
          <section key={section.id} id={section.id} className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">{section.title}</h2>
            <div className="grid gap-4 laptop:grid-cols-2">
              {(['agent', 'client'] as const).map((zone) => (
                <div
                  key={zone}
                  data-zone={zone === 'client' ? 'client' : undefined}
                  className="flex flex-col gap-2 rounded-card border border-border bg-background p-4 text-base"
                >
                  <p className="text-xs font-semibold text-muted-foreground">
                    {zone === 'agent' ? 'Рабочее место' : 'Кабинет клиента'}
                  </p>
                  {section.body(zone)}
                </div>
              ))}
            </div>
          </section>
        ))}
    </main>
  );
}
