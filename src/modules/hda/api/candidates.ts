import 'server-only';

// Модуль hda, слой api: кандидаты в решения для фонового процесса (план M5c, задача 9, решения 26-28). Узкий файл:
// обход, задание по обращению и ночной досчёт векторов. Всё от имени системы.

export { type CandidateConfig, candidateConfig, type CandidateJobResult, runCandidateJob, runCandidatesEmbed, runCandidatesSweep } from '../candidates/run';
