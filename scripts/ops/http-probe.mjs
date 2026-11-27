#!/usr/bin/env node
// Замер времени ответа по HTTP (план M9, задача 10, решение 14; ТЗ 15.1; пороги раздела 4.3 аудита 23.11.2026 и
// FR-SOL-14). Только Node.js: fetch по очереди, прогрев, затем 40 запросов на адрес, p50 и p95 против порога. Только
// против staging с синтетическими данными (tests/perf/pilot-seed.ts): ключ --target staging обязателен, адрес
// production (HUB_PRODUCTION_URL или hub.smartup24.com) отклоняется. Куки сессии берутся из HUB_PROBE_COOKIE,
// заголовок Authorization (токен виджета для подсказки) из HUB_PROBE_AUTHORIZATION; в вывод они не попадают.
//
// Запуск: HUB_PROBE_COOKIE='...' node scripts/ops/http-probe.mjs --target staging --base https://<staging>
//   [--list <файл.json>] [--paths /a,/b] [--count 40] [--warmup 5]
// Файл списка: [{ "path": "/ru/tickets", "target": 300 }, { "path": "/api/suggest", "target": 500, "method": "POST",
// "body": {...}, "auth": true }]. Код завершения 1, если хоть одна строка не держит порог.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Адрес production по умолчанию (ТЗ 13.10, решение 70): замер на нём запрещён всегда. */
const PRODUCTION_HOSTS = new Set(['hub.smartup24.com']);

/**
 * Страницы по умолчанию и пороги p95 в мс: страницы клиента 300 (аудит 4.3), страницы рабочего места 600 (сигнал
 * тревоги страницы клиента; у запроса очереди своя цель 50 мс проверяется замером функций, решение 0068).
 */
export const DEFAULT_PATHS = [
  { path: '/ru/tickets', target: 300 },
  { path: '/ru/ideas', target: 300 },
  { path: '/ru/problems', target: 300 },
  { path: '/ru/agent/queues?queue=new', target: 600 },
  { path: '/ru/agent/queues?queue=all', target: 600 },
  { path: '/ru/agent/metrics?period=30', target: 600 },
];

/**
 * @typedef {{ path: string; target: number; method?: string; body?: unknown; auth?: boolean }} ProbeItem
 * @typedef {{ url: string; p50: number; p95: number; target: number; ok: boolean; status: number }} ProbeResult
 */

/** @param {number[]} values @param {number} p перцентиль 0-100 методом ближайшего ранга */
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1];
}

/**
 * Отказ, если цель не staging или адрес похож на production.
 * @param {{ target: string | undefined; base: string }} args @param {Record<string, string | undefined>} env
 */
export function assertStagingTarget(args, env) {
  if (args.target !== 'staging') throw new Error('Замер только против staging: укажите --target staging');
  const url = new URL(args.base);
  const host = url.hostname.toLowerCase();
  const production = env.HUB_PRODUCTION_URL ? new URL(env.HUB_PRODUCTION_URL) : null;
  if (PRODUCTION_HOSTS.has(host) || (production && production.hostname.toLowerCase() === host)) throw new Error('Адрес production: замер на нём запрещён, данные production не трогаются');
}

/**
 * @param {ProbeItem[]} items
 * @param {{ base: string; cookie?: string; authorization?: string; warmup?: number; count?: number }} opts
 * @returns {Promise<ProbeResult[]>}
 */
export async function probe(items, opts) {
  const warmup = opts.warmup ?? 5;
  const count = opts.count ?? 40;
  /** @type {ProbeResult[]} */
  const results = [];
  for (const item of items) {
    const url = new URL(item.path, opts.base).toString();
    /** @type {Record<string, string>} */
    const headers = { 'User-Agent': 'smartup-hub-probe' };
    if (opts.cookie) headers.Cookie = opts.cookie;
    if (item.auth && opts.authorization) headers.Authorization = opts.authorization;
    if (item.body !== undefined) headers['Content-Type'] = 'application/json';
    const init = { method: item.method ?? 'GET', headers, redirect: /** @type {const} */ ('manual'), ...(item.body !== undefined && { body: JSON.stringify(item.body) }) };
    let status = 0;
    const once = async () => {
      const start = performance.now();
      const response = await fetch(url, init);
      await response.arrayBuffer();
      status = response.status;
      return performance.now() - start;
    };
    for (let i = 0; i < warmup; i++) await once();
    /** @type {number[]} */
    const times = [];
    let allOk = true;
    for (let i = 0; i < count; i++) {
      times.push(await once());
      if (status < 200 || status >= 300) allOk = false;
    }
    const p50 = Math.round(percentile(times, 50));
    const p95 = Math.round(percentile(times, 95));
    results.push({ url, p50, p95, target: item.target, ok: allOk && p95 <= item.target, status });
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name) => {
    const at = process.argv.indexOf(`--${name}`);
    return at > 0 ? process.argv[at + 1] : undefined;
  };
  const base = arg('base');
  try {
    if (!base) throw new Error('Укажите --base <адрес staging>');
    assertStagingTarget({ target: arg('target'), base }, process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const list = arg('list');
  const paths = arg('paths');
  /** @type {ProbeItem[]} */
  const items = list ? JSON.parse(readFileSync(list, 'utf8')) : paths ? paths.split(',').map((path) => ({ path, target: 300 })) : DEFAULT_PATHS;
  const results = await probe(items, {
    base,
    cookie: process.env.HUB_PROBE_COOKIE,
    authorization: process.env.HUB_PROBE_AUTHORIZATION,
    count: Number(arg('count') ?? 40),
    warmup: Number(arg('warmup') ?? 5),
  });
  for (const r of results) {
    const path = new URL(r.url).pathname + new URL(r.url).search;
    console.log(`${r.ok ? 'держится' : 'не держится'}: ${path} p50 ${r.p50} мс, p95 ${r.p95} мс, порог ${r.target} мс, ответ ${r.status}`);
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
