/*
 * Word Coach renderer — shared by the intensive page and the vocab workshop.
 *
 * WordCoach.isCoach(data)        → true for "word_coach_*" analyses
 * WordCoach.render(data, opts)   → HTML string (collapsible sections)
 *
 * Interaction (speak buttons, exercise answers and AI grading) is handled by
 * one delegated document listener, so rendered HTML can be inserted anywhere.
 */
(function (global) {
  'use strict';

  const CATEGORY_LABELS = {
    verb: '动词搭配', noun: '名词搭配', adj_adv: '形容词 / 副词搭配',
    preposition: '介词搭配', phrase: '固定表达',
  };
  const MORPHEME_LABELS = {prefix: '前缀', root: '词根', suffix: '后缀', word: '组成词'};
  const SCENE_LABELS = {daily: '日常生活', work: '学习 / 工作', academic: '学术 / 专业'};
  const EXERCISE_LABELS = {choose: '场景选择', translate: '中译英', compare: '搭配辨析'};
  const USAGE_LABELS = [
    ['daily', '日常对话'], ['work_academic', '工作 / 学术'],
    ['most_natural', '什么时候最自然'], ['prefer_others', '母语者更常用的其他说法'],
  ];
  const VERDICT_LABELS = {correct: '✓ 正确', partial: '△ 部分正确', incorrect: '✗ 需要修改'};

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => (
      {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]
    ));
  }

  function list(value) { return Array.isArray(value) ? value : []; }

  function speakButton(text) {
    if (!text) return '';
    return `<button type="button" class="wc-speak" data-wc-speak="${esc(encodeURIComponent(text))}" aria-label="朗读">🔊</button>`;
  }

  function field(label, value, extraClass = '') {
    if (!value) return '';
    return `<div class="wc-field ${extraClass}"><span class="wc-label">${esc(label)}</span><div>${esc(value)}</div></div>`;
  }

  function section(key, title, body, open) {
    if (!body) return '';
    return `<details class="wc-section" data-wc-section="${key}"${open ? ' open' : ''}>
      <summary>${esc(title)}</summary>
      <div class="wc-section-body">${body}</div>
    </details>`;
  }

  function renderRecognition(data) {
    const recognition = data.recognition || {};
    const morphology = recognition.morphology || {};
    const pron = recognition.pronunciation || {};
    const parts = list(morphology.parts);
    const morphHtml = `
      <h5>词根词缀</h5>
      ${parts.length ? `<div class="wc-parts">${parts.map(part => `
        <span class="wc-part"><strong>${esc(part.part)}</strong><small>${esc(MORPHEME_LABELS[part.type] || part.type)}</small>${part.meaning ? `<em>${esc(part.meaning)}</em>` : ''}</span>`).join('<span class="wc-plus">+</span>')}</div>` : ''}
      ${field(parts.length ? '如何组合' : '说明', morphology.explanation)}
      ${field('词源', morphology.etymology)}`;
    const ipa = pron.ipa_us === pron.ipa_uk || !pron.ipa_uk
      ? (pron.ipa_us ? `<span>${esc(pron.ipa_us)}</span>` : '')
      : `<span>美 ${esc(pron.ipa_us)}</span><span>英 ${esc(pron.ipa_uk)}</span>`;
    const spelling = list(pron.spelling_to_sound);
    const pronHtml = `
      <h5>自然拼读</h5>
      <div class="wc-ipa">${ipa}${pron.syllables ? `<span>音节：${esc(pron.syllables)}</span>` : ''}${speakButton(data.word)}</div>
      ${field('重音', pron.stress)}
      ${spelling.length ? `<table class="wc-table"><thead><tr><th>字母</th><th>发音</th><th>说明</th></tr></thead><tbody>${spelling.map(row => `
        <tr><td><strong>${esc(row.letters)}</strong></td><td>${esc(row.sound)}</td><td>${esc(row.note)}</td></tr>`).join('')}</tbody></table>` : ''}
      ${field('不规则之处', pron.irregular)}
      ${field('中文母语者易错', pron.pitfalls, 'wc-warn')}`;
    return morphHtml + pronHtml;
  }

  function renderConcept(data) {
    const concept = data.concept || {};
    const usage = concept.usage || {};
    const senses = list(concept.senses);
    return `
      ${concept.core_en ? `<p class="wc-core-en">${esc(concept.core_en)} ${speakButton(concept.core_en)}</p>` : ''}
      ${concept.core_cn ? `<p class="wc-core-cn">${esc(concept.core_cn)}</p>` : ''}
      ${concept.mental_picture ? `<div class="wc-picture"><span class="wc-label">概念画面</span>${esc(concept.mental_picture)}</div>` : ''}
      ${senses.length ? `<h5>语义范围</h5><ol class="wc-senses">${senses.map(sense => `
        <li>${sense.pos ? `<span class="wc-pos">${esc(sense.pos)}</span>` : ''}<strong>${esc(sense.sense_en)}</strong>${sense.sense_cn ? ` — ${esc(sense.sense_cn)}` : ''}
          ${sense.link ? `<div class="wc-muted">↳ ${esc(sense.link)}</div>` : ''}</li>`).join('')}</ol>` : ''}
      ${USAGE_LABELS.some(([key]) => usage[key]) ? `<h5>使用场景</h5>${USAGE_LABELS.map(([key, label]) => field(label, usage[key])).join('')}` : ''}`;
  }

  function renderCollocations(data) {
    const groups = list(data.collocation_groups);
    if (!groups.length) return '';
    return groups.map(group => `
      <h5>${esc(CATEGORY_LABELS[group.category] || group.category)}</h5>
      <ul class="wc-collocations">${list(group.items).map(item => `
        <li><div><strong>${esc(item.phrase)}</strong> ${speakButton(item.phrase)}
          ${item.cn ? `<span class="wc-cn">${esc(item.cn)}</span>` : ''}</div>
          ${item.en ? `<div class="wc-muted">${esc(item.en)}</div>` : ''}
          ${item.example ? `<div class="wc-example">${esc(item.example)} ${speakButton(item.example)}</div>` : ''}</li>`).join('')}</ul>`).join('');
  }

  function renderSentenceBuilding(data) {
    const building = data.sentence_building || {};
    const patterns = list(building.patterns);
    const errors = list(building.common_errors);
    const examples = list(building.examples);
    if (!building.forms && !patterns.length && !errors.length && !examples.length) return '';
    return `
      ${field('词性与变化', building.forms)}
      ${patterns.length ? `<h5>常见句型</h5><ul class="wc-patterns">${patterns.map(item => `
        <li><code>${esc(item.pattern)}</code>${item.note ? `<div class="wc-muted">${esc(item.note)}</div>` : ''}
          ${item.example ? `<div class="wc-example">${esc(item.example)} ${speakButton(item.example)}</div>` : ''}</li>`).join('')}</ul>` : ''}
      ${errors.length ? `<h5>常见错误</h5><ul class="wc-errors">${errors.map(item => `
        <li>${item.wrong ? `<s>${esc(item.wrong)}</s> → ` : ''}<strong>${esc(item.right)}</strong>
          ${item.why ? `<div class="wc-muted">${esc(item.why)}</div>` : ''}</li>`).join('')}</ul>` : ''}
      ${examples.length ? `<h5>不同场景的例句</h5><ul class="wc-examples">${examples.map(item => `
        <li><span class="wc-scene">${esc(SCENE_LABELS[item.scene] || item.scene)}</span>${esc(item.en)} ${speakButton(item.en)}
          ${item.cn ? `<div class="wc-muted">${esc(item.cn)}</div>` : ''}</li>`).join('')}</ul>` : ''}`;
  }

  function renderSimilarWords(data) {
    const words = list(data.similar_words);
    if (!words.length) return '';
    return words.map(item => `
      <div class="wc-similar">
        <strong>${esc(data.word)} vs. ${esc(item.word)}</strong>
        ${field('核心区别', item.core)}${field('使用场景', item.usage)}
        ${field('搭配', item.collocation)}${field('不能互换的情况', item.not_interchangeable)}
      </div>`).join('');
  }

  function renderExercises(data) {
    const exercises = list(data.exercises);
    if (!exercises.length) return '';
    return `<p class="wc-muted">先自己作答，再让 AI 批改；批改后会显示参考答案。</p>` + exercises.map((item, index) => {
      const payload = esc(encodeURIComponent(JSON.stringify({word: data.word, ...item})));
      const options = list(item.options);
      return `<div class="wc-exercise" data-wc-exercise="${payload}">
        <div class="wc-exercise-q"><span class="wc-scene">${index + 1}. ${esc(EXERCISE_LABELS[item.type] || '练习')}</span>${esc(item.question)}</div>
        ${options.length ? `<div class="wc-options">${options.map(option => `<button type="button" data-wc-option="${esc(option)}">${esc(option)}</button>`).join('')}</div>` : ''}
        <textarea class="wc-answer" rows="2" placeholder="${options.length ? '点选项或直接输入你的选择和理由…' : '写下你的英文句子…'}"></textarea>
        <div class="wc-exercise-actions">
          <button type="button" class="wc-check" data-wc-check>AI 批改</button>
          <button type="button" data-wc-reveal>直接看答案</button>
        </div>
        <div class="wc-exercise-result" aria-live="polite"></div>
      </div>`;
    }).join('');
  }

  function render(data, opts = {}) {
    ensureStyles();
    const head = `
      <div class="wc-head">
        ${data.basic_meaning || data.edited ? `<div class="wc-basic">${esc(data.basic_meaning || '')}${data.edited ? ' <span class="wc-edited">✎ 已编辑</span>' : ''}</div>` : ''}
        ${data.contextual_meaning ? `<div class="wc-context"><span class="wc-label">在本句中</span>${esc(data.contextual_meaning)}</div>` : ''}
      </div>`;
    return `<div class="word-coach">${head}
      ${section('recognition', '① 单词识别：词根词缀与发音', renderRecognition(data), false)}
      ${section('concept', '② 核心概念', renderConcept(data), true)}
      ${section('collocations', '③ 固定搭配与语块', renderCollocations(data), true)}
      ${section('sentence', '④ 句子构建', renderSentenceBuilding(data), false)}
      ${section('similar', '⑤ 近义词辨析', renderSimilarWords(data), false)}
      ${section('exercises', '⑥ 主动掌握练习', renderExercises(data), Boolean(opts.openExercises))}
    </div>`;
  }

  function isCoach(data) {
    return Boolean(data && typeof data === 'object' && String(data.schema || '').startsWith('word_coach_'));
  }

  function referenceHtml(exercise) {
    return `<div class="wc-reference"><span class="wc-label">参考答案</span>${esc(exercise.answer || '（无）')}
      ${exercise.explanation ? `<div class="wc-muted">${esc(exercise.explanation)}</div>` : ''}</div>`;
  }

  async function checkExercise(container) {
    const exercise = JSON.parse(decodeURIComponent(container.dataset.wcExercise || '%7B%7D'));
    const answer = container.querySelector('.wc-answer')?.value.trim() || '';
    const result = container.querySelector('.wc-exercise-result');
    const button = container.querySelector('[data-wc-check]');
    if (!answer) { result.innerHTML = '<span class="wc-muted">先写下你的答案。</span>'; return; }
    button.disabled = true;
    result.innerHTML = '<span class="wc-muted">AI 正在批改…</span>';
    const request = {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({...exercise, user_answer: answer}),
    };
    try {
      const response = global.eltCredits
        ? await global.eltCredits.billableFetch('practice_evaluation', '/api/word-exercise-check', request)
        : await fetch('/api/word-exercise-check', request);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(data.error || data.detail || '批改失败');
      result.innerHTML = `<div class="wc-verdict wc-verdict-${esc(data.verdict)}">${esc(VERDICT_LABELS[data.verdict] || data.verdict)}</div>
        <div>${esc(data.feedback)}</div>
        ${data.corrected ? `<div class="wc-example">改正：${esc(data.corrected)} ${speakButton(data.corrected)}</div>` : ''}
        ${data.better_expression ? `<div class="wc-example">更地道：${esc(data.better_expression)} ${speakButton(data.better_expression)}</div>` : ''}
        ${referenceHtml(exercise)}`;
    } catch (error) {
      result.innerHTML = `<span class="wc-error">批改失败：${esc(error.message)}</span>`;
    } finally {
      button.disabled = false;
    }
  }

  document.addEventListener('click', event => {
    const speak = event.target.closest('[data-wc-speak]');
    if (speak) {
      event.stopPropagation();
      const text = decodeURIComponent(speak.dataset.wcSpeak || '');
      if (text && global.NaturalTTS) global.NaturalTTS.speak(text, {lang: 'en-US', rate: 0.95});
      return;
    }
    const option = event.target.closest('[data-wc-option]');
    if (option) {
      const container = option.closest('[data-wc-exercise]');
      const input = container?.querySelector('.wc-answer');
      if (input) input.value = option.dataset.wcOption;
      container?.querySelectorAll('[data-wc-option]').forEach(button => button.classList.toggle('active', button === option));
      return;
    }
    const check = event.target.closest('[data-wc-check]');
    if (check) { checkExercise(check.closest('[data-wc-exercise]')); return; }
    const reveal = event.target.closest('[data-wc-reveal]');
    if (reveal) {
      const container = reveal.closest('[data-wc-exercise]');
      const exercise = JSON.parse(decodeURIComponent(container.dataset.wcExercise || '%7B%7D'));
      container.querySelector('.wc-exercise-result').innerHTML = referenceHtml(exercise);
    }
  });

  let stylesInjected = false;
  function ensureStyles() {
    if (stylesInjected || !global.document) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .word-coach { --wc-brand: var(--brand-dark, #245548); --wc-line: var(--line, #d9ded8); --wc-muted: var(--muted, #687069);
        --wc-soft: #f2f5f0; --wc-accent: #b8860b; display: grid; gap: 8px; line-height: 1.65; text-align: left; }
      .word-coach h5 { margin: 10px 0 5px; color: var(--wc-brand); font-size: 12px; font-weight: 850; letter-spacing: .04em; }
      .word-coach h5:first-child { margin-top: 0; }
      .wc-head { display: grid; gap: 6px; }
      .wc-basic { font-size: 15px; font-weight: 800; }
      .wc-edited { margin-left: 6px; padding: 0 7px; border-radius: 999px; background: #e7f1e9; color: var(--wc-brand); font-size: 11px; font-weight: 800; }
      .wc-context { padding: 7px 10px; border-radius: 8px; background: #fff9e9; }
      .wc-section { border: 1px solid var(--wc-line); border-radius: 9px; background: rgba(255,255,255,.85); }
      .wc-section > summary { padding: 8px 12px; cursor: pointer; font-weight: 800; color: var(--wc-brand); list-style-position: inside; }
      .wc-section[open] > summary { border-bottom: 1px solid var(--wc-line); }
      .wc-section-body { padding: 10px 12px 12px; }
      .wc-label { display: inline-block; margin-right: 6px; color: var(--wc-brand); font-size: 11px; font-weight: 850; letter-spacing: .04em; }
      .wc-field { margin-top: 5px; }
      .wc-field > div { display: inline; }
      .wc-warn { padding: 5px 9px; border-left: 3px solid #c0392b; background: #fdf1ef; border-radius: 0 6px 6px 0; }
      .wc-muted { color: var(--wc-muted); font-size: 13px; }
      .wc-cn { margin-left: 6px; color: var(--wc-muted); }
      .wc-parts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
      .wc-part { display: inline-grid; justify-items: center; padding: 5px 10px; border-radius: 8px; background: var(--wc-soft); }
      .wc-part small { color: var(--wc-muted); font-size: 11px; }
      .wc-part em { font-style: normal; font-size: 12px; }
      .wc-plus { color: var(--wc-muted); font-weight: 800; }
      .wc-ipa { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; font-size: 15px; }
      .wc-table { width: 100%; margin-top: 6px; border-collapse: collapse; font-size: 13px; }
      .wc-table th, .wc-table td { padding: 4px 6px; border-bottom: 1px solid var(--wc-line); text-align: left; vertical-align: top; }
      .wc-core-en { margin: 0 0 4px; font-size: 15px; font-weight: 700; }
      .wc-core-cn { margin: 0 0 8px; }
      .wc-picture { margin-bottom: 6px; padding: 8px 10px; border-left: 3px solid var(--wc-accent); border-radius: 0 6px 6px 0; background: #fff9e9; }
      .wc-senses, .wc-collocations, .wc-patterns, .wc-errors, .wc-examples { margin: 0; padding-left: 18px; }
      .wc-senses li, .wc-collocations li, .wc-patterns li, .wc-errors li, .wc-examples li { margin-bottom: 6px; }
      .wc-pos, .wc-scene { display: inline-block; margin-right: 6px; padding: 0 7px; border-radius: 999px; background: var(--wc-soft); color: var(--wc-brand); font-size: 11px; font-weight: 800; }
      .wc-example { margin-top: 2px; font-style: italic; }
      .wc-errors s { color: #a33b2f; }
      .wc-similar + .wc-similar { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--wc-line); }
      .wc-speak { min-height: 0; padding: 0 5px; border: 0; background: none; cursor: pointer; font-size: 13px; vertical-align: middle; }
      .wc-exercise { margin-top: 10px; padding: 10px; border: 1px dashed var(--wc-line); border-radius: 8px; }
      .wc-exercise-q { margin-bottom: 6px; font-weight: 700; }
      .wc-options { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
      .wc-options button { padding: 3px 10px; border: 1px solid var(--wc-line); border-radius: 999px; background: white; cursor: pointer; font-size: 13px; }
      .wc-options button.active { border-color: var(--wc-brand); background: var(--wc-brand); color: white; }
      .wc-answer { width: 100%; box-sizing: border-box; padding: 6px 9px; border: 1px solid var(--wc-line); border-radius: 8px; font: inherit; resize: vertical; }
      .wc-exercise-actions { display: flex; gap: 6px; margin-top: 6px; }
      .wc-exercise-actions button { padding: 3px 10px; font-size: 13px; cursor: pointer; }
      .wc-check { border-color: var(--wc-brand); background: var(--wc-brand); color: white; }
      .wc-exercise-result { margin-top: 8px; }
      .wc-exercise-result:empty { display: none; }
      .wc-verdict { font-weight: 800; }
      .wc-verdict-correct { color: #2e7d4f; }
      .wc-verdict-partial { color: #a0700f; }
      .wc-verdict-incorrect { color: #a33b2f; }
      .wc-reference { margin-top: 6px; padding: 7px 10px; border-radius: 8px; background: var(--wc-soft); }
      .wc-error { color: #a33b2f; }
    `;
    document.head.appendChild(style);
  }

  global.WordCoach = {isCoach, render};
})(window);
