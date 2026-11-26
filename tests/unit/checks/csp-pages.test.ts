import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { appRoutes, cspCoverageGaps, cspPagesGaps, listedRoutes } from '../../../scripts/checks/csp-pages.mjs';
import { CSP_HANDLERS, CSP_PAGES } from '../../e2e/helpers/csp-pages';

// Полнота обхода политики содержимого (план подготовки M9, задача 2, решение 2): каждая страница и каждый
// обработчик приложения есть в списке браузерного теста tests/e2e/csp-all-pages.spec.ts.

function fakeApp(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'csp-pages-'));
  for (const file of files) {
    const path = join(root, file);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'export default function Page() { return null; }\n');
  }
  return root;
}

test('страницы и обработчики собираются из каталога приложения, группы маршрутов сохраняются', () => {
  const root = fakeApp(['[locale]/(portal)/tickets/[number]/page.tsx', '[locale]/(portal)/layout.tsx', 'api/health/route.ts', '[locale]/(portal)/Form.tsx']);
  expect(appRoutes(root)).toEqual({ pages: ['[locale]/(portal)/tickets/[number]'], handlers: ['api/health'] });
});

test('страница без строки обхода и лишняя строка обхода называются', () => {
  const gaps = cspCoverageGaps({ pages: ['[locale]/(portal)/ideas', '[locale]/(portal)/tickets'], handlers: ['api/health'] }, { pages: ['[locale]/(portal)/tickets', '[locale]/(portal)/gone'], handlers: [] });
  expect(gaps).toEqual([
    'страница [locale]/(portal)/ideas не входит в обход tests/e2e/helpers/csp-pages.ts',
    'обработчик api/health не входит в обход tests/e2e/helpers/csp-pages.ts',
    'в обходе tests/e2e/helpers/csp-pages.ts нет такой страницы: [locale]/(portal)/gone',
  ]);
});

test('каждая страница и каждый обработчик приложения есть в обходе браузерного теста', () => {
  const listed = { pages: CSP_PAGES.map((p) => p.route), handlers: CSP_HANDLERS.map((h) => h.route) };
  expect(cspCoverageGaps(appRoutes(), listed)).toEqual([]);
});

test('в обходе каждая группа маршрутов представлена страницей для браузерной проверки', () => {
  const groups = new Set(appRoutes().pages.map((route: string) => /\(([^)]+)\)/.exec(route)?.[1] ?? 'root'));
  const walked = new Set(CSP_PAGES.filter((p) => p.walk).map((p) => /\(([^)]+)\)/.exec(p.route)?.[1] ?? 'root'));
  expect([...groups].filter((g) => !walked.has(g))).toEqual([]);
});

test('адрес страницы в обходе соответствует её маршруту', () => {
  for (const page of CSP_PAGES) {
    // Шаблон адреса: группы убираются, сегменты [x] и [...x] заменяются значением.
    const pattern = page.route
      .split('/')
      .filter((segment) => !/^\(.+\)$/.test(segment))
      .map((segment) => (segment === '[locale]' ? '(?:ru|uz|en)' : /^\[.+\]$/.test(segment) ? '[^/]+(?:/[^/]+)*' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/');
    expect(page.path.split('?')[0].split('#')[0], page.route).toMatch(new RegExp(`^/${pattern}$`));
  }
});

test('проверка правил читает из текста списка те же маршруты, что импортирует браузерный тест', () => {
  const listed = listedRoutes(readFileSync('tests/e2e/helpers/csp-pages.ts', 'utf8'));
  expect(listed).toEqual({ pages: CSP_PAGES.map((p) => p.route), handlers: CSP_HANDLERS.map((h) => h.route) });
  expect(cspPagesGaps()).toEqual([]);
});
