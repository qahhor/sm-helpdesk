'use client';

import { useEffect, useSyncExternalStore } from 'react';

// Обработчики клавиш и команды палитры, которые регистрируют экраны (план M3, задача 14). Последний
// зарегистрированный обработчик действия главный: окно поверх страницы перехватывает клавиши страницы.

type Handler = () => void;

const handlers = new Map<string, Handler[]>();

/** Пока компонент на экране, действие клавиши выполняет handler. */
export function useHotkey(action: string, handler: Handler, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const list = handlers.get(action) ?? [];
    list.push(handler);
    handlers.set(action, list);
    return () => {
      const current = handlers.get(action) ?? [];
      handlers.set(
        action,
        current.filter((h) => h !== handler),
      );
    };
  }, [action, handler, enabled]);
}

/** Выполнить действие клавиши. false: на этом экране у действия нет обработчика. */
export function runHotkey(action: string): boolean {
  const handler = handlers.get(action)?.at(-1);
  if (!handler) return false;
  handler();
  return true;
}

export type Command = { id: string; label: string; group: string; run: () => void };

const commandSets = new Map<string, Command[]>();
const listeners = new Set<() => void>();
let snapshot: Command[] = [];
const publish = () => {
  snapshot = [...commandSets.values()].flat();
  for (const listener of listeners) listener();
};

/** Команды экрана для палитры: пока компонент на экране. */
export function useCommands(key: string, commands: Command[]): void {
  useEffect(() => {
    commandSets.set(key, commands);
    publish();
    return () => {
      commandSets.delete(key);
      publish();
    };
  }, [key, commands]);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const EMPTY: Command[] = [];

/** Текущие команды экранов. */
export function useScreenCommands(): Command[] {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
}
