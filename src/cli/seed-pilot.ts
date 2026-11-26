import type { StaffContext } from '@/modules/hdc/api';
import { moduleCatalog, listAllTemplates, listPlaybooks, listTags, loadSlaConfig, saveCalendar, saveHolidays, savePlaybook, saveSlaPolicy, saveTemplate, createTag, updateTag } from '@/modules/hdr/api';
import { importModules } from '@/modules/hdr/api/import';
import { saveVoteMode, voteMode } from '@/modules/hdi/api/settings';
import { createDraftArticle } from '@/modules/hdk/api/articles';
import { listSolutions } from '@/modules/hdk/api/editor';
import { listStaff, listStaffInvitations, inviteStaffByMail } from '@/modules/hdu/api/staff-manage';
import { mailDelivers } from '@/modules/hdn/api';
import { BUILTIN_RULES, inactiveBuiltinCodes, listRules } from '@/modules/hdw/api/rules';
import { parseSeedFile, type SeedFile } from './seed-pilot-schema';

// Команда hub seed:pilot (план подготовки M9, задача 6, решение 9): начальные данные пилота одним файлом. Команда не пишет
// в таблицы сама: она сверяет файл с тем, что отдают функции модулей, и вызывает функции экранов настроек от имени
// администратора --admin только для записей, которые отличаются. Поэтому повторный запуск ничего не меняет и не пишет в
// журнал аудита. Решения только черновиками: публикует человек (FR-SOL-04). Данных клиентов в файле нет (схема).
//
// Порядок: сначала весь файл проверяется схемой и ссылками на модули, потом сверяется, потом пишется. Ошибка проверки
// ничего не меняет. Каждая запись пишется своей транзакцией функции модуля (решение 0069): сбой базы посреди запуска
// оставляет уже записанное, повторный запуск дописывает остальное.

export type SeedReport = { lines: string[]; changes: number; warnings: string[] };

type Counter = { created: number; changed: number; same: number };
const counter = (): Counter => ({ created: 0, changed: 0, same: 0 });
const same = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]));
  return value;
}
const line = (title: string, c: Counter) => `${title}: создано ${c.created}, изменено ${c.changed}, без изменений ${c.same}.`;

/** Ссылки на модули по коду: модуль должен быть в файле или в справочнике. */
function moduleProblems(file: SeedFile, known: Set<string>): string[] {
  const problems: string[] = [];
  const check = (section: string, items: readonly { module: string | null }[] | undefined) =>
    items?.forEach((item, index) => {
      if (item.module !== null && !known.has(item.module)) problems.push(`${section}, запись ${index + 1}: модуль ${item.module} не найден ни в файле, ни в справочнике`);
    });
  check('templates', file.templates);
  check('playbooks', file.playbooks);
  check('solutions', file.solutions);
  return problems;
}

export async function runSeedPilot(ctx: StaffContext, content: string, opts: { dryRun: boolean }): Promise<{ ok: true; report: SeedReport } | { ok: false; problems: string[] }> {
  const parsed = parseSeedFile(content);
  if (!parsed.ok) return parsed;
  const file = parsed.data;
  const write = !opts.dryRun;
  const lines: string[] = [];
  const warnings: string[] = [];
  let changes = 0;

  // --- Сверка: всё читается до первой записи ---
  const catalog = await moduleCatalog(ctx.actor);
  const known = new Set([...catalog.filter((m) => m.state === 'active').map((m) => m.code), ...(file.modules ?? []).map((m) => m.code)]);
  if (file.modules) for (const m of catalog) if (!file.modules.some((r) => r.code === m.code)) known.delete(m.code);
  const problems = moduleProblems(file, known);
  if (problems.length > 0) return { ok: false, problems };

  // Модули: загрузка целиком, как modules:import, но только если справочник отличается от файла.
  if (file.modules) {
    const byCode = new Map(catalog.map((m) => [m.code, m]));
    let added = 0;
    let updated = 0;
    for (const record of file.modules) {
      const row = byCode.get(record.code);
      if (!row) added++;
      else if (row.state !== 'active' || (row.parentCode ?? null) !== (record.parentCode ?? null) || !same(row.name, record.name) || !same(row.screens, record.screens)) updated++;
    }
    const hidden = catalog.filter((m) => m.state === 'active' && !file.modules?.some((r) => r.code === m.code)).length;
    if (added + updated + hidden > 0) {
      changes += added + updated + hidden;
      if (write) {
        const result = await importModules(ctx.actor, JSON.stringify(file.modules), 'cli');
        if (!result.ok) return { ok: false, problems: result.problems.map((p) => `modules: ${p}`) };
      }
    }
    lines.push(`Модули: добавлено ${added}, изменено ${updated}, скрыто ${hidden}, без изменений ${file.modules.length - added - updated}.`);
  }
  // Идентификаторы модулей после загрузки: шаблоны, памятки и решения ссылаются на модуль кодом.
  const moduleIdOf = async () => new Map((await moduleCatalog(ctx.actor)).map((m) => [m.code, m.moduleId]));
  let ids = await moduleIdOf();
  // В сухом прогоне нового модуля ещё нет: его записи считаются новыми.
  const idOf = (code: string | null) => (code === null ? null : (ids.get(code) ?? `new:${code}`));

  // Сроки и календарь: только то, что задано в файле. Остальное остаётся значениями из кода.
  const sla = await loadSlaConfig(ctx.actor);
  if (file.holidays) {
    const c = counter();
    for (const year of file.holidays) {
      const current = sla.calendar.holidays.filter((date) => date.startsWith(`${year.year}-`)).sort();
      if (same(current, [...year.dates].sort())) c.same++;
      else {
        if (current.length === 0) c.created++;
        else c.changed++;
        if (write) await saveHolidays(ctx, year);
      }
    }
    changes += c.created + c.changed;
    lines.push(line('Праздники (годы)', c));
  }
  if (file.sla?.policies) {
    const c = counter();
    for (const policy of file.sla.policies) {
      const { priority, ...wanted } = policy;
      const current = sla.policies[priority];
      const target = { firstResponseMinutes: wanted.firstResponseMinutes, resolutionMinutes: wanted.resolutionMinutes ?? null, resolutionDays: wanted.resolutionDays ?? null, clock: wanted.clock };
      if (same(current, target)) c.same++;
      else {
        c.changed++;
        if (write) await saveSlaPolicy(ctx, policy);
      }
    }
    changes += c.changed;
    lines.push(line('Сроки SLA', c));
  }
  if (file.sla?.calendar) {
    const c = counter();
    if (same({ timeZone: sla.calendar.timeZone, week: sla.calendar.week }, file.sla.calendar)) c.same++;
    else {
      c.changed++;
      if (write) await saveCalendar(ctx, file.sla.calendar);
    }
    changes += c.changed;
    lines.push(line('Рабочий календарь', c));
  }

  if (file.templates) {
    const c = counter();
    const existing = new Map((await listAllTemplates(ctx)).map((t) => [t.shortcut, t]));
    for (const template of file.templates) {
      const target = { shortcut: template.shortcut, title: template.title, body: template.body, moduleId: idOf(template.module), isEnabled: template.enabled };
      const row = existing.get(template.shortcut);
      if (row && same({ shortcut: row.shortcut, title: row.title, body: row.body, moduleId: row.moduleId, isEnabled: row.isEnabled }, target)) {
        c.same++;
        continue;
      }
      if (row) c.changed++;
      else c.created++;
      if (write) await saveTemplate(ctx, { ...target, ...(row ? { templateId: row.templateId } : {}) });
    }
    changes += c.created + c.changed;
    lines.push(line('Шаблоны ответов', c));
  }

  if (file.playbooks) {
    const c = counter();
    const existing = await listPlaybooks(ctx);
    for (const playbook of file.playbooks) {
      const moduleId = idOf(playbook.module);
      const row = existing.find((p) => p.moduleId === moduleId && p.type === playbook.type);
      if (row && row.body === playbook.body) {
        c.same++;
        continue;
      }
      if (row) c.changed++;
      else c.created++;
      if (write) await savePlaybook(ctx, { moduleId, type: playbook.type, body: playbook.body });
    }
    changes += c.created + c.changed;
    lines.push(line('Памятки первой линии', c));
  }

  if (file.tags) {
    const c = counter();
    const existing = await listTags(ctx);
    for (const tag of file.tags) {
      const row = existing.find((t) => t.name.toLowerCase() === tag.name.toLowerCase());
      if (row && row.name === tag.name && row.color === tag.color) {
        c.same++;
        continue;
      }
      if (row) c.changed++;
      else c.created++;
      if (write) {
        if (row) await updateTag(ctx, { tagId: row.tagId, name: tag.name, color: tag.color });
        else await createTag(ctx, tag);
      }
    }
    changes += c.created + c.changed;
    lines.push(line('Теги', c));
  }

  if (file.settings?.ideasVoteMode) {
    const c = counter();
    if ((await voteMode()) === file.settings.ideasVoteMode) c.same++;
    else {
      c.changed++;
      if (write) await saveVoteMode(ctx, { mode: file.settings.ideasVoteMode });
    }
    changes += c.changed;
    lines.push(line('Подсчёт голосов за идеи', c));
  }

  if (file.staff) {
    let invited = 0;
    let skipped = 0;
    const emails = new Set([...(await listStaff(ctx)).map((s) => s.email.toLowerCase()), ...(await listStaffInvitations(ctx)).map((i) => i.email.toLowerCase())]);
    for (const member of file.staff) {
      // Сотрудник уже есть или ждёт ответа на приглашение: повторное приглашение отозвало бы прежнюю ссылку.
      if (emails.has(member.email)) {
        skipped++;
        continue;
      }
      invited++;
      if (write) await inviteStaffByMail(ctx, { email: member.email, name: member.name, role: member.role, isLead: member.lead, locale: member.locale });
    }
    changes += invited;
    lines.push(`Сотрудники: приглашено ${invited}, уже есть или ждут ответа ${skipped}.`);
    if (invited > 0 && !mailDelivers()) warnings.push('Почта выключена: письма с приглашениями не уйдут. Ссылку сотруднику выдаёт hub staff:create с его адресом.');
  }

  if (file.solutions) {
    let created = 0;
    let skipped = 0;
    ids = await moduleIdOf();
    const existing = await listSolutions(ctx, {});
    for (const solution of file.solutions) {
      // Ключ черновика: язык оригинала и название. Созданный черновик дальше ведёт редактор, файл его не перезаписывает.
      if (existing.some((row) => row.originalLocale === solution.locale && row.title.trim().toLowerCase() === solution.title.toLowerCase())) {
        skipped++;
        continue;
      }
      created++;
      if (write) {
        const moduleId = solution.module === null ? undefined : ids.get(solution.module);
        await createDraftArticle(ctx, { locale: solution.locale, title: solution.title, audience: solution.audience, ...(moduleId ? { moduleId } : {}), doc: solution.doc });
      }
    }
    changes += created;
    lines.push(`Решения (черновики): создано ${created}, уже есть ${skipped}. Публикует человек в редакторе решений.`);
  }

  // Предустановленные правила (FR-AUTO-12): только проверка, команда их не меняет.
  const rules = await listRules(ctx);
  const missing = Object.keys(BUILTIN_RULES).filter((pcode) => !rules.some((rule) => rule.pcode === pcode));
  const inactive = inactiveBuiltinCodes(rules);
  if (missing.length + inactive.length === 0) lines.push('Предустановленные правила: на месте и включены.');
  else warnings.push(`Предустановленные правила: нет ${missing.join(', ') || '-'}, выключены или без своего действия ${inactive.join(', ') || '-'}. Проверьте "Правила автоматизации".`);

  return { ok: true, report: { lines, changes, warnings } };
}
