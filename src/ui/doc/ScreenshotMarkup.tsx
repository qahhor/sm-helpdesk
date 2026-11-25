'use client';

import { ArrowUpRight, Grid3x3, Hash, Square, Undo2, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type PointerEvent } from 'react';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/ui/components/dialog';
import { Input } from '@/ui/components/input';
import { Label } from '@/ui/components/label';
import { cn } from '@/ui/cn';
import { arrowHead, blurCell, drawOrder, IMAGE_TYPES, isMeaningful, loadImageFile, type MarkupTool, nextNumber, type Point, rectOf, type Shape, strokeOf } from './markup';

// Снимок экрана для шага решения (UX-W-03; план M5, задача 3): вставка из буфера или выбор файла, разметка своим
// компонентом на холсте (стрелка, рамка, номер шага, размытие области), без сторонних пакетов. Итог в полном
// размере снимка уходит PNG через загрузку страницы (хранилище и антивирус); окно закрывается, когда файл проверен.
// Цвета берутся из токенов оформления (переменные CSS), а не числами в коде. Грузится вместе с редактором, отдельно
// от первого экрана рабочего места.

export type ScreenshotLabels = {
  title: string;
  description: string;
  close: string;
  pasteHint: string;
  chooseFile: string;
  tools: string;
  arrow: string;
  frame: string;
  number: string;
  blur: string;
  undo: string;
  alt: string;
  altHint: string;
  insert: string;
  uploading: string;
  failed: string;
  notImage: string;
  canvas: string;
};

/** Загрузка готового PNG страницей: возвращает проверенный файл решения или код ошибки. */
export type UploadImage = (blob: Blob, fileName: string) => Promise<{ fileId: string } | { error: string }>;

const TOOLS: { key: MarkupTool; icon: LucideIcon }[] = [
  { key: 'arrow', icon: ArrowUpRight },
  { key: 'frame', icon: Square },
  { key: 'number', icon: Hash },
  { key: 'blur', icon: Grid3x3 },
];

function cssColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function render(canvas: HTMLCanvasElement, image: HTMLImageElement, shapes: readonly Shape[]) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  const stroke = strokeOf(width);
  const accent = cssColor('--color-destructive');
  const badge = cssColor('--color-primary');
  const badgeText = cssColor('--color-primary-foreground');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(image, 0, 0, width, height);
  for (const shape of drawOrder(shapes)) {
    if (shape.kind === 'blur') {
      // Область заменяется крупными квадратами: уменьшенная копия растягивается без сглаживания.
      const rect = rectOf(shape.from, shape.to, canvas);
      if (rect.width < 1 || rect.height < 1) continue;
      const cell = blurCell(rect);
      const small = document.createElement('canvas');
      small.width = Math.max(1, Math.ceil(rect.width / cell));
      small.height = Math.max(1, Math.ceil(rect.height / cell));
      small.getContext('2d')?.drawImage(canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, small.width, small.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, small.width, small.height, rect.x, rect.y, rect.width, rect.height);
      ctx.imageSmoothingEnabled = true;
      continue;
    }
    ctx.lineWidth = stroke;
    ctx.strokeStyle = accent;
    ctx.fillStyle = accent;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (shape.kind === 'frame') {
      const rect = rectOf(shape.from, shape.to, canvas);
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    } else if (shape.kind === 'arrow') {
      const [left, right] = arrowHead(shape.from, shape.to, stroke);
      ctx.beginPath();
      ctx.moveTo(shape.from.x, shape.from.y);
      ctx.lineTo(shape.to.x, shape.to.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(shape.to.x, shape.to.y);
      ctx.lineTo(left.x, left.y);
      ctx.lineTo(right.x, right.y);
      ctx.closePath();
      ctx.fill();
    } else {
      const radius = stroke * 4;
      ctx.beginPath();
      ctx.arc(shape.at.x, shape.at.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = badge;
      ctx.fill();
      ctx.fillStyle = badgeText;
      ctx.font = `600 ${Math.round(radius * 1.2)}px ${cssColor('--font-sans') || 'sans-serif'}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(shape.value), shape.at.x, shape.at.y);
    }
  }
}

export function ScreenshotMarkup({
  open,
  initialImage,
  labels,
  upload,
  onDone,
}: {
  open: boolean;
  /** Снимок, уже вставленный из буфера в текст: окно сразу открывается с ним. */
  initialImage: HTMLImageElement | null;
  labels: ScreenshotLabels;
  upload: UploadImage;
  /** Итог окна: проверенный файл с подписью или null (окно закрыли). */
  onDone: (result: { fileId: string; alt: string } | null) => void;
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(initialImage);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [tool, setTool] = useState<MarkupTool>('arrow');
  const [alt, setAlt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const start = useRef<Point | null>(null);

  const load = useCallback(
    async (file: File | Blob | null | undefined) => {
      if (!file) return;
      const img = await loadImageFile(file);
      setError(img ? null : labels.notImage);
      if (!img) return;
      setImage(img);
      setShapes([]);
    },
    [labels.notImage],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    render(canvas, image, draft ? [...shapes, draft] : shapes);
  }, [image, shapes, draft]);

  const pointOf = (event: PointerEvent<HTMLCanvasElement>): Point => {
    const canvas = event.currentTarget;
    const box = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * canvas.width,
      y: ((event.clientY - box.top) / box.height) * canvas.height,
    };
  };
  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const at = pointOf(event);
    if (tool === 'number') {
      setShapes((list) => [...list, { kind: 'number', at, value: nextNumber(list) }]);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = at;
    setDraft({ kind: tool, from: at, to: at });
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!start.current || tool === 'number') return;
    setDraft({ kind: tool, from: start.current, to: pointOf(event) });
  };
  const onPointerUp = () => {
    const canvas = canvasRef.current;
    if (draft && canvas && isMeaningful(draft, strokeOf(canvas.width))) setShapes((list) => [...list, draft]);
    start.current = null;
    setDraft(null);
  };
  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const file = [...event.clipboardData.files].find((item) => item.type.startsWith('image/'));
    if (!file) return;
    event.preventDefault();
    void load(file);
  };

  const insert = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    setBusy(true);
    setError(null);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    const result = blob ? await upload(blob, 'screenshot.png').catch(() => ({ error: 'network' })) : { error: 'invalid_input' };
    setBusy(false);
    if ('error' in result) {
      setError(labels.failed);
      return;
    }
    onDone({ fileId: result.fileId, alt: alt.trim() });
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !busy && onDone(null)}>
      <DialogContent closeLabel={labels.close} className="max-w-4xl" onPaste={onPaste}>
        <DialogTitle>{labels.title}</DialogTitle>
        <DialogDescription>{labels.description}</DialogDescription>
        {error && <Alert tone="danger">{error}</Alert>}
        {!image ? (
          <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border p-6 text-center" data-testid="screenshot-drop">
            <p className="text-secondary-foreground">{labels.pasteHint}</p>
            <label className="cursor-pointer font-semibold text-link underline-offset-2 hover:underline">
              {labels.chooseFile}
              <input type="file" accept={IMAGE_TYPES.join(',')} className="sr-only" onChange={(event) => void load(event.target.files?.[0])} />
            </label>
          </div>
        ) : (
          <>
            <div role="toolbar" aria-label={labels.tools} className="flex flex-wrap items-center gap-1">
              {TOOLS.map(({ key, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={tool === key}
                  onClick={() => setTool(key)}
                  className={cn(
                    'inline-flex h-control-small items-center gap-1 rounded-control px-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                    tool === key && 'bg-selected text-selected-foreground',
                  )}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {labels[key]}
                </button>
              ))}
              <Button type="button" variant="secondary" size="small" onClick={() => setShapes((list) => list.slice(0, -1))} disabled={shapes.length === 0}>
                <Undo2 className="size-4" aria-hidden="true" />
                {labels.undo}
              </Button>
            </div>
            <canvas
              ref={canvasRef}
              role="img"
              aria-label={labels.canvas}
              data-shapes={shapes.length}
              className="w-full touch-none rounded-control border border-border"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
            <div className="flex flex-col gap-1">
              <Label htmlFor="screenshot-alt">{labels.alt}</Label>
              <Input id="screenshot-alt" value={alt} maxLength={300} onChange={(event) => setAlt(event.target.value)} aria-describedby="screenshot-alt-hint" />
              <p id="screenshot-alt-hint" className="text-sm text-secondary-foreground">
                {labels.altHint}
              </p>
            </div>
            <Button type="button" className="self-start" onClick={insert} disabled={busy}>
              {busy ? labels.uploading : labels.insert}
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
