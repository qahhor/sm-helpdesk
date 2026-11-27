import 'server-only';
import * as z from 'zod';
import { acceptCodeScanTx } from '../../code/scan';
import { codeScanReport } from '../../code/report';
import { CODE_MAX_LINES } from '../../pref';
import { defineTool } from '../tool';
import { AGENT_NOTICE, notice, str, UNTRUSTED_HINT } from '../util';

// Инструменты знаний из кода сервера MCP (веха M8c; ТЗ 7.22 FR-CODE-01, 03, 05, 08, 12; FR-AGT-04; план M8c,
// решения 3, 5, 20). code_catalog_upsert принимает отчёт о сканировании целиком: черновики каталога ошибок и карты
// модулей. Портал хранит только выводы: отчёт с полем больше 10 строк или с регулярным выражением в шаблоне
// отклоняется целиком, выражения для сопоставления строит база. Утвердить запись агент не может.

const reasons = z.array(z.strictObject({ rule: str(40), path: str(200) })).max(50);
const counts = { added: z.number().int().min(0), changed: z.number().int().min(0), removed: z.number().int().min(0) };

export const codeCatalogUpsert = defineTool({
  name: 'code_catalog_upsert',
  kind: 'write',
  description: `Submit the weekly code scan report of one Smartup repository: the module and screen map and the error catalog (section 7.22). The portal stores conclusions only, never source code: the whole report is rejected if any text field is longer than ${CODE_MAX_LINES} lines or a message template contains regular expression syntax. Message templates are plain text with named placeholders like {product}; the portal builds the matching itself. Code locations are references only: object, relative file path, line. Entries arrive as drafts for staff approval; changed entries return to draft. Resubmitting the same scanId of the same repository changes nothing. ${UNTRUSTED_HINT}`,
  input: codeScanReport,
  output: z.strictObject({
    notice,
    status: z.enum(['accepted', 'rejected']),
    scan_key: str(40),
    duplicate: z.boolean().optional(),
    ...counts,
    unchanged: z.number().int().min(0),
    modules: z.strictObject(counts),
    reasons,
  }),
  async run(tx, actor, report) {
    const outcome = await acceptCodeScanTx(tx, actor, report);
    const refs = [{ kind: 'code_scan' as const, ref: outcome.scanId }];
    const empty = { added: 0, changed: 0, removed: 0 };
    if (outcome.status === 'rejected')
      return { result: { notice: AGENT_NOTICE, status: 'rejected' as const, scan_key: outcome.scanKey, ...empty, unchanged: 0, modules: empty, reasons: outcome.reasons }, objectRefs: refs };
    return {
      result: {
        notice: AGENT_NOTICE,
        status: 'accepted' as const,
        scan_key: outcome.scanKey,
        duplicate: outcome.duplicate,
        added: outcome.added,
        changed: outcome.changed,
        removed: outcome.removed,
        unchanged: outcome.unchanged,
        modules: outcome.modules,
        reasons: [],
      },
      objectRefs: refs,
    };
  },
});

export const codeTools = [codeCatalogUpsert];
