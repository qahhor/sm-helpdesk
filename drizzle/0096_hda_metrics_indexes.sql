-- Показатели AI-помощника (ТЗ FR-MET-06, FR-AI-18, FR-SOL-19; план M5b, задача 10).
--
-- Индексы журнала вызовов для показателей: сколько раз помощник ответил каждым решением (счётчик "использовано
-- помощником" в списке решений) и вызовы с решением кода за период (ответы и отмеченные неверными на странице
-- показателей). Таблиц и политик не добавляется.

CREATE INDEX hda_runs_i9 ON hda_runs (solution_id) WHERE decision = 'answer';
CREATE INDEX hda_runs_i10 ON hda_runs (created_on) WHERE decision IS NOT NULL;
COMMENT ON INDEX hda_runs_i9 IS 'Сколько раз помощник ответил решением (FR-SOL-19)';
COMMENT ON INDEX hda_runs_i10 IS 'Ответы, вопросы и передачи помощника за период для показателей (FR-MET-06)';
