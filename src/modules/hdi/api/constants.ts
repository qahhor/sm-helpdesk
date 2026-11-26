// Константы модуля hdi для страниц и интерфейса (страницы берут у модуля только слой api, docs/naming.md, раздел 5).
export {
  IDEA_BODY_MAX,
  IDEA_FILE_MAX_BYTES,
  IDEA_FILE_MIMES,
  IDEA_FILES_MAX,
  IDEA_STATUSES,
  IDEA_TITLE_MAX,
  BOARD_QUERY_MAX,
  BOARD_TABS,
  type BoardTab,
  COMMENT_MAX,
  DECLINE_REASON_MAX,
  EXPLANATION_MAX,
  RELEASE_VERSION_MAX,
  type IdeaStatus,
  ideaRef,
  SIMILAR_MIN_WORDS,
  SIMILAR_QUERY_MAX,
} from '../pref';
export { cycleCountdown, cycleMonth, parseIdeaNumber, tashkentDate, wordCount } from '../util';
