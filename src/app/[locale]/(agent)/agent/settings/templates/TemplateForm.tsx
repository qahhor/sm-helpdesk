import { getTranslations } from 'next-intl/server';
import type { ModuleOption, ReplyTemplate } from '@/modules/hdr/api';
import { Button } from '@/ui/components/button';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { Select } from '@/ui/components/select';
import { Textarea } from '@/ui/components/textarea';
import { saveTemplateAction } from './actions';

// Форма шаблона ответа (FR-AG-06): код после "/", название, текст на трёх языках портала, модуль, включён ли.
// Новый шаблон и правка существующего одной формой: правка несёт идентификатор.

export async function TemplateForm({ template, modules }: { template: ReplyTemplate | null; modules: ModuleOption[] }) {
  const t = await getTranslations('agent.settings.templates');
  const id = template?.templateId ?? 'new';
  return (
    <form action={saveTemplateAction} className="flex flex-col gap-3">
      {template && <input type="hidden" name="templateId" value={template.templateId} />}
      <div className="grid gap-3 tablet:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`tpl-${id}-shortcut`}>{t('shortcut')}</Label>
          <Input id={`tpl-${id}-shortcut`} name="shortcut" required maxLength={40} defaultValue={template?.shortcut ?? ''} aria-describedby={`tpl-${id}-hint`} />
          <p id={`tpl-${id}-hint`} className="text-xs text-muted-foreground">
            {t('shortcutHint')}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`tpl-${id}-title`}>{t('name')}</Label>
          <Input id={`tpl-${id}-title`} name="title" required maxLength={120} defaultValue={template?.title ?? ''} />
        </div>
      </div>
      {(['ru', 'uz', 'en'] as const).map((locale) => (
        <div key={locale} className="flex flex-col gap-1">
          <Label htmlFor={`tpl-${id}-${locale}`}>{t(`body.${locale}`)}</Label>
          <Textarea
            id={`tpl-${id}-${locale}`}
            name={`body${locale === 'ru' ? 'Ru' : locale === 'uz' ? 'Uz' : 'En'}`}
            required={locale === 'ru'}
            maxLength={10000}
            defaultValue={template?.body[locale] ?? ''}
          />
        </div>
      ))}
      <div className="flex flex-col gap-1">
        <Label htmlFor={`tpl-${id}-module`}>{t('module')}</Label>
        <Select id={`tpl-${id}-module`} name="moduleId" defaultValue={template?.moduleId ?? ''}>
          <option value="">{t('anyModule')}</option>
          {modules.map((m) => (
            <option key={m.moduleId} value={m.moduleId}>
              {m.name}
            </option>
          ))}
        </Select>
      </div>
      <label className="inline-flex min-h-control items-center gap-3 text-sm">
        <input type="checkbox" name="isEnabled" defaultChecked={template?.isEnabled ?? true} className="size-5 accent-primary" />
        {t('enabled')}
      </label>
      <Button type="submit" className="self-end">
        {template ? t('save') : t('create')}
      </Button>
    </form>
  );
}
