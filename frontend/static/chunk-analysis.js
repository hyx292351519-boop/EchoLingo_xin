/*
 * ChunkAnalysis — shared labels and helpers for the AI chunk analysis
 * (schema chunks_v3: Conversation Coach + Presentation Coach).
 *
 * Pages keep their own markup; this file only answers "what to show":
 *   ChunkAnalysis.typeLabel(chunk.chunk_type)
 *   ChunkAnalysis.groupByCoach(chunks)        -> [{coach, title, intro, items: [{chunk, index}]}]
 *   ChunkAnalysis.chunkExtraFields(chunk)     -> [[label, text], ...]   (plain text, caller escapes)
 *   ChunkAnalysis.textStyleLabel(data)        -> '' | '自然口语' ...
 *   ChunkAnalysis.spokenFeatures(data)        -> [{text, feature, is_error, note}]
 *   ChunkAnalysis.transfer(data)              -> null | {intent, rows: [[label, en, cn]], note}
 * Older chunks_v2 analyses have no coach fields and render as a single group.
 */
(function (global) {
  'use strict';

  const TYPE_LABELS = {
    // Conversation Coach
    discourse_marker: '话语标记', filler: '填充词', hedge: '弱化表达', colloquial: '口语习惯表达',
    attitude: '语气态度', collocation: '固定搭配', phrasal_verb: '短语动词',
    // Presentation Coach
    intro_topic: '介绍主题', intro_point: '引出观点', explain_concept: '解释概念',
    explain_mechanism: '解释原理', explain_reason: '解释原因', give_example: '举例说明',
    compare: '比较', describe_data: '讲解数据', emphasize: '强调重点', implication: '说明意义',
    transition: '衔接过渡', summarize: '总结',
    // chunks_v2 (workplace) and older
    sentence_frame: '惯用框架', workplace_expression: '职场表达', softener: '委婉缓和',
    stance: '表态', buying_time: '争取时间', fixed_expression: '固定表达', hedge_softener: '缓和语气',
  };

  const COACHES = {
    conversation: {title: '🗣 Conversation Coach · 地道口语', intro: '母语者真实交流里的语气词、弱化表达和习惯说法'},
    presentation: {title: '🎤 Presentation Coach · 讲解表达', intro: '能直接用于讲解、汇报和 PPT 演讲的表达语块'},
  };

  const REGISTER_LABELS = {daily: '日常交流', presentation: '课堂展示 / 一般讲解', academic: '正式学术汇报', any: '各种场合'};

  const TEXT_STYLE_LABELS = {
    spoken_natural: '自然口语', scripted_speech: '讲稿 / 演讲', written_formal: '正式书面语', textbook: '教材示范句',
  };

  const TRANSFER_SCENES = [['daily', '日常交流'], ['presentation', '一般讲解'], ['academic', '学术汇报']];

  // Option lists for the analysis editor (AnalysisEditor ENUMS)
  const TYPE_OPTIONS = Object.entries(TYPE_LABELS).filter(([key]) => !['fixed_expression', 'hedge_softener'].includes(key));
  const COACH_OPTIONS = [['conversation', '口语教练'], ['presentation', '讲解教练']];
  const REGISTER_OPTIONS = Object.entries(REGISTER_LABELS);
  const TEXT_STYLE_OPTIONS = [...Object.entries(TEXT_STYLE_LABELS), ['unclear', '无法判断']];

  function typeLabel(type) {
    return TYPE_LABELS[type] || type || '表达';
  }

  function groupByCoach(chunks) {
    const list = Array.isArray(chunks) ? chunks : [];
    if (!list.some(chunk => COACHES[chunk && chunk.coach])) {
      return list.length ? [{coach: '', title: '', intro: '', items: list.map((chunk, index) => ({chunk, index}))}] : [];
    }
    return Object.keys(COACHES).map(coach => ({
      coach,
      title: COACHES[coach].title,
      intro: COACHES[coach].intro,
      // chunks without a coach (hand-edited) go with conversation
      items: list.map((chunk, index) => ({chunk, index}))
        .filter(({chunk}) => (COACHES[chunk.coach] ? chunk.coach : 'conversation') === coach),
    })).filter(group => group.items.length);
  }

  function chunkExtraFields(chunk) {
    const fields = [];
    if (chunk.position_tone) fields.push(['位置与语气', chunk.position_tone]);
    if (chunk.register && REGISTER_LABELS[chunk.register]) fields.push(['适用场合', REGISTER_LABELS[chunk.register]]);
    if (chunk.caution) fields.push(['使用注意', chunk.caution]);
    return fields;
  }

  function textStyleLabel(data) {
    return TEXT_STYLE_LABELS[data && data.text_style] || '';
  }

  function spokenFeatures(data) {
    const items = data && Array.isArray(data.spoken_features) ? data.spoken_features : [];
    return items.filter(item => item && item.text && item.feature);
  }

  function transfer(data) {
    const raw = data && data.transfer;
    if (!raw || typeof raw !== 'object') return null;
    const rows = TRANSFER_SCENES
      .map(([scene, label]) => [label, String(raw[scene]?.en || ''), String(raw[scene]?.cn || '')])
      .filter(([, en]) => en);
    if (!rows.length && !raw.note) return null;
    return {intent: String(raw.intent_cn || ''), rows, note: String(raw.note || '')};
  }

  global.ChunkAnalysis = {
    TYPE_LABELS, TYPE_OPTIONS, COACH_OPTIONS, REGISTER_OPTIONS, TEXT_STYLE_OPTIONS,
    typeLabel, groupByCoach, chunkExtraFields, textStyleLabel, spokenFeatures, transfer,
  };
})(window);
