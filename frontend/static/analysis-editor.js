/*
 * AnalysisEditor — edit AI-generated analyses (chunk analysis, word coach)
 * as a form generated from the data itself.
 *
 *   AnalysisEditor.open(container, data, {
 *     kind: 'chunk' | 'word',
 *     onSave: async edited => {...},   // throw to show an error
 *     onCancel: () => {...},
 *   });
 *
 * The editor keeps a working copy in memory; inputs carry a dotted path
 * ("chunks.0.examples.1.en") and update the copy as the user types.
 */
(function (global) {
  'use strict';

  const TOP_LEVEL_KEYS = {
    chunk: ['sentence_gist', 'cefr_level', 'chunks', 'template', 'template_example', 'no_chunk_reason'],
    word: ['basic_meaning', 'contextual_meaning', 'recognition', 'concept', 'collocation_groups',
      'sentence_building', 'similar_words', 'exercises'],
  };

  const LABELS = {
    sentence_gist: '整句大意', cefr_level: 'CEFR 难度', chunks: '语块', template: '整句骨架',
    template_example: '骨架示例', no_chunk_reason: '没有语块的原因', text: '原文', base_form: '通用形式',
    chunk_type: '类型', meaning_cn: '中文意思', nuance: '语感', collocations: '常见搭配（每行一条）',
    scenarios: '使用场景', examples: '例句', en: '英文', cn: '中文',
    basic_meaning: '基本义', contextual_meaning: '在本句中', recognition: '单词识别', morphology: '词根词缀',
    splittable: '可以拆分', parts: '组成部分', part: '部分', type: '类型', meaning: '含义',
    explanation: '说明', etymology: '词源', pronunciation: '发音', ipa_us: '美式音标', ipa_uk: '英式音标',
    syllables: '音节', stress: '重音', spelling_to_sound: '字母与发音', letters: '字母', sound: '发音',
    note: '说明', irregular: '不规则之处', pitfalls: '易错提醒', concept: '核心概念', core_en: '英文核心义',
    core_cn: '中文解释', mental_picture: '概念画面', senses: '语义范围', pos: '词性', sense_en: '英文义',
    sense_cn: '中文义', link: '与核心义的联系', usage: '使用场景', daily: '日常对话',
    work_academic: '工作 / 学术', most_natural: '什么时候最自然', prefer_others: '母语者更常用的说法',
    collocation_groups: '固定搭配', category: '类别', items: '搭配', phrase: '搭配', example: '例句',
    sentence_building: '句子构建', forms: '词性与变化', patterns: '常见句型', pattern: '句型',
    common_errors: '常见错误', wrong: '错误写法', right: '正确写法', why: '原因', scene: '场景',
    similar_words: '近义词辨析', word: '单词', core: '核心区别', collocation: '搭配区别',
    not_interchangeable: '不能互换的情况', exercises: '练习', question: '题目', options: '选项（每行一个）',
    answer: '参考答案',
  };

  // Enumerated fields: "<parent list key>.<field>" first, then "<field>"
  const ENUMS = {
    'chunks.chunk_type': [
      ['workplace_expression', '职场表达'], ['collocation', '固定搭配'], ['sentence_frame', '惯用框架'],
      ['phrasal_verb', '短语动词'], ['softener', '委婉缓和'], ['transition', '转折衔接'],
      ['stance', '表态'], ['buying_time', '争取时间'],
    ],
    cefr_level: [['A2', 'A2'], ['B1', 'B1'], ['B2', 'B2'], ['C1', 'C1'], ['C2', 'C2']],
    'parts.type': [['prefix', '前缀'], ['root', '词根'], ['suffix', '后缀'], ['word', '组成词']],
    'collocation_groups.category': [
      ['verb', '动词搭配'], ['noun', '名词搭配'], ['adj_adv', '形容词 / 副词搭配'],
      ['preposition', '介词搭配'], ['phrase', '固定表达'],
    ],
    'examples.scene': [['daily', '日常生活'], ['work', '学习 / 工作'], ['academic', '学术 / 专业']],
    'exercises.type': [['choose', '场景选择'], ['translate', '中译英'], ['compare', '搭配辨析']],
  };

  const editors = new WeakMap();

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => (
      {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]
    ));
  }

  function clone(value) { return JSON.parse(JSON.stringify(value ?? null)); }

  function blankLike(value) {
    if (Array.isArray(value)) return [];
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, blankLike(item)]));
    }
    if (typeof value === 'boolean') return false;
    return '';
  }

  function enumFor(parentKey, key) {
    return ENUMS[`${parentKey}.${key}`] || ENUMS[key] || null;
  }

  function getAt(root, path) {
    return path.reduce((node, key) => (node == null ? undefined : node[key]), root);
  }

  function renderValue(value, path, key, parentKey) {
    const pathAttr = esc(path.join('.'));
    const label = LABELS[key] || key;
    if (typeof value === 'boolean') {
      return `<label class="ae-check"><input type="checkbox" data-ae-path="${pathAttr}"${value ? ' checked' : ''}> ${esc(label)}</label>`;
    }
    if (Array.isArray(value)) {
      if (value.every(item => typeof item === 'string')) {
        return `<label class="ae-field"><span>${esc(label)}</span>
          <textarea data-ae-path="${pathAttr}" data-ae-lines rows="${Math.max(2, value.length + 1)}">${esc(value.join('\n'))}</textarea></label>`;
      }
      const items = value.map((item, index) => `
        <fieldset class="ae-item">
          <legend>${esc(label)} ${index + 1}
            <button type="button" data-ae-remove="${pathAttr}" data-ae-index="${index}">删除</button></legend>
          ${renderObject(item, [...path, index], key)}
        </fieldset>`).join('');
      return `<div class="ae-list"><div class="ae-list-title">${esc(label)}</div>${items || '<p class="ae-empty">（空）</p>'}
        ${value.length ? `<button type="button" class="ae-add" data-ae-add="${pathAttr}">＋ 添加一条${esc(label)}</button>` : ''}</div>`;
    }
    if (value && typeof value === 'object') {
      return `<fieldset class="ae-group"><legend>${esc(label)}</legend>${renderObject(value, path, key)}</fieldset>`;
    }
    const options = enumFor(parentKey, key);
    if (options) {
      const known = options.some(([optionValue]) => optionValue === value);
      return `<label class="ae-field"><span>${esc(label)}</span><select data-ae-path="${pathAttr}">
        ${known ? '' : `<option value="${esc(value)}" selected>${esc(value || '（未选择）')}</option>`}
        ${options.map(([optionValue, optionLabel]) => `<option value="${esc(optionValue)}"${optionValue === value ? ' selected' : ''}>${esc(optionLabel)}</option>`).join('')}
      </select></label>`;
    }
    const text = String(value ?? '');
    const rows = Math.min(8, Math.max(1, Math.ceil(text.length / 60)));
    return `<label class="ae-field"><span>${esc(label)}</span><textarea data-ae-path="${pathAttr}" rows="${rows}">${esc(text)}</textarea></label>`;
  }

  function renderObject(object, path, parentKey) {
    if (!object || typeof object !== 'object') return renderValue(object, path, parentKey, parentKey);
    return Object.entries(object).map(([key, value]) => renderValue(value, [...path, key], key, parentKey)).join('');
  }

  function renderForm(state) {
    const keys = TOP_LEVEL_KEYS[state.kind] || Object.keys(state.working);
    return keys.filter(key => key in state.working)
      .map(key => renderValue(state.working[key], [key], key, '')).join('');
  }

  function rerender(container) {
    const state = editors.get(container);
    container.querySelector('.ae-form').innerHTML = renderForm(state);
  }

  function parsePath(text) {
    return text.split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part));
  }

  function prune(value) {
    // Drop list entries the user emptied completely
    if (Array.isArray(value)) {
      return value.map(prune).filter(item => {
        if (typeof item === 'string') return item.trim() !== '';
        if (item && typeof item === 'object') return Object.values(item).some(v => (typeof v === 'string' ? v.trim() : v && (!Array.isArray(v) || v.length)));
        return true;
      });
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, prune(item)]));
    }
    return typeof value === 'string' ? value.trim() : value;
  }

  function open(container, data, opts = {}) {
    ensureStyles();
    const state = {kind: opts.kind || 'word', working: clone(data), opts};
    editors.set(container, state);
    container.innerHTML = `<div class="analysis-editor">
      <p class="ae-hint">修改后点「保存」。清空某一条的全部内容，保存时会自动删除这一条。</p>
      <div class="ae-form">${renderForm(state)}</div>
      <div class="ae-actions">
        <button type="button" class="ae-save" data-ae-save>保存</button>
        <button type="button" data-ae-cancel>取消</button>
        <span class="ae-status" aria-live="polite"></span>
      </div>
    </div>`;
    if (!container.dataset.aeBound) {
      container.dataset.aeBound = '1';
      container.addEventListener('input', onInput);
      container.addEventListener('change', onInput);
      container.addEventListener('click', onClick);
    }
  }

  function onInput(event) {
    const container = event.currentTarget;
    const state = editors.get(container);
    const input = event.target.closest('[data-ae-path]');
    if (!state || !input) return;
    const path = parsePath(input.dataset.aePath);
    const parent = getAt(state.working, path.slice(0, -1));
    if (!parent) return;
    const key = path[path.length - 1];
    if (input.type === 'checkbox') parent[key] = input.checked;
    else if ('aeLines' in input.dataset) parent[key] = input.value.split('\n');
    else parent[key] = input.value;
  }

  async function onClick(event) {
    const container = event.currentTarget;
    const state = editors.get(container);
    if (!state) return;
    const remove = event.target.closest('[data-ae-remove]');
    if (remove) {
      const list = getAt(state.working, parsePath(remove.dataset.aeRemove));
      if (Array.isArray(list)) list.splice(Number(remove.dataset.aeIndex), 1);
      rerender(container);
      return;
    }
    const add = event.target.closest('[data-ae-add]');
    if (add) {
      const list = getAt(state.working, parsePath(add.dataset.aeAdd));
      if (Array.isArray(list) && list.length) list.push(blankLike(list[0]));
      rerender(container);
      return;
    }
    if (event.target.closest('[data-ae-cancel]')) {
      editors.delete(container);
      state.opts.onCancel?.();
      return;
    }
    const save = event.target.closest('[data-ae-save]');
    if (save) {
      const status = container.querySelector('.ae-status');
      save.disabled = true;
      status.textContent = '正在保存…';
      try {
        await state.opts.onSave?.(prune(state.working));
        editors.delete(container);
      } catch (error) {
        status.textContent = `保存失败：${error.message}`;
        save.disabled = false;
      }
    }
  }

  let stylesInjected = false;
  function ensureStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .analysis-editor { --ae-line: var(--line, #d9ded8); --ae-brand: var(--brand-dark, #245548); text-align: left; }
      .ae-hint { margin: 0 0 8px; color: var(--muted, #687069); font-size: 12px; }
      .ae-form { display: grid; gap: 8px; }
      .ae-field { display: grid; gap: 3px; }
      .ae-field > span, .ae-list-title { color: var(--ae-brand); font-size: 11px; font-weight: 850; letter-spacing: .04em; }
      .ae-field textarea, .ae-field select { width: 100%; box-sizing: border-box; padding: 5px 8px; border: 1px solid var(--ae-line);
        border-radius: 7px; background: white; font: inherit; font-size: 13.5px; line-height: 1.55; resize: vertical; }
      .ae-group, .ae-item { display: grid; gap: 7px; margin: 0; padding: 8px 10px; border: 1px solid var(--ae-line); border-radius: 8px; }
      .ae-group > legend, .ae-item > legend { padding: 0 4px; color: var(--ae-brand); font-size: 12px; font-weight: 800; }
      .ae-item > legend button { margin-left: 6px; padding: 0 7px; font-size: 11px; }
      .ae-list { display: grid; gap: 6px; }
      .ae-add { justify-self: start; padding: 2px 10px; font-size: 12px; }
      .ae-empty { margin: 0; color: var(--muted, #687069); font-size: 12px; }
      .ae-check { font-size: 13px; }
      .ae-actions { position: sticky; bottom: 0; display: flex; align-items: center; gap: 8px; margin-top: 10px; padding: 8px 0;
        background: inherit; }
      .ae-save { border-color: var(--ae-brand); background: var(--ae-brand); color: white; }
      .ae-status { color: var(--muted, #687069); font-size: 12px; }
    `;
    document.head.appendChild(style);
  }

  global.AnalysisEditor = {open};
})(window);
