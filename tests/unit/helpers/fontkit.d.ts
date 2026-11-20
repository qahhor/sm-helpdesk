// У пакета fontkit нет описаний типов. Тестам нужна одна функция.
declare module 'fontkit' {
  export function create(buffer: Buffer): { characterSet: number[] };
}
