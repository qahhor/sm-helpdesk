// Параметры адреса страницы (searchParams): значение может прийти строкой или списком.

/** Первое значение параметра. */
export const firstParam = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);
