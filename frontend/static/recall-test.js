/*
 * Recall test for studied words (vocab workshop → 回忆测试).
 *
 *   RecallTest.mount(root, {
 *     getVocab: () => vocabData,            // {word: entry} from /vocab-log
 *     isDue: entry => boolean,              // page's review-status rule
 *     onApplied: changes => {...},          // after results / undo are saved
 *   });
 *
 * Local questions (spelling recall, cloze) are judged instantly in the
 * browser; AI questions ask for a sentence and are graded by
 * /api/word-exercise-check.  Results update familiarity + next review date.
 */
(function (global) {
  'use strict';

  const FAMILIARITY_LABELS = {unrated: '未判断', unknown: '不认识', fuzzy: '模糊', known: '认识'};
  const RESULT_RANK = {correct: 0, partial: 1, incorrect: 2};
  const RESULT_LABELS = {correct: '✓ 答对', partial: '△ 部分正确', incorrect: '✗ 没答出'};
  const TYPE_LABELS = {spell: '拼写回忆', cloze: '例句填空', scene: '场景造句', translate: '中译英', collocation: '搭配造句'};

  let opts = null;
  let root = null;
  let state = null;

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => (
      {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]
    ));
  }

  function normalize(text) {
    return String(text || '').replace(/[’‘]/g, "'").toLowerCase().replace(/[^a-z0-9' -]/g, '').replace(/\s+/g, ' ').trim();
  }

  function shuffle(list) {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function editDistance(a, b) {
    const dp = Array.from({length: a.length + 1}, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
    for (let i = 1; i <= a.length; i += 1) {
      for (let j = 1; j <= b.length; j += 1) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return dp[a.length][b.length];
  }

  // ── Word pool ────────────────────────────────────────────
  function activeEntries() {
    return Object.entries(opts.getVocab() || {})
      .filter(([word, entry]) => !word.startsWith('__') && entry && !entry.mastered && !entry.archived);
  }

  function daysSince(dateText) {
    if (!dateText) return Infinity;
    const day = new Date(`${String(dateText).slice(0, 10)}T00:00:00`);
    return Math.floor((Date.now() - day.getTime()) / 86400000);
  }

  function poolFor(scope) {
    const entries = activeEntries();
    if (scope === 'due') return entries.filter(([, entry]) => opts.isDue(entry));
    if (scope === 'weak') return entries.filter(([, entry]) => ['unknown', 'fuzzy'].includes(entry.familiarity));
    if (scope === 'missed') return entries.filter(([word]) => ['incorrect', 'partial'].includes(state.lastResults[word]?.result));
    if (scope === 'recent') return entries.filter(([, entry]) => daysSince(entry.first_studied) <= 7);
    return entries;
  }

  // ── Local questions ──────────────────────────────────────
  function exampleSentences(word, entry) {
    const analysis = entry.cached_analysis || {};
    const out = [];
    for (const item of analysis.sentence_building?.examples || []) {
      if (item?.en) out.push({en: item.en, cn: item.cn || ''});
    }
    for (const group of analysis.collocation_groups || []) {
      for (const item of group?.items || []) if (item?.example) out.push({en: item.example, cn: item.cn || ''});
    }
    for (const text of analysis.examples || []) if (typeof text === 'string') out.push({en: text, cn: ''});
    for (const context of entry.contexts || []) if (context?.sentence) out.push({en: context.sentence, cn: ''});
    return out;
  }

  // Is `token` the word itself or a regular inflection of it (leverage → leveraged, study → studies)?
  function isInflection(token, word) {
    const t = token.toLowerCase();
    const w = word.toLowerCase();
    if (t === w) return true;
    const suffixes = ['s', 'es', 'd', 'ed', 'ing', 'er', 'ers', 'ly'];
    if (t.startsWith(w) && suffixes.includes(t.slice(w.length))) return true;
    if (w.endsWith('e') && t.startsWith(w.slice(0, -1)) && ['ing', 'ed', 'er', 'ers'].includes(t.slice(w.length - 1))) return true;
    if (w.endsWith('y') && t.startsWith(w.slice(0, -1)) && ['ies', 'ied', 'ier', 'iest'].includes(t.slice(w.length - 1))) return true;
    const last = w[w.length - 1];
    if (t.startsWith(w + last) && ['ed', 'ing', 'er'].includes(t.slice(w.length + 1))) return true;
    return false;
  }

  function findWordForm(sentence, word) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    if (word.includes(' ')) return new RegExp(`\\b${escaped}\\b`, 'i').exec(sentence);
    const stem = escaped.slice(0, Math.max(2, word.length - 1));
    const pattern = new RegExp(`\\b${stem}[a-z]*\\b`, 'gi');
    let match;
    while ((match = pattern.exec(sentence))) {
      if (isInflection(match[0], word)) return match;
    }
    return null;
  }

  function blankOut(text) {
    return text.split(' ').map(part => `${part[0]}${'_'.repeat(Math.max(2, part.length - 1))}`).join(' ');
  }

  function buildLocalQuestion(word, entry, types) {
    const analysis = entry.cached_analysis || {};
    const display = entry.display_text || word;
    const candidates = [];
    if (types.includes('cloze')) {
      for (const example of shuffle(exampleSentences(word, entry))) {
        const match = findWordForm(example.en, display);
        if (!match) continue;
        const sentence = `${example.en.slice(0, match.index)}<<BLANK>>${example.en.slice(match.index + match[0].length)}`;
        candidates.push({
          type: 'cloze', word, answer: match[0], accept: [match[0], display],
          prompt: sentence, hint: blankOut(match[0]), cn: example.cn,
        });
        break;
      }
    }
    const meaning = analysis.basic_meaning || '';
    if (types.includes('spell') && meaning) {
      candidates.push({
        type: 'spell', word, answer: display, accept: [display, entry.lemma || display],
        prompt: meaning, hint: blankOut(display),
        detail: analysis.concept?.core_cn || analysis.contextual_meaning || '',
        pos: analysis.pos || '',
      });
    }
    return candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : null;
  }

  function judgeLocal(question, answer) {
    const given = normalize(answer);
    if (!given) return 'incorrect';
    const accepted = question.accept.map(normalize);
    if (accepted.includes(given)) return 'correct';
    const target = normalize(question.answer);
    if (target.length >= 4 && accepted.some(item => editDistance(given, item) <= 1)) return 'partial';
    return 'incorrect';
  }

  // ── Rendering ────────────────────────────────────────────
  function render(html) { root.innerHTML = html; }

  function renderSetup(message = '') {
    const scopes = [
      ['due', '到期复习'], ['weak', '不认识 / 模糊的词'], ['missed', '上次测试没答对'],
      ['recent', '最近 7 天学的'], ['all', '全部在学的词'],
    ];
    const scope = state.scope;
    render(`<section class="rt-card">
      <div class="rt-head"><h3>回忆测试</h3><p>不看释义，主动想起学过的词：先做拼写和填空快速题，再用 AI 造句题检验能不能真正用出来。</p></div>
      <div class="rt-setup">
        <label>测试范围<select data-rt-scope>${scopes.map(([value, label]) => {
          const count = poolFor(value).length;
          return `<option value="${value}"${value === scope ? ' selected' : ''}>${label}（${count}）</option>`;
        }).join('')}</select></label>
        <label>词数<select data-rt-size>${[5, 10, 20].map(n => `<option value="${n}"${n === state.size ? ' selected' : ''}>${n} 个</option>`).join('')}</select></label>
        <fieldset><legend>题型</legend>
          ${[['spell', '拼写回忆（看中文写单词）'], ['cloze', '例句填空'], ['ai', 'AI 造句题（AI 批改）']].map(([value, label]) => `
            <label class="rt-check"><input type="checkbox" data-rt-type="${value}"${state.types.includes(value) ? ' checked' : ''}> ${label}</label>`).join('')}
        </fieldset>
      </div>
      ${message ? `<p class="rt-message">${esc(message)}</p>` : ''}
      <button type="button" class="rt-primary" data-rt-start>开始测试</button>
    </section>`);
  }

  function currentQuestion() { return state.questions[state.index]; }

  function renderQuestion() {
    const question = currentQuestion();
    if (!question) { finish(); return; }
    const total = state.questions.length;
    const progress = `<div class="rt-progress"><span>第 ${state.index + 1} / ${total} 题 · ${esc(TYPE_LABELS[question.type] || '')}</span>
      <span class="rt-bar"><i style="width:${Math.round(state.index / total * 100)}%"></i></span></div>`;
    if (question.type === 'pending-ai') {
      render(`<section class="rt-card">${progress}<p class="rt-message">AI 正在出造句题…</p></section>`);
      return;
    }
    let body;
    if (question.type === 'spell') {
      body = `<div class="rt-prompt">${esc(question.prompt)}${question.pos ? ` <span class="rt-tag">${esc(question.pos)}</span>` : ''}</div>
        ${question.detail ? `<div class="rt-sub">${esc(question.detail)}</div>` : ''}
        <div class="rt-sub">提示：${esc(question.hint)}</div>`;
    } else if (question.type === 'cloze') {
      body = `<div class="rt-prompt">${esc(question.prompt).replace('&lt;&lt;BLANK&gt;&gt;', `<span class="rt-blank">${esc(question.hint)}</span>`)}</div>
        ${question.cn ? `<div class="rt-sub">${esc(question.cn)}</div>` : ''}`;
    } else {
      body = `<div class="rt-prompt">${esc(question.question)}</div>`;
    }
    const isAi = !['spell', 'cloze'].includes(question.type);
    const answered = question.result != null;
    render(`<section class="rt-card">${progress}
      ${body}
      ${isAi
        ? `<textarea class="rt-input" data-rt-answer rows="3" placeholder="用英文写一句话…（Ctrl + Enter 提交）"${answered ? ' disabled' : ''}>${esc(question.userAnswer || '')}</textarea>`
        : `<input class="rt-input" data-rt-answer type="text" autocomplete="off" spellcheck="false" placeholder="输入单词…（回车提交）" value="${esc(question.userAnswer || '')}"${answered ? ' disabled' : ''}>`}
      <div class="rt-actions">
        ${answered
          ? `<button type="button" class="rt-primary" data-rt-next>${state.index + 1 < total ? '下一题 →' : '查看结果'}</button>`
          : `<button type="button" class="rt-primary" data-rt-submit>${isAi ? 'AI 批改' : '提交'}</button><button type="button" data-rt-giveup>想不起来，看答案</button>`}
      </div>
      <div class="rt-feedback" aria-live="polite">${answered ? feedbackHtml(question) : ''}</div>
    </section>`);
    const input = root.querySelector('[data-rt-answer]');
    if (input && !answered) input.focus();
    else root.querySelector('[data-rt-next]')?.focus();
  }

  function feedbackHtml(question) {
    const verdict = `<div class="rt-verdict rt-${question.result}">${RESULT_LABELS[question.result]}</div>`;
    const answer = question.answer ? `<div><span class="rt-label">参考答案</span>${esc(question.answer)}
      <button type="button" class="rt-speak" data-rt-speak="${esc(encodeURIComponent(question.answer))}" aria-label="朗读">🔊</button></div>` : '';
    const grading = question.grading || {};
    return `${verdict}
      ${grading.feedback ? `<div>${esc(grading.feedback)}</div>` : ''}
      ${grading.corrected ? `<div><span class="rt-label">改正</span>${esc(grading.corrected)}</div>` : ''}
      ${grading.better_expression ? `<div><span class="rt-label">更地道</span>${esc(grading.better_expression)}</div>` : ''}
      ${answer}
      ${question.explanation ? `<div class="rt-sub">${esc(question.explanation)}</div>` : ''}
      ${question.type === 'spell' || question.type === 'cloze' ? `<div class="rt-sub">目标词：<strong>${esc(question.word)}</strong></div>` : ''}`;
  }

  // ── Flow ─────────────────────────────────────────────────
  async function start() {
    const types = state.types;
    if (!types.length) { renderSetup('至少选择一种题型。'); return; }
    const localTypes = types.filter(type => type !== 'ai');
    const pool = shuffle(poolFor(state.scope));
    const questions = [];
    const words = [];
    for (const [word, entry] of pool) {
      if (words.length >= state.size) break;
      const local = localTypes.length ? buildLocalQuestion(word, entry, localTypes) : null;
      if (!local && !types.includes('ai')) continue;
      words.push(word);
      if (local) questions.push(local);
    }
    if (!words.length) { renderSetup('这个范围里没有可以出题的词，换一个范围试试。'); return; }
    state.words = words;
    state.questions = questions;
    state.index = 0;
    state.aiError = '';
    if (types.includes('ai')) {
      const aiWords = words.slice(0, 10);
      const placeholder = {type: 'pending-ai'};
      state.questions.push(placeholder);
      loadAiQuestions(aiWords, placeholder);
    }
    renderQuestion();
  }

  async function loadAiQuestions(words, placeholder) {
    let questions = [];
    try {
      const response = await fetch('/api/recall-test/ai-questions', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({words}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(data.error || data.detail || '出题失败');
      questions = data.questions || [];
    } catch (error) {
      state.aiError = `AI 造句题生成失败：${error.message}`;
    }
    const at = state.questions.indexOf(placeholder);
    if (at < 0) return; // a new test was started meanwhile
    const waiting = state.index === at;
    state.questions.splice(at, 1, ...questions);
    if (waiting) {
      // the learner is on the "AI 正在出题" screen: show the first AI question (or the results)
      if (currentQuestion()) renderQuestion(); else finish();
    } else {
      const progress = root.querySelector('.rt-progress span');
      if (progress) progress.textContent = progress.textContent.replace(/\/ \d+/, `/ ${state.questions.length}`);
    }
  }

  async function submit(giveUp = false) {
    const question = currentQuestion();
    if (!question || question.result != null || question.type === 'pending-ai') return;
    const answer = root.querySelector('[data-rt-answer]')?.value || '';
    question.userAnswer = answer;
    if (giveUp) {
      question.result = 'incorrect';
      renderQuestion();
      return;
    }
    if (question.type === 'spell' || question.type === 'cloze') {
      question.result = judgeLocal(question, answer);
      renderQuestion();
      return;
    }
    if (!answer.trim()) {
      root.querySelector('.rt-feedback').innerHTML = '<span class="rt-sub">先写一句英文再提交，或点"想不起来"。</span>';
      return;
    }
    const button = root.querySelector('[data-rt-submit]');
    if (button) { button.disabled = true; button.textContent = 'AI 批改中…'; }
    const request = {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        word: question.word, type: question.type === 'translate' ? 'translate' : 'scene',
        question: question.question, answer: question.answer, explanation: question.explanation,
        user_answer: answer,
      }),
    };
    try {
      const response = global.eltCredits
        ? await global.eltCredits.billableFetch('practice_evaluation', '/api/word-exercise-check', request)
        : await fetch('/api/word-exercise-check', request);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(data.error || data.detail || '批改失败');
      question.grading = data;
      question.result = ['correct', 'partial', 'incorrect'].includes(data.verdict) ? data.verdict : 'partial';
      renderQuestion();
    } catch (error) {
      if (button) { button.disabled = false; button.textContent = 'AI 批改'; }
      root.querySelector('.rt-feedback').innerHTML = `<span class="rt-error">批改失败：${esc(error.message)}</span>`;
    }
  }

  function wordResults() {
    const results = {};
    for (const question of state.questions) {
      if (!question.word || question.result == null) continue;
      const previous = results[question.word];
      if (!previous || RESULT_RANK[question.result] > RESULT_RANK[previous]) results[question.word] = question.result;
    }
    return results;
  }

  async function finish() {
    const results = wordResults();
    const entries = Object.entries(results);
    if (!entries.length) { renderSetup(state.aiError || '这次没有完成任何题目。'); return; }
    render('<section class="rt-card"><p class="rt-message">正在保存结果…</p></section>');
    let changes = [];
    let error = '';
    try {
      const response = await fetch('/api/recall-test/results', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({results: entries.map(([word, result]) => ({word, result}))}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || data.detail || '保存失败');
      changes = data.changes || [];
      for (const change of changes) state.lastResults[change.word] = {result: change.result};
      opts.onApplied?.(changes);
    } catch (err) {
      error = `结果没能保存：${err.message}`;
    }
    state.changes = changes;
    renderSummary(results, error);
  }

  function changeText(change) {
    const before = FAMILIARITY_LABELS[change.previous.familiarity] || change.previous.familiarity;
    const after = FAMILIARITY_LABELS[change.current.familiarity] || change.current.familiarity;
    return `${before} → ${after}，${change.current.interval_days} 天后复习`;
  }

  function renderSummary(results, error = '') {
    const answered = state.questions.filter(question => question.result != null);
    const correct = answered.filter(question => question.result === 'correct').length;
    const changesByWord = Object.fromEntries((state.changes || []).map(change => [change.word, change]));
    const missed = Object.entries(results).filter(([, result]) => result !== 'correct').map(([word]) => word);
    render(`<section class="rt-card">
      <div class="rt-head"><h3>测试结果</h3><p>答对 ${correct} / ${answered.length} 题，涉及 ${Object.keys(results).length} 个词。熟悉度和复习时间已自动更新，可以逐个撤销。</p></div>
      ${error || state.aiError ? `<p class="rt-error">${esc(error || state.aiError)}</p>` : ''}
      <ul class="rt-summary">${Object.entries(results).map(([word, result]) => {
        const change = changesByWord[word];
        return `<li><span class="rt-verdict rt-${result}">${RESULT_LABELS[result]}</span><strong>${esc(word)}</strong>
          <span class="rt-sub">${change ? esc(changeText(change)) : ''}</span>
          ${change ? `<button type="button" data-rt-undo="${esc(word)}">撤销</button>` : ''}</li>`;
      }).join('')}</ul>
      <div class="rt-actions">
        ${missed.length ? `<button type="button" class="rt-primary" data-rt-retry>再测一次没答对的 ${missed.length} 个词</button>` : ''}
        <button type="button" data-rt-setup>返回设置</button>
      </div>
    </section>`);
    state.missed = missed;
  }

  async function undo(word, button) {
    const change = (state.changes || []).find(item => item.word === word);
    if (!change) return;
    button.disabled = true;
    try {
      const response = await fetch('/api/recall-test/undo', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({word, ...change.previous}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '撤销失败');
      delete state.lastResults[word];
      opts.onApplied?.([{word, current: change.previous}]);
      button.textContent = '已撤销';
      button.closest('li').querySelector('.rt-sub').textContent = `已恢复为：${FAMILIARITY_LABELS[change.previous.familiarity] || change.previous.familiarity}`;
    } catch (error) {
      button.disabled = false;
      button.textContent = `撤销失败，重试`;
    }
  }

  function retryMissed() {
    const vocab = opts.getVocab() || {};
    const words = shuffle(state.missed || []).filter(word => vocab[word]);
    const localTypes = state.types.filter(type => type !== 'ai');
    state.words = words;
    state.questions = words.map(word => buildLocalQuestion(word, vocab[word], localTypes)).filter(Boolean);
    state.index = 0;
    state.aiError = '';
    if (state.types.includes('ai') && words.length) {
      const placeholder = {type: 'pending-ai'};
      state.questions.push(placeholder);
      loadAiQuestions(words.slice(0, 10), placeholder);
    }
    if (!state.questions.length) { renderSetup('这些词没有可以出的题。'); return; }
    renderQuestion();
  }

  // ── Events ───────────────────────────────────────────────
  function onClick(event) {
    if (event.target.closest('[data-rt-start]')) { start(); return; }
    if (event.target.closest('[data-rt-submit]')) { submit(false); return; }
    if (event.target.closest('[data-rt-giveup]')) { submit(true); return; }
    if (event.target.closest('[data-rt-next]')) { state.index += 1; renderQuestion(); return; }
    if (event.target.closest('[data-rt-retry]')) { retryMissed(); return; }
    if (event.target.closest('[data-rt-setup]')) { renderSetup(); return; }
    const undoButton = event.target.closest('[data-rt-undo]');
    if (undoButton) { undo(undoButton.dataset.rtUndo, undoButton); return; }
    const speak = event.target.closest('[data-rt-speak]');
    if (speak && global.NaturalTTS) global.NaturalTTS.speak(decodeURIComponent(speak.dataset.rtSpeak), {lang: 'en-US', rate: 0.95});
  }

  function onChange(event) {
    if (event.target.matches('[data-rt-scope]')) state.scope = event.target.value;
    if (event.target.matches('[data-rt-size]')) state.size = Number(event.target.value);
    if (event.target.matches('[data-rt-type]')) {
      state.types = [...root.querySelectorAll('[data-rt-type]:checked')].map(input => input.dataset.rtType);
    }
  }

  function onKeydown(event) {
    if (event.key !== 'Enter') return;
    const input = event.target.closest('[data-rt-answer]');
    if (input && !input.disabled) {
      const isTextarea = input.tagName === 'TEXTAREA';
      if (isTextarea && !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      submit(false);
      return;
    }
    if (event.target.closest('[data-rt-next]')) return; // native button handles Enter
  }

  async function show() {
    if (!root) return;
    try {
      const data = await fetch('/api/recall-test/last-results', {cache: 'no-store'}).then(r => r.json());
      state.lastResults = data.results || {};
    } catch (_) { /* filter falls back to empty */ }
    if (!state.questions.length || state.index >= state.questions.length) renderSetup();
  }

  function mount(element, options) {
    root = element;
    opts = options;
    state = {scope: 'due', size: 10, types: ['spell', 'cloze', 'ai'], questions: [], index: 0, lastResults: {}, words: []};
    ensureStyles();
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('keydown', onKeydown);
  }

  let stylesInjected = false;
  function ensureStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .rt-card { max-width: 760px; margin: 0 auto; padding: 18px 20px; border: 1px solid var(--line, #d9ded8); border-radius: 12px;
        background: var(--surface, #fff); box-shadow: 0 8px 24px rgba(31,44,36,.06); line-height: 1.65; }
      .rt-head h3 { margin: 0; color: var(--brand-dark, #245548); font-size: 20px; }
      .rt-head p { margin: 4px 0 14px; color: var(--muted, #687069); font-size: 13px; }
      .rt-setup { display: grid; gap: 12px; margin-bottom: 14px; }
      .rt-setup label { display: grid; gap: 4px; font-size: 13px; font-weight: 700; }
      .rt-setup select { max-width: 280px; padding: 6px 9px; border: 1px solid var(--line, #d9ded8); border-radius: 8px; font: inherit; }
      .rt-setup fieldset { display: grid; gap: 4px; margin: 0; padding: 8px 12px; border: 1px solid var(--line, #d9ded8); border-radius: 8px; }
      .rt-setup legend { font-size: 13px; font-weight: 700; }
      .rt-check { display: flex !important; align-items: center; gap: 6px; font-weight: 400 !important; }
      .rt-primary { border-color: var(--brand, #2f6f5e) !important; background: var(--brand, #2f6f5e) !important; color: white !important; }
      .rt-progress { display: grid; gap: 5px; margin-bottom: 14px; color: var(--muted, #687069); font-size: 12px; }
      .rt-bar { height: 5px; border-radius: 999px; background: #eef2ed; overflow: hidden; }
      .rt-bar i { display: block; height: 100%; background: var(--brand, #2f6f5e); transition: width .2s; }
      .rt-prompt { font-size: 18px; line-height: 1.7; }
      .rt-blank { padding: 0 4px; border-bottom: 2px solid var(--brand, #2f6f5e); color: var(--brand-dark, #245548); font-family: monospace; letter-spacing: 1px; }
      .rt-sub { margin-top: 4px; color: var(--muted, #687069); font-size: 13px; }
      .rt-tag { padding: 0 7px; border-radius: 999px; background: #eef2ed; color: var(--brand-dark, #245548); font-size: 12px; }
      .rt-input { width: 100%; box-sizing: border-box; margin-top: 12px; padding: 9px 12px; border: 1px solid var(--line, #d9ded8);
        border-radius: 9px; font: inherit; font-size: 16px; }
      .rt-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
      .rt-feedback { margin-top: 12px; display: grid; gap: 4px; }
      .rt-feedback:empty { display: none; }
      .rt-label { margin-right: 6px; color: var(--brand-dark, #245548); font-size: 12px; font-weight: 800; }
      .rt-verdict { font-weight: 800; }
      .rt-correct { color: #2e7d4f; }
      .rt-partial { color: #a0700f; }
      .rt-incorrect { color: #a33b2f; }
      .rt-message { color: var(--muted, #687069); }
      .rt-error { color: #a33b2f; }
      .rt-speak { padding: 0 5px; border: 0; background: none; cursor: pointer; }
      .rt-summary { margin: 0 0 6px; padding: 0; list-style: none; }
      .rt-summary li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 7px 0; border-bottom: 1px dashed var(--line, #d9ded8); }
      .rt-summary li button { margin-left: auto; padding: 2px 9px; font-size: 12px; }
    `;
    document.head.appendChild(style);
  }

  global.RecallTest = {mount, show, _test: {buildLocalQuestion, judgeLocal, findWordForm}};
})(window);
