import { registerSearchSources } from '@/modules/hdc/api';
import { buildIdeaDocs, pageIdeaIds } from '@/modules/hdi/api/search-docs';
import { buildSolutionDocs, pageSolutionIds, resolveCurations } from '@/modules/hdk/api/search-docs';
import { buildTicketDocs, buildTicketTextDocs, pageTicketIds, pageTicketTextIds, removeTicketTexts } from '@/modules/hdt/api/search-docs';
import { buildOrgDocs, buildPersonDocs, pageOrgIds, pagePersonIds } from '@/modules/hdu/api/search-docs';

// Источники документов индекса поиска (план W6, задача 3): фоновый процесс и команда hub собирают построители
// модулей-владельцев. Ядро (hdc) не знает таблиц модулей и получает построители отсюда. Частью модуля не является.

let registered = false;

export function registerSearch(): void {
  if (registered) return;
  registered = true;
  registerSearchSources(
    {
      ticket: { collection: 'tickets', build: buildTicketDocs, pageIds: pageTicketIds, afterRemove: removeTicketTexts },
      ticket_text: { collection: 'ticket_texts', build: buildTicketTextDocs, pageIds: pageTicketTextIds },
      solution: { collection: 'solutions', build: buildSolutionDocs, pageIds: pageSolutionIds, ownerField: 'article_id' },
      idea: { collection: 'ideas', build: buildIdeaDocs, pageIds: pageIdeaIds, ownerField: 'idea_id' },
      org: { collection: 'orgs', build: buildOrgDocs, pageIds: pageOrgIds },
      person: { collection: 'people', build: buildPersonDocs, pageIds: pagePersonIds },
    },
    resolveCurations,
  );
}
