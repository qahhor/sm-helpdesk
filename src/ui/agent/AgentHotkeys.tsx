'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Command, runHotkey, useHotkey, useScreenCommands } from '@/ui/hotkeys/bus';
import { HOTKEYS, matchHotkey } from '@/ui/hotkeys/registry';
import { CommandPalette, type PaletteLabels } from './CommandPalette';
import { ShortcutsHelp } from './ShortcutsHelp';

// Клавиши рабочего места (UX-A-17, UX-S-14; план M3, задача 14): один слушатель на оболочку. Нажатие превращается
// в действие реестра, действие выполняет экран, который его зарегистрировал. Палитра и справка живут здесь.

export type AgentHotkeysLabels = PaletteLabels & {
  openTicket: string;
  sectionsGroup: string;
  helpTitle: string;
  actions: Record<string, string>;
  /** Подписи клавиш, у которых имя события не годится человеку: ArrowDown, ArrowUp (проверка интерфейса, U20). */
  keyNames: Record<string, string>;
};

const isField = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export function AgentHotkeys({ locale, sections, labels }: { locale: string; sections: { label: string; href: string }[]; labels: AgentHotkeysLabels }) {
  const router = useRouter();
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const screen = useScreenCommands();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const action = matchHotkey(event, isField(event.target));
      if (action && runHotkey(action)) event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    // Слушатель подключён: по этой отметке браузерные тесты ждут, когда клавиши начнут работать.
    document.documentElement.dataset.hotkeys = 'ready';
    return () => {
      window.removeEventListener('keydown', onKey);
      delete document.documentElement.dataset.hotkeys;
    };
  }, []);

  useHotkey('palette.open', useCallback(() => setPalette(true), []));
  useHotkey('help.open', useCallback(() => setHelp(true), []));

  const go = useCallback((href: string) => router.push(`/${locale}${href}`), [router, locale]);
  const commands = useMemo<Command[]>(
    () => [...screen, ...sections.map((s) => ({ id: `section-${s.href}`, group: labels.sectionsGroup, label: s.label, run: () => go(s.href) }))],
    [screen, sections, labels.sectionsGroup, go],
  );
  const helpItems = useMemo(
    () =>
      HOTKEYS.filter((h) => labels.actions[h.action]).map((h) => ({
        keys: h.keys
          .split('+')
          .map((key) => labels.keyNames[key] ?? key)
          .join('+'),
        label: labels.actions[h.action] as string,
      })),
    [labels.actions, labels.keyNames],
  );

  return (
    <>
      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        commands={commands}
        openTicket={(number) => go(`/agent/tickets/SUP-${number}`)}
        openTicketLabel={labels.openTicket}
        labels={labels}
      />
      <ShortcutsHelp open={help} onOpenChange={setHelp} items={helpItems} title={labels.helpTitle} close={labels.close} />
    </>
  );
}
