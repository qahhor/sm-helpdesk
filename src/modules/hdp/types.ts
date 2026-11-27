import type { Locale } from '@/i18n/locales';
import type { ProblemStatus } from './pref';

// Модуль hdp: типы для страниц и других модулей.

/** Строка списка проблем у сотрудника (FR-KP-10, FR-ADM-12). */
export type ProblemRow = {
  problemId: string;
  number: number;
  internalTitle: string;
  status: ProblemStatus;
  moduleId: string | null;
  showToClients: boolean;
  ticketCount: number;
  orgCount: number;
  firstSeenOn: Date | null;
  lastSeenOn: Date | null;
};

/** Что видит клиент (решение 2): без внутреннего названия, владельца, счётчиков, сигнатур и организаций. */
export type PublicProblem = {
  number: number;
  status: ProblemStatus;
  moduleId: string | null;
  locale: Locale;
  publicTitle: string;
  publicBody: string;
  fixedOn: Date | null;
  /** Обходной путь: только решение, опубликованное для клиентов на языке клиента (hdk_published). */
  workaround: { number: number; slug: string; title: string } | null;
};
