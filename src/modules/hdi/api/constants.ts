// Константы модуля hdi для страниц и интерфейса (страницы берут у модуля только слой api, docs/naming.md, раздел 5).
export {
  IDEA_BODY_MAX,
  IDEA_FILE_MAX_BYTES,
  IDEA_FILE_MIMES,
  IDEA_FILES_MAX,
  IDEA_STATUSES,
  IDEA_TITLE_MAX,
  type IdeaStatus,
  ideaRef,
  SIMILAR_MIN_WORDS,
  SIMILAR_QUERY_MAX,
} from '../pref';
export { parseIdeaNumber, wordCount } from '../util';
