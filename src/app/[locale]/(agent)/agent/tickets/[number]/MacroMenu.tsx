'use client';

import { ChevronDown } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Alert } from '@/ui/components/alert';
import { Button } from '@/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/ui/components/dropdown-menu';
import { type MacroRunState, runMacroAction } from './actions';

// Меню "Макросы" на странице обращения (FR-AG-15, UX-A-16): несколько действий одним нажатием. Макрос выполняется
// на сервере от имени сотрудника; страница показывает, что сделано и в чём отказано, и перечитывается. Текст шаблона
// макрос не отправляет: сервер кладёт его в черновик ответа, поле ответа показывает его после перечитывания.
// Меню открывается с клавиатуры (Enter, пробел, стрелка вниз), пункты выбираются стрелками и Enter, Esc закрывает.
// version: версия, с которой открыта страница. Если обращение с тех пор изменили другие, макрос ничего не делает, а
// страница перечитывается и называет изменения, как после действий статуса, исполнителя и приоритета (FR-AG-12).

export type MacroMenuLabels = { open: string; list: string; busy: string };

export function MacroMenu({ number, version, macros, labels }: { number: number; version: string; macros: { macroId: string; name: string }[]; labels: MacroMenuLabels }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [state, setState] = useState<MacroRunState | null>(null);
  const run = (macroId: string) =>
    start(async () => {
      setState(await runMacroAction(number, macroId, version));
      router.refresh();
    });
  return (
    <div className="flex flex-col gap-2" data-macros>
      {/* Не модальное: страница под открытым меню остаётся доступной программам экранного доступа. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="small" className="self-start" disabled={pending}>
            {pending ? labels.busy : labels.open}
            <ChevronDown className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
          <DropdownMenuLabel>{labels.list}</DropdownMenuLabel>
          {macros.map((macro) => (
            <DropdownMenuItem key={macro.macroId} onSelect={() => run(macro.macroId)}>
              {macro.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {state?.error && <Alert tone="danger">{state.error}</Alert>}
      {state?.title && (
        <Alert tone={state.refused && state.refused.length > 0 ? 'info' : 'success'}>
          <span data-macro-result className="flex flex-col gap-1">
            <span className="font-semibold">{state.title}</span>
            {state.done && <span>{state.done}</span>}
            {state.refused?.map((line) => (
              <span key={line} data-macro-refused>
                {line}
              </span>
            ))}
            {state.template && <span>{state.template}</span>}
          </span>
        </Alert>
      )}
    </div>
  );
}
