import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { formatDate } from '@/i18n/format';
import type { Locale } from '@/i18n/locales';
import { getPolicy, type PolicyBlock } from '@/modules/hdc/api';
import { Card, CardContent } from '@/ui/components/card';

type Group = { kind: 'h1' | 'h2' | 'p'; text: string } | { kind: 'list'; items: string[] };

/** Соседние пункты собираются в один список. */
function groups(blocks: PolicyBlock[]): Group[] {
  const result: Group[] = [];
  for (const block of blocks) {
    const last = result.at(-1);
    if (block.kind !== 'li') result.push({ kind: block.kind, text: block.text });
    else if (last?.kind === 'list') last.items.push(block.text);
    else result.push({ kind: 'list', items: [block.text] });
  }
  return result;
}

// Политика обработки данных (раздел 14.6 ТЗ). Текст из файлов content/legal/, выводится как текст:
// разметка не разбирается. Пока политика не утверждена, страницы нет (404).
export default async function PrivacyPage() {
  const locale = (await getLocale()) as Locale;
  const policy = await getPolicy(locale);
  if (!policy) notFound();
  const t = await getTranslations('common.legal');
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-6">
        {policy.locale !== locale && <p className="text-sm text-secondary-foreground">{t('translationMissing')}</p>}
        <p className="text-sm text-secondary-foreground">{t('version', { date: formatDate(new Date(`${policy.version}T00:00:00Z`), locale, 'UTC') })}</p>
        {groups(policy.blocks).map((group, index) => {
          const key = `${index}-${group.kind}`;
          if (group.kind === 'list')
            return (
              <ul key={key} className="flex list-disc flex-col gap-1 ps-6">
                {group.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{item}</li>
                ))}
              </ul>
            );
          if (group.kind === 'h1') return <h1 key={key} className="text-2xl font-bold">{group.text}</h1>;
          if (group.kind === 'h2') return <h2 key={key} className="pt-2 text-lg font-semibold">{group.text}</h2>;
          return <p key={key}>{group.text}</p>;
        })}
      </CardContent>
    </Card>
  );
}
