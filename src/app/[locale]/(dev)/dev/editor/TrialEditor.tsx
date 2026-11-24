'use client';

import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useRef } from 'react';
import type { SolutionDoc } from '@/modules/hdk/api/doc';
import { Button } from '@/ui/components/button';
import type { SolutionEditorLabels } from '@/ui/doc/editor/SolutionEditor';

// Редактор грузится отдельным файлом после показа страницы (план M5, задача 1, замер бюджета): скрипты
// Tiptap и ProseMirror не входят в первый экран рабочего места.
const SolutionEditor = dynamic(() => import('@/ui/doc/editor/SolutionEditor').then((m) => m.SolutionEditor), {
  ssr: false,
  loading: () => <div className="min-h-row rounded-card border border-border bg-card" aria-busy="true" />,
});

function toBase64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function TrialEditor({
  initial,
  labels,
  saveLabel,
  imageSrc,
  imageAlt,
}: {
  initial: SolutionDoc;
  labels: SolutionEditorLabels;
  saveLabel: string;
  imageSrc: string;
  imageAlt: string;
}) {
  const router = useRouter();
  const latest = useRef<{ version: 1; blocks: unknown[] }>(initial);
  return (
    <div className="flex flex-col gap-2">
      <SolutionEditor initial={initial} labels={labels} imageSrc={imageSrc} imageAlt={imageAlt} onChange={(doc) => (latest.current = doc)} exposeForTests />
      <div>
        <Button onClick={() => router.push(`?doc=${toBase64Url(JSON.stringify(latest.current))}`, { scroll: false })}>{saveLabel}</Button>
      </div>
    </div>
  );
}
