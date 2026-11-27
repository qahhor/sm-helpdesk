'use client';

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { TezMark } from '@/ui/brand/TezMark';
import { Alert } from '@/ui/components/alert';
import { KnownProblemBanner } from '@/ui/components/KnownProblemBanner';
import { Button } from '@/ui/components/button';
import { FilePicker } from '@/ui/components/file-picker';
import { Label } from '@/ui/components/label';
import { Select } from '@/ui/components/select';
import { Textarea } from '@/ui/components/textarea';
import { browserDrafts, clearDraft, draftKey, loadDraft, saveDraft } from '@/ui/drafts';
import { fill, useWidget } from './session';

// Экран "Сообщить" виджета (ТЗ 8.3 "Панель виджета внутри Smartup"; FR-WG-03, 06; S1; план M6, задача 5).
//
// Сверху ошибка из Smartup (подсказки хозяина, только текстом: решение 11), под ней "Мы знаем эту ошибку" (точное
// совпадение по сигнатуре ошибки) или "Похоже, это уже решали" (POST /api/suggest), решение открывается в панели.
// Ниже форма "Что вы делали перед ошибкой?", модуль из подсказки (UX-C-09), скриншот (загрузка с токеном виджета),
// черновик на устройстве (UX-C-02). Без сети текст остаётся, отправка повторяется сама при появлении сети (8.13).
//
// Известная проблема (план M5c, решение 13; FR-KP-08): ответ подсказки несёт knownProblem, если сигнатура ошибки
// совпала с активной показанной проблемой. Тогда вместо формы баннер "Мы знаем об этой проблеме", кнопка "Меня это
// тоже затронуло" (POST /api/embed/problems/affected) и ссылка "У меня другая проблема" на обычную форму.

const SUGGEST_DELAY_MS = 400;
// Решение открывается не на первом экране: его отрисовка (DocView) грузится отдельно, бюджет 170 КБ (ТЗ 8.9).
const SolutionPanel = lazy(() => import('./SolutionPanel').then((m) => ({ default: m.SolutionPanel })));

type Module = { id: string; code: string; name: string };
type Suggestion = { number: number; slug: string; title: string; exact: boolean; orgCount: number | null };
type KnownProblem = { number: number; status: string; publicTitle: string; publicBody: string; workaround: { number: number; slug: string; title: string } | null };

export function ReportView({ accept, maxFiles }: { accept: string; maxFiles: number }) {
  const w = useWidget();
  const l = w.labels;
  const hints = w.hints;
  const sessionId = useMemo(() => crypto.randomUUID(), []);
  const [modules, setModules] = useState<Module[]>([]);
  const [moduleId, setModuleId] = useState<string | null>(null);
  const key = w.draftScope ? draftKey(w.draftScope, 'widget-report') : null;
  // Черновик на устройстве (UX-C-02). Экран рисуется только после обмена токена: пользователь уже известен.
  const [description, setDescription] = useState(() => (key ? (loadDraft(browserDrafts(), key)?.description ?? '') : ''));
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [problem, setProblem] = useState<KnownProblem | null>(null);
  const [otherProblem, setOtherProblem] = useState(false);
  const [already, setAlready] = useState(false);
  const [solution, setSolution] = useState<string | null>(null);
  const [created, setCreated] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (key && created === null) saveDraft(browserDrafts(), key, { description });
  }, [key, description, created]);

  useEffect(() => {
    let live = true;
    w.request(`/api/embed/form?locale=${w.locale}`)
      .then(async (response) => (response.ok ? ((await response.json()) as { modules: Module[] }).modules : []))
      .catch(() => [])
      .then((list) => live && setModules(list));
    return () => {
      live = false;
    };
    // Справочник модулей один раз на экран.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Модуль из подсказки хозяина подставляется, пока клиент не выбрал сам (UX-C-09). Неизвестный код в справочнике
  // не выбирает ничего: он идёт только в контекст обращения.
  const hinted = modules.find((m) => m.code === hints.module) ?? null;
  const chosen = moduleId ?? hinted?.id ?? '';

  const query = description.trim();
  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.length < 3 && !hints.errorCode && !hints.errorText) return setItems([]);
      w.request('/api/suggest', {
        body: { text: query.slice(0, 500), sessionId, locale: w.locale, moduleId: chosen || null, errorCode: hints.errorCode, errorText: hints.errorText },
      })
        .then(async (response) => (response.ok ? ((await response.json()) as { items: Suggestion[]; knownProblem?: KnownProblem | null }) : { items: [] }))
        .catch(() => ({ items: [] as Suggestion[], knownProblem: null }))
        .then((result) => {
          setItems(result.items);
          setProblem(result.knownProblem ?? null);
        });
    }, SUGGEST_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, chosen, hints.errorCode, hints.errorText, sessionId]);

  const context = () => ({ moduleCode: hints.module, screen: hints.form, version: hints.appVersion, errorCode: hints.errorCode, errorText: hints.errorText });
  const submit = async () => {
    if (description.trim() === '') return setError(l['report.errors.description'] ?? '');
    setSending(true);
    setError(null);
    let response: Response;
    try {
      response = await w.request('/api/embed/tickets', {
        body: { description, locale: w.locale, moduleId: chosen || undefined, attachmentIds, suggestSession: sessionId, context: context() },
      });
    } catch {
      // Нет сети: текст сохранён, отправка повторится сама (состояние "Нет связи", 8.13).
      setSending(false);
      setQueued(true);
      return;
    }
    setSending(false);
    setQueued(false);
    if (response.status === 201) {
      const { number } = (await response.json()) as { number: number };
      if (key) clearDraft(browserDrafts(), key);
      setCreated(number);
      w.ticketCreated(number);
      return;
    }
    const code = ((await response.json().catch(() => null)) as { code?: string } | null)?.code ?? '';
    setError(l[`errors.${code}`] ?? l['report.errors.failed'] ?? '');
  };

  // Повтор отправки при появлении сети. Слушатель ставится заново на каждой отрисовке, пока отправка ждёт: уходит
  // текущий текст, а не тот, что был при обрыве.
  useEffect(() => {
    if (!queued) return;
    const retry = () => void submit();
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  });

  // "Меня это тоже затронуло": одно нажатие создаёт привязанное обращение; второе показывает номер уже созданного.
  const affected = async (number: number) => {
    setSending(true);
    setError(null);
    try {
      const response = await w.request('/api/embed/problems/affected', {
        body: { problemNumber: number, locale: w.locale, description: description.trim() || undefined, context: { errorCode: hints.errorCode, errorText: hints.errorText } },
      });
      if (response.status === 201 || response.status === 200) {
        const result = (await response.json()) as { number: number };
        if (key) clearDraft(browserDrafts(), key);
        setAlready(response.status === 200);
        setCreated(result.number);
        if (response.status === 201) w.ticketCreated(result.number);
        return;
      }
      setError(l['problems.failed'] ?? '');
    } catch {
      setError(l['problems.failed'] ?? '');
    } finally {
      setSending(false);
    }
  };

  const reset = () => {
    setCreated(null);
    setAlready(false);
    setDescription('');
    setAttachmentIds([]);
    setItems([]);
  };

  if (created !== null)
    return (
      <section className="flex flex-col items-center gap-3 py-6 text-center" data-testid="widget-created">
        <TezMark size={64} />
        <p className="font-semibold" role="status">
          {fill((already ? l['problems.already'] : l['report.created']) ?? '', { number: `SUP-${created}` })}
        </p>
        <Button onClick={() => w.nav.ticket(created)}>{l['report.toTickets']}</Button>
        <Button variant="secondary" onClick={reset}>
          {l['report.another']}
        </Button>
      </section>
    );

  if (solution)
    return (
      <Suspense fallback={<p role="status" className="text-secondary-foreground">{l['panel.waiting']}</p>}>
        <SolutionPanel reference={solution} sessionId={sessionId} onBack={() => setSolution(null)} />
      </Suspense>
    );

  const known = items.some((item) => item.exact);
  const hasError = Boolean(hints.errorCode || hints.errorText);
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-bold">{l['report.title']}</h1>
      {hasError && (
        <section className="flex flex-col gap-1" data-testid="widget-error">
          <p className="font-semibold">{hinted ? fill(l['report.errorIn'] ?? '', { module: hinted.name }) : l['report.error']}</p>
          {/* Текст ошибки из Smartup только текстом: React экранирует, ссылкой и разметкой он не становится. */}
          <p className="break-words text-secondary-foreground">{[hints.errorCode, hints.errorText].filter(Boolean).join(': ')}</p>
        </section>
      )}

      {problem && !otherProblem && (
        <KnownProblemBanner
          testId="widget-known-problem"
          heading={l['problems.heading'] ?? ''}
          title={problem.publicTitle}
          status={fill(l['problems.status'] ?? '', { status: l[`problems.statuses.${problem.status}`] ?? '' })}
          workaround={
            problem.workaround
              ? {
                  label: l['problems.workaround'] ?? '',
                  link: (
                    <Button variant="secondary" size="small" onClick={() => setSolution(`${problem.workaround!.number}-${problem.workaround!.slug}`)}>
                      {l['problems.openWorkaround']}
                    </Button>
                  ),
                }
              : null
          }
        >
          {error && <Alert tone="danger">{error}</Alert>}
          <Button onClick={() => void affected(problem.number)} disabled={sending}>
            {sending ? l['problems.sending'] : l['problems.affected']}
          </Button>
          <p className="text-sm">{l['problems.affectedHint']}</p>
          <Button variant="ghost" className="self-start" onClick={() => setOtherProblem(true)}>
            {l['problems.other']}
          </Button>
        </KnownProblemBanner>
      )}

      {(!problem || otherProblem) && (
      <>
      <div aria-live="polite">
        {items.length > 0 && (
          <section aria-labelledby="widget-suggest-title" className="flex flex-col gap-2" data-testid="widget-suggestions">
            <h2 id="widget-suggest-title" className="font-semibold">
              {known ? l['report.known'] : l['report.similar']}
            </h2>
            <ul className="flex flex-col gap-2">
              {items.map((item) => (
                <li key={item.number} className="flex flex-col gap-2 rounded-card border border-border bg-card p-3">
                  <p className="font-medium break-words">{item.title}</p>
                  {item.orgCount !== null && <p className="text-sm text-secondary-foreground">{fill(l['report.orgCount'] ?? '', { count: item.orgCount })}</p>}
                  <Button variant="secondary" size="small" className="self-end" onClick={() => setSolution(`${item.number}-${item.slug}`)}>
                    {l['report.openSolution']}
                  </Button>
                </li>
              ))}
            </ul>
            <Button
              variant="ghost"
              className="self-start"
              onClick={() => {
                void w.request('/api/suggest', { body: { outcome: 'not_helped', sessionId } }).catch(() => undefined);
                textarea.current?.focus();
              }}
            >
              {l['report.notHelped']}
            </Button>
          </section>
        )}
      </div>

      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {queued && <Alert>{l['panel.offline']}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex flex-col gap-1">
          <Label htmlFor="widget-description">{l['report.description']}</Label>
          <Textarea
            ref={textarea}
            id="widget-description"
            maxLength={20000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            aria-describedby="widget-description-hint"
          />
          <p id="widget-description-hint" className="text-sm text-muted-foreground">
            {l['report.descriptionHint']}
          </p>
        </div>
        {modules.length > 0 && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="widget-module">{l['report.module']}</Label>
            <Select id="widget-module" value={chosen} onChange={(event) => setModuleId(event.target.value)}>
              <option value="">{l['report.moduleNone']}</option>
              {modules.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <FilePicker
          accept={accept}
          maxFiles={maxFiles}
          labels={{
            add: l['files.add'] ?? '',
            hint: l['files.hint'] ?? '',
            remove: l['files.remove'] ?? '',
            uploading: l['files.uploading'] ?? '',
            ready: l['files.ready'] ?? '',
            failed: l['files.failed'] ?? '',
            errors: Object.fromEntries(['too_many_files', 'file_not_allowed', 'file_too_large', 'rate_limited', 'upload'].map((code) => [code, l[`errors.${code}`] ?? ''])),
          }}
          onBusyChange={setUploading}
          onReadyChange={setAttachmentIds}
          requestHeaders={w.authHeaders}
        />
        {uploading && <p className="text-sm text-muted-foreground">{l['files.busy']}</p>}
        <Button type="submit" disabled={sending || uploading}>
          {sending ? l['report.sending'] : l['report.submit']}
        </Button>
      </form>
      </>
      )}
    </div>
  );
}
