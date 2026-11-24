'use client';

import dynamic from 'next/dynamic';
import { type ComponentProps, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SolutionDoc } from '@/modules/hdk/api/doc';
import { AUTOSAVE_INTERVAL_MS, TITLE_MAX } from '@/modules/hdk/api/constants';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { Select } from '@/ui/components/select';
import { loadImageFile } from '@/ui/doc/markup';
import type { ScreenshotLabels } from '@/ui/doc/ScreenshotMarkup';
import type { SolutionEditorLabels } from '@/ui/doc/editor/SolutionEditor';
import { completeFileAction, fileStatusAction, presignFileAction, saveDraftAction, saveMetaAction } from '../actions';

// Рабочая область редактора решения (план M5, задача 3; UX-W-01..04): заголовок, модуль, флаг "только через
// сотрудника", документ и автосохранение раз в 5 секунд с проверкой версии строки.
//
// Нет сети: правки копятся, строка состояния говорит об этом, сохранение повторяется на следующем шаге и сразу,
// когда связь вернулась. Несохранённый текст лежит и в браузере (localStorage): перезагрузка страницы без сети его не
// теряет. Конфликт (черновик изменили в другой вкладке): текст остаётся на странице и в браузере, сохранение
// останавливается до перезагрузки, ничего не затирается.
//
// Редактор и окно разметки снимка грузятся отдельными файлами после показа страницы (решение 0046): первый экран
// рабочего места укладывается в бюджет скриптов.

const SolutionEditor = dynamic(() => import('@/ui/doc/editor/SolutionEditor').then((m) => m.SolutionEditor), {
  ssr: false,
  loading: () => <div className="min-h-row rounded-card border border-border bg-card" aria-busy="true" />,
});
const ScreenshotMarkup = dynamic(() => import('@/ui/doc/ScreenshotMarkup').then((m) => m.ScreenshotMarkup), { ssr: false });

export type WorkspaceLabels = {
  editor: SolutionEditorLabels;
  screenshot: ScreenshotLabels;
  title: string;
  module: string;
  noModule: string;
  internal: string;
  internalHint: string;
  status: {
    saved: string;
    savedAt: string;
    dirty: string;
    saving: string;
    offline: string;
    conflict: string;
    error: string;
    restored: string;
  };
  reload: string;
  metaError: string;
  metaForbidden: string;
};

type Version = { versionId: string; revision: string };
type Backup = Version & { title: string; doc: SolutionDoc };
type Status = 'saved' | 'dirty' | 'saving' | 'offline' | 'conflict' | 'error';

const POLL_MS = 1000;
const POLL_LIMIT = 60;

function readBackup(key: string): Backup | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Backup) : null;
  } catch {
    return null;
  }
}
function writeBackup(key: string, value: Backup | null) {
  try {
    if (value) window.localStorage.setItem(key, JSON.stringify(value));
    else window.localStorage.removeItem(key);
  } catch {
    // Хранилище браузера закрыто (приватный режим): текст сохраняется на сервер как обычно.
  }
}

const noSubscribe = () => () => {};

/**
 * Рабочая область рисуется только в браузере: текст, который не успел сохраниться, лежит в localStorage, и с ним
 * сразу собирается первое состояние. Сервер отдаёт заглушку той же высоты.
 */
export function SolutionWorkspace(props: ComponentProps<typeof WorkspaceBody>) {
  const client = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
  if (!client) return <div className="min-h-row rounded-card border border-border bg-card" aria-busy="true" />;
  return <WorkspaceBody {...props} />;
}

/** Первое состояние: копия из браузера, если она сделана от той же версии строки, что пришла с сервера. */
function bootState(key: string, initial: Backup, canWrite: boolean): { doc: SolutionDoc; title: string; restored: boolean } {
  const backup = canWrite ? readBackup(key) : null;
  if (backup && backup.versionId === initial.versionId && backup.revision === initial.revision) return { doc: backup.doc, title: backup.title, restored: true };
  if (backup) writeBackup(key, null);
  return { doc: initial.doc, title: initial.title, restored: false };
}

function WorkspaceBody({
  number,
  locale,
  initial,
  canWrite,
  modules,
  meta,
  labels,
  filePath,
}: {
  number: number;
  locale: string;
  initial: Backup;
  canWrite: boolean;
  modules: { moduleId: string; name: string }[];
  meta: {
    moduleId: string | null;
    audience: 'clients' | 'internal';
    editable: boolean;
  };
  labels: WorkspaceLabels;
  /** Адрес файлов решения для сотрудника: /<язык>/agent/solutions/<номер>/files. */
  filePath: string;
}) {
  const backupKey = `hub:solution-draft:${number}:${locale}`;
  const [start] = useState(() => bootState(backupKey, initial, canWrite));
  const [title, setTitle] = useState(start.title);
  const [status, setStatus] = useState<Status>(start.restored ? 'dirty' : 'saved');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [moduleId, setModuleId] = useState(meta.moduleId ?? '');
  const [internal, setInternal] = useState(meta.audience === 'internal');
  const [metaError, setMetaError] = useState<string | null>(null);
  const [shot, setShot] = useState<{
    open: boolean;
    image: HTMLImageElement | null;
  }>({ open: false, image: null });
  const shotDone = useRef<((result: { fileId: string; alt: string } | null) => void) | null>(null);
  const editorApi = useRef<{
    insertImage: (image: { fileId: string; alt: string }) => void;
  } | null>(null);

  // Последнее, что ввёл сотрудник, и версия строки, от которой он правит.
  const latest = useRef<{ title: string; doc: SolutionDoc }>({
    title: start.title,
    doc: start.doc,
  });
  const version = useRef<Version>({
    versionId: initial.versionId,
    revision: initial.revision,
  });
  const editSeq = useRef(0);
  const saving = useRef(false);
  const stopped = useRef(false);
  const dirty = useRef(start.restored);

  const save = useCallback(async () => {
    if (!canWrite || saving.current || stopped.current || !dirty.current) return;
    saving.current = true;
    const seq = editSeq.current;
    const snapshot = latest.current;
    setStatus('saving');
    try {
      const response = await saveDraftAction({
        number,
        locale,
        versionId: version.current.versionId,
        revision: version.current.revision,
        title: snapshot.title,
        doc: snapshot.doc,
      });
      if (!response.ok) {
        setErrorCode(response.code);
        setStatus('error');
        return;
      }
      if (response.result.status === 'conflict') {
        stopped.current = true;
        setStatus('conflict');
        return;
      }
      version.current = {
        versionId: response.result.versionId,
        revision: response.result.revision,
      };
      setSavedAt(new Date());
      if (editSeq.current === seq) {
        dirty.current = false;
        writeBackup(backupKey, null);
        setStatus('saved');
      } else {
        // Пока шло сохранение, сотрудник продолжал писать: копия в браузере от новой версии строки.
        writeBackup(backupKey, { ...version.current, ...latest.current });
        setStatus('dirty');
      }
    } catch {
      // Запрос не дошёл (нет сети): правки остаются, следующий шаг повторит.
      setStatus('offline');
    } finally {
      saving.current = false;
    }
  }, [backupKey, canWrite, locale, number]);

  useEffect(() => {
    const timer = window.setInterval(() => void save(), AUTOSAVE_INTERVAL_MS);
    const online = () => void save();
    const offline = () => dirty.current && setStatus('offline');
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, [save]);

  const changed = (next: Partial<{ title: string; doc: SolutionDoc }>) => {
    latest.current = { ...latest.current, ...next };
    editSeq.current += 1;
    dirty.current = true;
    writeBackup(backupKey, { ...version.current, ...latest.current });
    if (!stopped.current) setStatus((current) => (current === 'offline' || current === 'saving' ? current : 'dirty'));
  };

  const saveMeta = async (next: { moduleId: string; internal: boolean }) => {
    setMetaError(null);
    try {
      const response = await saveMetaAction({
        number,
        moduleId: next.moduleId || null,
        audience: next.internal ? 'internal' : 'clients',
      });
      if (!response.ok) {
        setMetaError(response.code === 'forbidden' ? labels.metaForbidden : labels.metaError);
        setModuleId(meta.moduleId ?? '');
        setInternal(meta.audience === 'internal');
      }
    } catch {
      setMetaError(labels.metaError);
    }
  };

  const upload = useCallback(
    async (blob: Blob, fileName: string): Promise<{ fileId: string } | { error: string }> => {
      const presigned = await presignFileAction({
        number,
        fileName,
        mime: blob.type,
        size: blob.size,
      });
      if (!presigned.ok) return { error: presigned.code };
      const put = await fetch(presigned.url, {
        method: 'PUT',
        headers: presigned.headers,
        body: blob,
      });
      if (!put.ok) return { error: 'upload_failed' };
      const completed = await completeFileAction({ fileId: presigned.fileId });
      if (!completed.ok) return { error: completed.code };
      // Проверку антивирусом делает фоновый процесс: окно ждёт итога.
      for (let i = 0; i < POLL_LIMIT; i++) {
        const state = await fileStatusAction({ fileId: presigned.fileId });
        if (!state.ok) return { error: state.code };
        if (state.status === 'clean') return { fileId: presigned.fileId };
        if (state.status !== 'pending') return { error: state.status };
        await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
      }
      return { error: 'scan_timeout' };
    },
    [number],
  );

  const requestImage = useCallback(
    () =>
      new Promise<{ fileId: string; alt: string } | null>((resolve) => {
        shotDone.current = resolve;
        setShot({ open: true, image: null });
      }),
    [],
  );
  const onPasteImage = useCallback((file: File) => {
    void loadImageFile(file).then((image) => {
      if (!image) return;
      shotDone.current = (result) => result && editorApi.current?.insertImage(result);
      setShot({ open: true, image });
    });
  }, []);
  const onReady = useCallback((api: { insertImage: (image: { fileId: string; alt: string }) => void }) => {
    editorApi.current = api;
  }, []);

  const statusText =
    status === 'saved'
      ? savedAt
        ? labels.status.savedAt.replace(
            '{time}',
            savedAt.toLocaleTimeString(locale === 'en' ? 'en-GB' : 'ru-RU', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            }),
          )
        : labels.status.saved
      : status === 'error'
        ? `${labels.status.error} (${errorCode ?? ''})`
        : labels.status[status];

  return (
    <div className="flex flex-col gap-4" data-testid="solution-workspace" data-save-status={status}>
      <div className="grid gap-3 laptop:grid-cols-3">
        <div className="flex flex-col gap-1 laptop:col-span-3">
          <Label htmlFor="solution-title">{labels.title}</Label>
          <Input
            id="solution-title"
            value={title}
            maxLength={TITLE_MAX}
            readOnly={!canWrite}
            onChange={(event) => {
              setTitle(event.target.value);
              changed({ title: event.target.value });
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="solution-module">{labels.module}</Label>
          <Select
            id="solution-module"
            value={moduleId}
            disabled={!meta.editable}
            onChange={(event) => {
              setModuleId(event.target.value);
              void saveMeta({ moduleId: event.target.value, internal });
            }}
          >
            <option value="">{labels.noModule}</option>
            {modules.map((m) => (
              <option key={m.moduleId} value={m.moduleId}>
                {m.name}
              </option>
            ))}
          </Select>
        </div>
        <label className="flex items-start gap-2 text-sm laptop:col-span-2 laptop:self-end">
          <input
            type="checkbox"
            checked={internal}
            disabled={!meta.editable}
            className="mt-1 size-4 accent-primary"
            onChange={(event) => {
              setInternal(event.target.checked);
              void saveMeta({ moduleId, internal: event.target.checked });
            }}
          />
          <span>
            <span className="font-medium">{labels.internal}</span>
            <span className="block text-secondary-foreground">{labels.internalHint}</span>
          </span>
        </label>
      </div>
      {metaError && <Alert tone="danger">{metaError}</Alert>}
      {start.restored && <Alert tone="info">{labels.status.restored}</Alert>}
      {status === 'conflict' ? (
        <Alert tone="danger">
          {labels.status.conflict}{' '}
          <Button variant="secondary" size="small" onClick={() => window.location.reload()}>
            {labels.reload}
          </Button>
        </Alert>
      ) : (
        canWrite && (
          <p role="status" aria-live="polite" className="text-sm text-secondary-foreground" data-testid="save-status">
            {statusText}
          </p>
        )
      )}
      {
        <SolutionEditor
          initial={start.doc}
          labels={labels.editor}
          editable={canWrite}
          imageSrc={(fileId) => `${filePath}/${fileId}`}
          insertImage={requestImage}
          onPasteImage={canWrite ? onPasteImage : undefined}
          onReady={onReady}
          // Узлы ProseMirror несут атрибуты не простыми объектами: серверное действие их не передаёт. Копия через JSON
          // даёт простые данные, те же, что лягут в базу и в копию браузера.
          onChange={(doc) => changed({ doc: JSON.parse(JSON.stringify(doc)) as SolutionDoc })}
        />
      }
      {/* Окно разметки грузится при первом открытии: его файл не входит в первый экран. */}
      {canWrite && shot.open && (
        <ScreenshotMarkup
          open={shot.open}
          initialImage={shot.image}
          labels={labels.screenshot}
          upload={upload}
          onDone={(result) => {
            setShot({ open: false, image: null });
            shotDone.current?.(result);
            shotDone.current = null;
          }}
        />
      )}
    </div>
  );
}
