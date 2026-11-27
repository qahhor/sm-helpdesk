import 'server-only';

// Модуль hda: заглушка модели для тестов (CLAUDE.md: интерфейс, настоящая реализация и заглушка). Не слой api.

export { setAiClientForTests } from './client';
export { type BrokenMode, defaultStubResponse, hostileStubResponse, type StubCall, StubAiClient, STUB_MODEL } from './client/stub';
export { setFirstLineTimeoutForTests } from './first-line/run';
export { createAnthropicClient, ANTHROPIC_URL, ANTHROPIC_VERSION } from './client/anthropic';
export { StubAgentEventSender } from './agent/sender/stub';
