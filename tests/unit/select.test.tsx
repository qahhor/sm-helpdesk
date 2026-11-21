import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { Select } from '@/ui/components/select';

// Список выбора одного вида во всех формах (вторая проверка M2): высота, рамка и видимый фокус, как у поля ввода.

test('список выбора: размер и цвет из токенов, видимый фокус с клавиатуры, свои классы добавляются', () => {
  const html = renderToStaticMarkup(
    <Select id="field-impact" name="impact" className="max-w-xs" defaultValue="b">
      <option value="a">A</option>
      <option value="b">B</option>
    </Select>,
  );
  expect(html).toMatch(/^<select /);
  expect(html).toContain('id="field-impact"');
  expect(html).toContain('name="impact"');
  for (const part of ['h-field', 'rounded-control', 'border-input', 'bg-card', 'focus-visible:ring-2', 'aria-invalid:border-destructive', 'max-w-xs'])
    expect(html, part).toContain(part);
});
