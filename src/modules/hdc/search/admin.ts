import 'server-only';
import type { SystemActor } from '@/db/with-actor';
import { withActor } from '@/db/with-actor';
import { writeAudit } from '../audit';
import { createProcessKeys, type ProcessKeys } from './keys';

// Команда hub search:keys (план W6, решение 3): ключи процессов от главного ключа. В журнал аудита идут только
// описания ключей и число удалённых прежних, без значений.

export async function issueSearchKeys(actor: SystemActor, input: { url: string; masterKey: string; rotate: boolean }): Promise<ProcessKeys & { removed: number }> {
  const keys = await createProcessKeys(input.url, input.masterKey, { rotate: input.rotate });
  await withActor(actor, (tx) =>
    writeAudit(tx, { action: 'search.keys_created', objectType: 'search', objectId: 'keys', diff: { processes: ['client_search', 'staff_search', 'write'], rotated: input.rotate, removed: keys.removed } }),
  );
  return keys;
}
