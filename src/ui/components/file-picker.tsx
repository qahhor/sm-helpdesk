'use client';

import { Paperclip, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/ui/cn';
import { Button } from './button';

// Файлы к обращению и ответу (UX-C-03, FR-TK-13): вставка скриншота из буфера, перетаскивание, выбор файла,
// на телефоне камера и галерея (accept с image/*). Файл уходит прямо в хранилище по подписанной ссылке,
// портал получает только идентификатор загрузки. До отправки видны миниатюра, ход загрузки и кнопка удаления.

export type FilePickerLabels = {
  add: string;
  hint: string;
  remove: string;
  uploading: string;
  ready: string;
  failed: string;
  errors: Record<string, string>;
};

type Item = {
  key: string;
  name: string;
  preview: string | null;
  progress: number;
  state: 'uploading' | 'ready' | 'failed';
  attachmentId?: string;
  error?: string;
};

class UploadError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const PREVIEW_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

async function postJson(url: string, body: unknown, extraHeaders: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new UploadError(typeof data.code === 'string' ? data.code : 'upload');
  return data;
}

/** PUT по подписанной ссылке с ходом загрузки: fetch ход отправки не сообщает. */
function put(url: string, headers: Record<string, string>, file: File, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => event.lengthComputable && onProgress(Math.round((event.loaded / event.total) * 100));
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new UploadError('upload')));
    xhr.onerror = () => reject(new UploadError('upload'));
    xhr.send(file);
  });
}

async function upload(file: File, onProgress: (percent: number) => void, extra: Record<string, unknown>, auth: Record<string, string>): Promise<string> {
  const { attachmentId, url, headers } = (await postJson('/api/uploads/presign', { ...extra, fileName: file.name, size: file.size, mime: file.type }, auth)) as {
    attachmentId: string;
    url: string;
    headers: Record<string, string>;
  };
  await put(url, headers, file, onProgress);
  // Цель загрузки (изображение идеи, план M7) нужна и завершению: обработчик выбирает по ней таблицу.
  const { status } = (await postJson('/api/uploads/complete', { ...(typeof extra.purpose === 'string' ? { purpose: extra.purpose } : {}), attachmentId }, auth)) as { status: string };
  if (status === 'rejected' || status === 'infected') throw new UploadError('upload');
  return attachmentId;
}

export function FilePicker({
  name = 'attachmentIds',
  accept,
  maxFiles,
  labels,
  onBusyChange,
  presignExtra,
  requestHeaders,
  onReadyChange,
}: {
  name?: string;
  accept: string;
  maxFiles: number;
  labels: FilePickerLabels;
  onBusyChange?: (busy: boolean) => void;
  /** Дополнительные поля запроса ссылки: сотрудник передаёт номер обращения, организация файла берётся из него. */
  presignExtra?: Record<string, unknown>;
  /** Заголовки запросов ссылки и завершения: страница виджета передаёт токен виджета (план M6, задача 5). */
  requestHeaders?: () => Record<string, string>;
  /** Загруженные файлы для формы без отправки через form action (виджет собирает тело запроса сам). */
  onReadyChange?: (attachmentIds: string[]) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const countRef = useRef(0);
  const errorText = useCallback((code: string) => labels.errors[code] ?? labels.errors.upload ?? code, [labels.errors]);

  const patch = (key: string, change: Partial<Item>) => setItems((list) => list.map((item) => (item.key === key ? { ...item, ...change } : item)));

  const addFiles = useCallback(
    (files: File[]) => {
      setNotice(null);
      const room = maxFiles - countRef.current;
      if (files.length > room) setNotice(errorText('too_many_files'));
      for (const file of files.slice(0, Math.max(0, room))) {
        const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        countRef.current += 1;
        const preview = PREVIEW_TYPES.has(file.type) ? URL.createObjectURL(file) : null;
        setItems((list) => [...list, { key, name: file.name || 'screenshot.png', preview, progress: 0, state: 'uploading' }]);
        upload(file, (progress) => patch(key, { progress }), presignExtra ?? {}, requestHeaders?.() ?? {})
          .then((attachmentId) => patch(key, { state: 'ready', progress: 100, attachmentId }))
          .catch((error: unknown) => patch(key, { state: 'failed', error: errorText(error instanceof UploadError ? error.code : 'upload') }));
      }
    },
    [errorText, maxFiles, presignExtra, requestHeaders],
  );

  // Скриншот из буфера обмена: Ctrl+V в любом месте страницы с этой формой.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      addFiles(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [addFiles]);

  const busy = items.some((item) => item.state === 'uploading');
  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);
  const readyIds = items.flatMap((item) => (item.state === 'ready' && item.attachmentId ? [item.attachmentId] : [])).join(',');
  useEffect(() => onReadyChange?.(readyIds ? readyIds.split(',') : []), [readyIds, onReadyChange]);

  const remove = (item: Item) => {
    if (item.preview) URL.revokeObjectURL(item.preview);
    countRef.current -= 1;
    setItems((list) => list.filter((other) => other.key !== item.key));
  };

  return (
    <div
      className={cn('flex flex-col gap-2 rounded-control border border-dashed border-input p-3', dragging && 'border-ring bg-card-soft')}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        addFiles([...event.dataTransfer.files]);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          addFiles([...(event.target.files ?? [])]);
          event.target.value = '';
        }}
      />
      <Button variant="secondary" className="self-start" onClick={() => inputRef.current?.click()}>
        <Paperclip className="size-4" aria-hidden />
        {labels.add}
      </Button>
      <p className="text-sm text-muted-foreground">{labels.hint}</p>
      {notice && (
        <p role="alert" className="text-sm text-destructive-on-bg">
          {notice}
        </p>
      )}
      {items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.key} className="flex items-center gap-3 rounded-control bg-card-soft p-2" data-upload={item.state}>
              {item.preview ? (
                // eslint-disable-next-line @next/next/no-img-element -- локальная миниатюра из blob:, оптимизатору недоступна
                <img src={item.preview} alt="" className="size-control shrink-0 rounded-control object-cover" />
              ) : (
                <Paperclip className="size-5 shrink-0 text-secondary-foreground" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{item.name}</p>
                <p className={cn('text-sm', item.state === 'failed' ? 'text-destructive-on-bg' : 'text-muted-foreground')} aria-live="polite">
                  {item.state === 'uploading'
                    ? labels.uploading.replace('{percent}', String(item.progress))
                    : item.state === 'ready'
                      ? labels.ready
                      : `${labels.failed}: ${item.error ?? ''}`}
                </p>
                {item.state === 'uploading' && (
                  <progress className="h-1 w-full accent-primary" max={100} value={item.progress} aria-hidden />
                )}
              </div>
              <Button variant="ghost" size="small" className="min-w-control" aria-label={labels.remove.replace('{name}', item.name)} onClick={() => remove(item)}>
                <X className="size-4" aria-hidden />
              </Button>
              {item.state === 'ready' && item.attachmentId && <input type="hidden" name={name} value={item.attachmentId} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
