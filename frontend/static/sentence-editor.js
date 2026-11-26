/*
 * SentenceEditor — let the learner correct a lesson sentence while studying.
 *
 *   SentenceEditor.open({
 *     lessonId,
 *     text,                    // the sentence as shown
 *     prevText, nextText,      // neighbours, for context and merge buttons
 *     locator: {unit_index} | {block_index, sentence_index},
 *     onSaved: async result => {...},   // reload the page's sentences
 *   });
 *
 * Edit the text, press Enter where the sentence should break (each line becomes
 * one sentence), or merge with / delete the sentence.
 */
(function (global) {
  'use strict';

  let styleInjected = false;
  let current = null;

  function injectStyles() {
    if (styleInjected) return;
    styleInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .se-overlay { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
        padding: 16px; background: rgba(20, 28, 24, .42); }
      .se-dialog { width: min(640px, 100%); max-height: calc(100vh - 32px); overflow: auto; padding: 18px 20px;
        border-radius: 14px; background: var(--surface, #fff); color: var(--ink, #202421);
        box-shadow: 0 18px 48px rgba(20, 28, 24, .28); font-size: 14px; line-height: 1.55; }
      .se-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
      .se-head h3 { margin: 0; font-size: 17px; }
      .se-close { min-width: 32px; min-height: 32px; padding: 0; border: 0; border-radius: 50%; background: transparent;
        color: var(--muted, #687069); font-size: 16px; cursor: pointer; }
      .se-close:hover { background: rgba(0,0,0,.06); }
      .se-neighbour { margin: 6px 0; padding: 6px 10px; border-radius: 8px; background: rgba(0,0,0,.035);
        color: var(--muted, #687069); font-size: 13px; }
      .se-neighbour b { margin-right: 6px; font-size: 11px; font-weight: 700; }
      .se-text { display: block; width: 100%; min-height: 96px; box-sizing: border-box; margin: 8px 0 4px; padding: 10px 12px;
        border: 1px solid var(--line, #d9ded8); border-radius: 10px; background: var(--surface, #fff); color: inherit;
        font: inherit; font-size: 15px; line-height: 1.6; resize: vertical; }
      .se-text:focus { outline: 2px solid var(--brand, #2f6f5e); outline-offset: 1px; }
      .se-hint { color: var(--muted, #687069); font-size: 12px; }
      .se-hint strong { color: var(--brand-dark, #245548); }
      .se-error { min-height: 18px; margin-top: 6px; color: var(--danger, #a33b2f); font-size: 13px; }
      .se-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
      .se-actions .se-spacer { flex: 1; }
      .se-actions button { min-height: 34px; padding: 0 12px; border: 1px solid var(--line, #d9ded8); border-radius: 8px;
        background: var(--surface, #fff); color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
      .se-actions button:hover:not(:disabled) { border-color: var(--brand, #2f6f5e); }
      .se-actions button:disabled { opacity: .5; cursor: default; }
      .se-actions .se-save { border-color: var(--brand, #2f6f5e); background: var(--brand, #2f6f5e); color: #fff; }
      .se-actions .se-delete { color: var(--danger, #a33b2f); }
      .se-actions .se-delete.confirm { border-color: var(--danger, #a33b2f); background: var(--danger, #a33b2f); color: #fff; }
      @media (max-width: 560px) { .se-actions .se-spacer { flex-basis: 100%; height: 0; } }
    `;
    document.head.appendChild(style);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => (
      {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]
    ));
  }

  function normalize(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function partsOf(value) {
    return String(value || '').split(/\n+/).map(normalize).filter(Boolean);
  }

  function close() {
    if (!current) return;
    document.removeEventListener('keydown', current.onKey, true);
    current.overlay.remove();
    current = null;
  }

  async function submit(action) {
    if (!current || current.busy) return;
    const {options, overlay} = current;
    const textarea = overlay.querySelector('.se-text');
    const errorEl = overlay.querySelector('.se-error');
    const texts = partsOf(textarea.value);
    if (action === 'replace') {
      if (!texts.length) {
        errorEl.textContent = '句子不能为空；如需删除请用“删除这句”。';
        return;
      }
      if (texts.length === 1 && texts[0] === normalize(options.text)) {
        close();
        return;
      }
    }
    current.busy = true;
    overlay.querySelectorAll('button, textarea').forEach(el => { el.disabled = true; });
    errorEl.textContent = '';
    try {
      const resp = await fetch(`/api/v2/lessons/${options.lessonId}/sentences/edit`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          action,
          original_text: options.text,
          texts: action === 'replace' ? texts : [],
          ...options.locator,
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.detail || `保存失败（${resp.status}）`);
      const onSaved = options.onSaved;
      close();
      if (onSaved) await onSaved({...data, action});
    } catch (err) {
      if (!current) return;
      current.busy = false;
      overlay.querySelectorAll('button, textarea').forEach(el => { el.disabled = false; });
      applyNeighbourState();
      errorEl.textContent = err.message || '保存失败，请重试';
    }
  }

  function applyNeighbourState() {
    if (!current) return;
    const {overlay, options} = current;
    overlay.querySelector('[data-se-action="merge_prev"]').disabled = !options.prevText;
    overlay.querySelector('[data-se-action="merge_next"]').disabled = !options.nextText;
  }

  function updateHint() {
    if (!current) return;
    const {overlay} = current;
    const count = partsOf(overlay.querySelector('.se-text').value).length;
    overlay.querySelector('.se-hint').innerHTML = count > 1
      ? `保存后会拆成 <strong>${count} 句</strong>。`
      : '直接修改文字；在要断开的位置<strong>按回车</strong>，就会拆成多句。Ctrl+Enter 保存。';
  }

  function open(options) {
    close();
    injectStyles();
    const overlay = document.createElement('div');
    overlay.className = 'se-overlay';
    overlay.innerHTML = `
      <div class="se-dialog" role="dialog" aria-modal="true" aria-label="修改句子">
        <div class="se-head">
          <h3>修改句子</h3>
          <button class="se-close" type="button" data-se-close aria-label="关闭">✕</button>
        </div>
        ${options.prevText ? `<div class="se-neighbour"><b>上一句</b>${escapeHtml(options.prevText)}</div>` : ''}
        <textarea class="se-text" spellcheck="true" aria-label="句子内容">${escapeHtml(options.text)}</textarea>
        <div class="se-hint"></div>
        ${options.nextText ? `<div class="se-neighbour"><b>下一句</b>${escapeHtml(options.nextText)}</div>` : ''}
        <div class="se-error" role="alert"></div>
        <div class="se-actions">
          <button type="button" data-se-action="merge_prev" title="把这句接到上一句后面">⤒ 与上一句合并</button>
          <button type="button" data-se-action="merge_next" title="把下一句接到这句后面">⤓ 与下一句合并</button>
          <button type="button" class="se-delete" data-se-action="delete" title="删除这句（如误识别的杂音）">删除这句</button>
          <span class="se-spacer"></span>
          <button type="button" data-se-close>取消</button>
          <button type="button" class="se-save" data-se-action="replace">保存</button>
        </div>
      </div>`;
    const onKey = event => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        submit('replace');
      }
    };
    current = {overlay, options, onKey, busy: false};
    overlay.addEventListener('click', event => {
      if (event.target === overlay || event.target.closest('[data-se-close]')) {
        close();
        return;
      }
      const button = event.target.closest('[data-se-action]');
      if (!button || button.disabled) return;
      const action = button.dataset.seAction;
      if (action === 'delete' && !button.classList.contains('confirm')) {
        button.classList.add('confirm');
        button.textContent = '确认删除？';
        return;
      }
      submit(action);
    });
    // 编辑器内的按键不要触发页面快捷键（空格播放、方向键切句等）
    overlay.addEventListener('keydown', event => event.stopPropagation());
    overlay.querySelector('.se-text').addEventListener('input', updateHint);
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    applyNeighbourState();
    updateHint();
    const textarea = overlay.querySelector('.se-text');
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  global.SentenceEditor = {open, close};
})(window);
