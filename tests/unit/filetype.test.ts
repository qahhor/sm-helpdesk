import { expect, test } from 'vitest';
import { sniffFileType } from '@/modules/hdc/filetype';

// Настоящий тип файла по первым байтам (угроза T6, решение 0027).

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);
const withTail = (head: Uint8Array) => {
  const out = new Uint8Array(head.length + 32);
  out.set(head);
  return out;
};

test('картинки, PDF, ZIP, OLE и MP4 по сигнатурам', () => {
  expect(sniffFileType(withTail(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)))).toBe('png');
  expect(sniffFileType(withTail(bytes(0xff, 0xd8, 0xff, 0xe0)))).toBe('jpeg');
  expect(sniffFileType(withTail(text('GIF89a')))).toBe('gif');
  expect(sniffFileType(withTail(text('GIF87a')))).toBe('gif');
  expect(sniffFileType(withTail(text('RIFF\0\0\0\0WEBPVP8 ')))).toBe('webp');
  expect(sniffFileType(withTail(text('\0\0\0\x18ftypheic')))).toBe('heic');
  expect(sniffFileType(withTail(text('\0\0\0\x18ftypmif1')))).toBe('heic');
  expect(sniffFileType(withTail(text('\0\0\0\x20ftypisom')))).toBe('mp4');
  expect(sniffFileType(withTail(text('\0\0\0\x18ftypmp42')))).toBe('mp4');
  expect(sniffFileType(withTail(text('%PDF-1.7\n')))).toBe('pdf');
  expect(sniffFileType(withTail(bytes(0x50, 0x4b, 0x03, 0x04)))).toBe('zip');
  expect(sniffFileType(withTail(bytes(0x50, 0x4b, 0x05, 0x06)))).toBe('zip');
  expect(sniffFileType(withTail(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)))).toBe('ole');
});

test('HTML и SVG узнаются и в файле с другим расширением, в том числе после BOM и пробелов', () => {
  expect(sniffFileType(text('<!DOCTYPE html><html><body>отчёт</body></html>'))).toBe('html');
  expect(sniffFileType(text('﻿  \n<html lang="ru">'))).toBe('html');
  expect(sniffFileType(text('<script>alert(1)</script>'))).toBe('html');
  expect(sniffFileType(text('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('svg');
  expect(sniffFileType(text('<?xml version="1.0"?>\n<!-- c -->\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('svg');
  // Обычный XML и текст с тегами внутри остаются текстом.
  expect(sniffFileType(text('<?xml version="1.0"?><orders><order id="1"/></orders>'))).toBe('text');
  expect(sniffFileType(text('2026-11-21 ошибка: ответ <html> от сервера'))).toBe('text');
});

test('исполняемые файлы, текст и неизвестное', () => {
  expect(sniffFileType(withTail(text('MZ\x90\0')))).toBe('executable');
  expect(sniffFileType(withTail(text('\x7fELF')))).toBe('executable');
  expect(sniffFileType(withTail(bytes(0xcf, 0xfa, 0xed, 0xfe)))).toBe('executable');
  expect(sniffFileType(text('код;название\n1;Заказ\n'))).toBe('text');
  expect(sniffFileType(text('{"a": 1}'))).toBe('text');
  expect(sniffFileType(bytes(0x01, 0x02, 0x00, 0x03))).toBe('unknown');
  expect(sniffFileType(bytes())).toBe('unknown');
});
