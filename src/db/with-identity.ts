import 'server-only';
import { getAuthDb } from './auth-client';
import { createWithActor, type WithActor } from './with-actor';

// Транзакция под ролью hub_auth от имени актора. Механика та же, что у withActor (одна функция
// createWithActor на другом подключении): база узнаёт, кто выполняет запрос, из переменных транзакции,
// и политики RLS таблиц идентичности на них опираются. Так правило "права проверяются дважды" (ТЗ 9.4)
// действует и там, где данные меняет модуль идентичности: приглашения, роли, сотрудники, реестр серверов.
//
// Актор строится только из проверенной сессии. Действия без пользователя (первый вход через Smartup,
// принятие приглашения, команда консоли) выполняет актор system с названием задачи.

/** То же, что createWithActor: для подключения роли hub_auth. */
export const createWithIdentity = createWithActor;

export const withIdentity: WithActor = (actor, fn) => createWithActor(getAuthDb())(actor, fn);
