(() => {
  const HOST_ID = 'flyout-agenda-host';

  // Avoid double-injection if the script somehow runs twice on the same document
  if (document.getElementById(HOST_ID)) return;

  const STORAGE_KEY = 'flyouts';
  const GLOBAL_ENABLED_KEY = 'globalEnabled';
  const OPEN_FLYOUT_KEY = 'openFlyoutId';
  const TOOLBAR_COLLAPSED_KEY = 'toolbarCollapsed';
  const DEFAULT_PANEL_WIDTH = 320; // px, used when a flyout has no saved width yet
  const MIN_PANEL_WIDTH = 240;     // px
  const MAX_PANEL_WIDTH = 600;     // px
  const DEFAULT_CONTENT_URL = chrome.runtime.getURL('panel-content.html');

  let hostEl = null;
  let shadowRoot = null;
  let flyouts = [];        // [{ id, name, enabled, html, width }]
  let openFlyoutId = null; // id of the currently open panel, or null
  let globalEnabled = true;
  let toolbarCollapsed = false; // shared across flyouts — a UI layout preference, not per-flyout content

  // ---------- Utilities ----------
  function makeId() {
    return 'flyout-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  }

  function placeholderHtml(name) {
    return `<h2>${escapeHtml(name)}</h2><p>Click here and start typing to edit this flyout.</p>`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- Panel width ----------
  function clampWidth(px) {
    const max = Math.min(MAX_PANEL_WIDTH, window.innerWidth - 80);
    return Math.min(max, Math.max(MIN_PANEL_WIDTH, px));
  }

  function getFlyoutWidth(flyout) {
    return (flyout && flyout.width) || DEFAULT_PANEL_WIDTH;
  }

  // document.getSelection() gets its Range boundary points retargeted to the
  // shadow host when the real selection lives inside our (open) shadow root,
  // so walking .startContainer from it never actually reaches our content.
  // shadowRoot.getSelection() is the shadow-scoped equivalent that does.
  function getEditorSelection() {
    return (shadowRoot && shadowRoot.getSelection) ? shadowRoot.getSelection() : document.getSelection();
  }

  // Sets --panel-width on the shadow host so both the panel and the tab
  // stack (which are siblings inside the shadow root) can read it — a
  // custom property set on the host element inherits into the shadow tree.
  function setPanelWidthVar(px) {
    if (hostEl) hostEl.style.setProperty('--panel-width', `${px}px`);
  }

  function applyToolbarCollapsedState() {
    if (!shadowRoot) return;
    const toolbar = shadowRoot.querySelector('.toolbar');
    const toggleBtn = shadowRoot.querySelector('.toolbar-toggle-btn');
    if (!toolbar || !toggleBtn) return;
    toolbar.classList.toggle('collapsed', toolbarCollapsed);
    toggleBtn.textContent = toolbarCollapsed ? '▼' : '▲';
    toggleBtn.title = toolbarCollapsed ? 'Show formatting toolbar' : 'Hide formatting toolbar';
  }

  // Prevent keystrokes typed inside our shadow-DOM UI from bubbling out to
  // the host page's own keydown/keyup/keypress listeners (e.g. sites like
  // Jira that bind global keyboard shortcuts to letters such as "j"/"k").
  function stopKeyPropagation(el) {
    ['keydown', 'keyup', 'keypress', 'input', 'beforeinput'].forEach((evt) => {
      el.addEventListener(evt, (e) => {
        e.stopPropagation();
      });
    });
  }

  async function fetchDefaultContent() {
    try {
      const res = await fetch(DEFAULT_CONTENT_URL);
      return await res.text();
    } catch (e) {
      return '<p>Could not load default content.</p>';
    }
  }

  function normalizeLinks(container) {
    container.querySelectorAll('a[target]').forEach((a) => {
      a.setAttribute('target', '_self');
    });
  }

  // ---------- Storage ----------
  function saveFlyouts() {
    chrome.storage.local.set({ [STORAGE_KEY]: flyouts });
  }

  async function loadFlyouts() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], async (result) => {
        let stored = result[STORAGE_KEY];
        if (!stored || !Array.isArray(stored) || stored.length === 0) {
          const defaultHtml = await fetchDefaultContent();
          stored = [{
            id: makeId(),
            name: 'Agenda',
            enabled: true,
            html: defaultHtml
          }];
          chrome.storage.local.set({ [STORAGE_KEY]: stored });
        }
        resolve(stored);
      });
    });
  }

  function loadOpenFlyoutId() {
    return new Promise((resolve) => {
      chrome.storage.local.get([OPEN_FLYOUT_KEY], (result) => {
        resolve(result[OPEN_FLYOUT_KEY] || null);
      });
    });
  }

  function loadToolbarCollapsed() {
    return new Promise((resolve) => {
      chrome.storage.local.get([TOOLBAR_COLLAPSED_KEY], (result) => {
        resolve(result[TOOLBAR_COLLAPSED_KEY] === true);
      });
    });
  }

  // ---------- Build the panel ----------
  async function buildPanel() {
    flyouts = await loadFlyouts();

    const storedOpenId = await loadOpenFlyoutId();
    toolbarCollapsed = await loadToolbarCollapsed();
    openFlyoutId = flyouts.find(f => f.id === storedOpenId && f.enabled) ? storedOpenId : null;

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.all = 'initial';
    document.documentElement.appendChild(host);
    hostEl = host;

    shadowRoot = host.attachShadow({ mode: 'open' });

    shadowRoot.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: system-ui, sans-serif; }

        .tab-stack {
          position: fixed;
          top: 50%;
          left: 0;
          transform: translateY(-50%) translateX(0);
          transition: transform 0.25s ease;
          display: flex;
          flex-direction: column;
          gap: 4px;
          z-index: 2147483647;
        }

        .tab-stack.shifted {
          transform: translateY(-50%) translateX(var(--panel-width, ${DEFAULT_PANEL_WIDTH}px));
        }

        .flyout-tab {
          background: #2563eb;
          color: #fff;
          padding: 10px 6px;
          border-radius: 0 6px 6px 0;
          cursor: pointer;
          font-size: 13px;
          writing-mode: vertical-rl;
          user-select: none;
          box-shadow: 1px 0 4px rgba(0,0,0,0.2);
          max-height: 160px;
          text-overflow: ellipsis;
          overflow: hidden;
          white-space: nowrap;
        }

        .flyout-tab.active {
          background: #1d4ed8;
        }

        .panel {
          position: fixed;
          top: 0;
          left: 0;
          height: 100vh;
          width: var(--panel-width, ${DEFAULT_PANEL_WIDTH}px);
          background: #ffffff;
          color: #111;
          box-shadow: 2px 0 12px rgba(0,0,0,0.25);
          z-index: 2147483646;
          transform: translateX(-100%);
          transition: transform 0.25s ease;
          display: flex;
          flex-direction: column;
        }

        .panel.open {
          transform: translateX(0);
        }

        .resize-handle {
          position: absolute;
          top: 0;
          right: -3px;
          width: 6px;
          height: 100%;
          cursor: col-resize;
          background: transparent;
          touch-action: none;
        }

        .resize-handle:hover,
        .resize-handle.dragging {
          background: rgba(37, 99, 235, 0.35);
        }

        .panel-header {
          padding: 10px 12px;
          border-bottom: 1px solid #e5e7eb;
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 13px;
          color: #6b7280;
          gap: 6px;
        }

        .panel-header .flyout-title {
          font-weight: 600;
          color: #111;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .panel-header-actions {
          display: flex;
          gap: 6px;
        }

        .panel-header button {
          background: #f3f4f6;
          border: 1px solid #d1d5db;
          border-radius: 4px;
          padding: 4px 8px;
          cursor: pointer;
          font-size: 12px;
        }

        .panel-header button:hover {
          background: #e5e7eb;
        }

        .toolbar {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 4px;
          padding: 6px 8px;
          border-bottom: 1px solid #e5e7eb;
          background: #fafafa;
        }

        .toolbar.collapsed {
          display: none;
        }

        .toolbar button {
          background: #f3f4f6;
          border: 1px solid #d1d5db;
          border-radius: 4px;
          padding: 4px 8px;
          min-width: 26px;
          cursor: pointer;
          font-size: 12px;
          line-height: 1;
          color: #111;
        }

        .toolbar button:hover {
          background: #e5e7eb;
        }

        .toolbar button.active {
          background: #dbeafe;
          border-color: #93c5fd;
          color: #1d4ed8;
        }

        .toolbar select {
          background: #f3f4f6;
          border: 1px solid #d1d5db;
          border-radius: 4px;
          padding: 4px 6px;
          font-size: 12px;
          cursor: pointer;
          color: #111;
        }

        .panel-content {
          flex: 1;
          overflow-y: auto;
          padding: 14px;
          outline: none;
          line-height: 1.5;
          font-size: 14px;
        }

        .panel-content a {
          color: #2563eb;
          text-decoration: underline;
          cursor: pointer;
        }

        .panel-content ul.checklist {
          list-style: none;
          padding-left: 0;
          margin: 0.5em 0;
        }

        .panel-content ul.checklist li {
          display: flex;
          align-items: flex-start;
          gap: 6px;
          padding: 2px 0;
        }

        .panel-content ul.checklist li input[type="checkbox"] {
          margin-top: 4px;
          flex-shrink: 0;
          cursor: pointer;
        }

        .panel-content ul.checklist li .checklist-text {
          flex: 1;
          min-width: 0;
        }

        .panel-content ul.checklist li.checked .checklist-text {
          text-decoration: line-through;
          color: #9ca3af;
        }

        .panel-content:focus {
          background: #fafafa;
        }
      </style>

      <div class="tab-stack"></div>
      <div class="panel">
        <div class="panel-header">
          <span class="flyout-title"></span>
          <div class="panel-header-actions">
            <button class="toolbar-toggle-btn" title="Hide formatting toolbar">▲</button>
            <button class="reset-btn" title="Reset this flyout's content">Reset</button>
            <button class="close-btn" title="Close">Close</button>
          </div>
        </div>
        <div class="toolbar">
          <select class="fmt-block" title="Paragraph style">
            <option value="p">Paragraph</option>
            <option value="h1">Heading 1</option>
            <option value="h2">Heading 2</option>
            <option value="h3">Heading 3</option>
          </select>
          <button type="button" data-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>
          <button type="button" data-cmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>
          <button type="button" data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
          <button type="button" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
          <select class="fmt-list" title="List style">
            <option value="none">No list</option>
            <option value="ul">Bulleted list</option>
            <option value="ol">Numbered list</option>
            <option value="checklist">Checklist</option>
          </select>
          <button type="button" data-cmd="createLink" title="Insert/remove link">Link</button>
          <button type="button" data-cmd="removeFormat" title="Clear formatting">Clear</button>
        </div>
        <div class="panel-content" contenteditable="true" spellcheck="false"></div>
        <div class="resize-handle" title="Drag to resize"></div>
      </div>
    `;

    shadowRoot.querySelector('.close-btn').addEventListener('click', () => setOpenFlyout(null));
    shadowRoot.querySelector('.reset-btn').addEventListener('click', onResetClick);
    shadowRoot.querySelector('.toolbar-toggle-btn').addEventListener('click', () => {
      toolbarCollapsed = !toolbarCollapsed;
      chrome.storage.local.set({ [TOOLBAR_COLLAPSED_KEY]: toolbarCollapsed });
      applyToolbarCollapsedState();
    });
    applyToolbarCollapsedState();
    setupResizeHandle();

    const editableEl = shadowRoot.querySelector('.panel-content');
    stopKeyPropagation(editableEl);
    let saveTimer = null;
    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const flyout = flyouts.find(f => f.id === openFlyoutId);
        if (flyout) {
          flyout.html = editableEl.innerHTML;
          saveFlyouts();
        }
      }, 500);
    }
    editableEl.addEventListener('input', scheduleSave);
    setupToolbar(editableEl, scheduleSave);
    setupChecklistBehavior(editableEl, scheduleSave);

    editableEl.addEventListener('click', (event) => {
      const anchor = event.target.closest('a');
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      const href = anchor.getAttribute('href');
      if (href) {
        window.location.href = new URL(href, window.location.href).href;
      }
    });

    renderTabs();
    renderOpenPanel();
  }

  // ---------- Formatting toolbar ----------
  function setupToolbar(editableEl, scheduleSave) {
    const toolbar = shadowRoot.querySelector('.toolbar');
    const formatSelect = toolbar.querySelector('.fmt-block');
    const listSelect = toolbar.querySelector('.fmt-list');
    stopKeyPropagation(toolbar);

    // Clicking a toolbar button normally steals focus from the
    // contenteditable and collapses its text selection before our click
    // handler runs; preventing default on mousedown keeps the selection
    // intact so execCommand has something to act on. This must NOT apply to
    // the <select> elements — preventDefault on their mousedown stops the
    // native dropdown from opening at all.
    toolbar.addEventListener('mousedown', (e) => {
      if (e.target.closest('button[data-cmd]')) {
        e.preventDefault();
      }
    });

    function isSelectionInLink() {
      const sel = getEditorSelection();
      if (!sel || sel.rangeCount === 0) return false;
      let node = sel.getRangeAt(0).startContainer;
      if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
      return !!(node && node.closest && node.closest('a'));
    }

    function updateToolbarState() {
      toolbar.querySelectorAll('button[data-cmd]').forEach((btn) => {
        const cmd = btn.dataset.cmd;
        let active = false;
        try {
          active = cmd === 'createLink' ? isSelectionInLink() : document.queryCommandState(cmd);
        } catch (e) {
          active = false;
        }
        btn.classList.toggle('active', active);
      });
      try {
        const blockValue = (document.queryCommandValue('formatBlock') || 'p')
          .toLowerCase()
          .replace(/[<>]/g, '');
        const hasOption = Array.from(formatSelect.options).some((o) => o.value === blockValue);
        formatSelect.value = hasOption ? blockValue : 'p';
      } catch (e) {
        // ignore — leave the select at its current value
      }

      const currentList = findListContainer(editableEl);
      if (currentList && currentList.classList.contains('checklist')) {
        listSelect.value = 'checklist';
      } else if (currentList && currentList.tagName === 'UL') {
        listSelect.value = 'ul';
      } else if (currentList && currentList.tagName === 'OL') {
        listSelect.value = 'ol';
      } else {
        listSelect.value = 'none';
      }
    }

    toolbar.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-cmd]');
      if (!button) return;
      editableEl.focus();

      if (button.dataset.cmd === 'createLink') {
        if (isSelectionInLink()) {
          document.execCommand('unlink', false, null);
        } else {
          const url = window.prompt('Link URL:', 'https://');
          if (!url) return;
          document.execCommand('createLink', false, url);
        }
      } else {
        document.execCommand(button.dataset.cmd, false, null);
      }

      scheduleSave();
      updateToolbarState();
    });

    formatSelect.addEventListener('change', () => {
      editableEl.focus();
      document.execCommand('formatBlock', false, `<${formatSelect.value}>`);
      scheduleSave();
      updateToolbarState();
    });

    listSelect.addEventListener('change', () => {
      editableEl.focus();
      const value = listSelect.value;
      const currentList = findListContainer(editableEl);

      if (currentList && currentList.classList.contains('checklist')) {
        removeChecklist(currentList);
      }

      const inUl = document.queryCommandState('insertUnorderedList');
      const inOl = document.queryCommandState('insertOrderedList');
      if (value === 'none') {
        if (inUl) document.execCommand('insertUnorderedList', false, null);
        if (inOl) document.execCommand('insertOrderedList', false, null);
      } else if (value === 'ul' && !inUl) {
        document.execCommand('insertUnorderedList', false, null);
      } else if (value === 'ol' && !inOl) {
        document.execCommand('insertOrderedList', false, null);
      } else if (value === 'checklist') {
        applyChecklist(editableEl);
      }

      scheduleSave();
      updateToolbarState();
    });

    document.addEventListener('selectionchange', () => {
      if (!shadowRoot || shadowRoot.activeElement !== editableEl) return;
      updateToolbarState();
    });
  }

  // ---------- Checklist ----------
  // A checklist has no execCommand equivalent, so it's built by hand on top
  // of a plain <ul>: each <li> gets a real (contenteditable="false")
  // checkbox plus a .checklist-text span wrapping its original content.
  function findListContainer(editableEl) {
    const sel = getEditorSelection();
    if (!sel || sel.rangeCount === 0) return null;
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    if (!node || !editableEl.contains(node)) return null;
    return node.closest('ul, ol');
  }

  function toChecklistItem(li) {
    if (li.querySelector(':scope > input[type="checkbox"]')) return;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('contenteditable', 'false');
    const textSpan = document.createElement('span');
    textSpan.className = 'checklist-text';
    while (li.firstChild) {
      textSpan.appendChild(li.firstChild);
    }
    li.appendChild(checkbox);
    li.appendChild(textSpan);
  }

  function fromChecklistItem(li) {
    const checkbox = li.querySelector(':scope > input[type="checkbox"]');
    const textSpan = li.querySelector(':scope > .checklist-text');
    if (checkbox) checkbox.remove();
    if (textSpan) {
      while (textSpan.firstChild) {
        li.insertBefore(textSpan.firstChild, textSpan);
      }
      textSpan.remove();
    }
    li.classList.remove('checked');
  }

  function applyChecklist(editableEl) {
    let list = findListContainer(editableEl);
    if (!list) {
      document.execCommand('insertUnorderedList', false, null);
      list = findListContainer(editableEl);
    } else if (list.tagName === 'OL') {
      // Selecting insertUnorderedList while inside an OL converts it to a UL.
      document.execCommand('insertUnorderedList', false, null);
      list = findListContainer(editableEl);
    }
    if (!list) return;
    list.classList.add('checklist');
    Array.from(list.children).forEach((li) => {
      if (li.tagName === 'LI') toChecklistItem(li);
    });
  }

  function removeChecklist(list) {
    Array.from(list.children).forEach((li) => {
      if (li.tagName === 'LI') fromChecklistItem(li);
    });
    list.classList.remove('checklist');
  }

  function placeCaretAtStart(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(true);
    const sel = getEditorSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function setupChecklistBehavior(editableEl, scheduleSave) {
    // Toggling a checkbox updates its `checked` property, not its `checked`
    // attribute — and only the attribute survives innerHTML serialization,
    // which is how flyout content gets saved. Sync it explicitly.
    editableEl.addEventListener('change', (event) => {
      const checkbox = event.target.closest('input[type="checkbox"]');
      if (!checkbox || !editableEl.contains(checkbox)) return;
      checkbox.toggleAttribute('checked', checkbox.checked);
      const li = checkbox.closest('li');
      if (li) li.classList.toggle('checked', checkbox.checked);
      scheduleSave();
    });

    // Native contenteditable list-splitting doesn't handle an <li> that
    // contains a void checkbox plus a text span, so Enter is handled by hand
    // for checklist items specifically.
    editableEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) return;

      const sel = getEditorSelection();
      if (!sel || sel.rangeCount === 0) return;
      let node = sel.getRangeAt(0).startContainer;
      if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
      if (!node || !editableEl.contains(node)) return;

      const li = node.closest('li');
      const list = li ? li.closest('ul.checklist') : null;
      const textSpan = li ? li.querySelector(':scope > .checklist-text') : null;
      if (!li || !list || !textSpan) return; // not a checklist item — default behavior applies

      event.preventDefault();

      if (textSpan.textContent.trim() === '') {
        // Enter on an empty checklist item exits the list back to a paragraph.
        const p = document.createElement('p');
        p.innerHTML = '<br>';
        list.parentNode.insertBefore(p, list.nextSibling);
        li.remove();
        if (!list.children.length) list.remove();
        placeCaretAtStart(p);
        scheduleSave();
        return;
      }

      const range = sel.getRangeAt(0);
      const afterRange = range.cloneRange();
      afterRange.setEndAfter(textSpan.lastChild || textSpan);
      const remainder = afterRange.extractContents();

      const newLi = document.createElement('li');
      const newCheckbox = document.createElement('input');
      newCheckbox.type = 'checkbox';
      newCheckbox.setAttribute('contenteditable', 'false');
      const newTextSpan = document.createElement('span');
      newTextSpan.className = 'checklist-text';
      newTextSpan.appendChild(remainder);
      if (!newTextSpan.hasChildNodes()) newTextSpan.appendChild(document.createElement('br'));

      newLi.appendChild(newCheckbox);
      newLi.appendChild(newTextSpan);
      li.after(newLi);
      placeCaretAtStart(newTextSpan);
      scheduleSave();
    });
  }

  // ---------- Resize ----------
  function setupResizeHandle() {
    const handle = shadowRoot.querySelector('.resize-handle');
    let startX = 0;
    let startWidth = 0;

    handle.addEventListener('pointerdown', (e) => {
      const flyout = flyouts.find(f => f.id === openFlyoutId);
      if (!flyout) return;
      e.preventDefault();
      startX = e.clientX;
      startWidth = getFlyoutWidth(flyout);
      handle.classList.add('dragging');
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', (e) => {
      if (!handle.classList.contains('dragging')) return;
      setPanelWidthVar(clampWidth(startWidth + (e.clientX - startX)));
    });

    handle.addEventListener('pointerup', (e) => {
      if (!handle.classList.contains('dragging')) return;
      handle.classList.remove('dragging');
      handle.releasePointerCapture(e.pointerId);
      const flyout = flyouts.find(f => f.id === openFlyoutId);
      if (flyout) {
        flyout.width = clampWidth(startWidth + (e.clientX - startX));
        saveFlyouts();
      }
    });
  }

  // ---------- Tabs ----------
  function renderTabs() {
    const stack = shadowRoot.querySelector('.tab-stack');
    stack.classList.toggle('shifted', !!openFlyoutId);
    stack.innerHTML = '';
    flyouts
      .filter(f => f.enabled)
      .forEach(f => {
        const tab = document.createElement('div');
        tab.className = 'flyout-tab' + (f.id === openFlyoutId ? ' active' : '');
        tab.textContent = f.name;
        tab.title = f.name;
        tab.addEventListener('click', () => {
          setOpenFlyout(f.id === openFlyoutId ? null : f.id);
        });
        stack.appendChild(tab);
      });
  }

  // ---------- Panel open/close ----------
  function setOpenFlyout(id) {
    // Only one flyout displayed at a time
    if (id && !flyouts.find(f => f.id === id && f.enabled)) {
      id = null;
    }
    openFlyoutId = id;
    chrome.storage.local.set({ [OPEN_FLYOUT_KEY]: id });
    renderTabs();
    renderOpenPanel();
  }

  function renderOpenPanel() {
    const panelEl = shadowRoot.querySelector('.panel');
    const titleEl = shadowRoot.querySelector('.flyout-title');
    const editableEl = shadowRoot.querySelector('.panel-content');

    const flyout = flyouts.find(f => f.id === openFlyoutId);

    if (!flyout) {
      panelEl.classList.remove('open');
      return;
    }

    titleEl.textContent = flyout.name;
    // Only overwrite DOM content if it's not already showing this flyout,
    // so we don't blow away in-progress edits/cursor position unnecessarily.
    if (editableEl.dataset.flyoutId !== flyout.id) {
      editableEl.innerHTML = flyout.html || placeholderHtml(flyout.name);
      normalizeLinks(editableEl);
      editableEl.dataset.flyoutId = flyout.id;
    }
    setPanelWidthVar(getFlyoutWidth(flyout));
    panelEl.classList.add('open');
  }

  async function onResetClick() {
    const flyout = flyouts.find(f => f.id === openFlyoutId);
    if (!flyout) return;
    if (!confirm(`Reset "${flyout.name}" to its default content? This cannot be undone.`)) return;
    flyout.html = placeholderHtml(flyout.name);
    saveFlyouts();
    const editableEl = shadowRoot.querySelector('.panel-content');
    editableEl.innerHTML = flyout.html;
    normalizeLinks(editableEl);
  }

  function destroyPanel() {
    const host = document.getElementById(HOST_ID);
    if (host) host.remove();
    hostEl = null;
    shadowRoot = null;
    flyouts = [];
    openFlyoutId = null;
  }

  // ---------- SPA navigation handling ----------
  function ensurePanelExists() {
    if (!globalEnabled) return;
    if (!document.getElementById(HOST_ID)) {
      buildPanel();
    }
  }

  function patchHistoryMethod(methodName) {
    const original = history[methodName];
    history[methodName] = function (...args) {
      const result = original.apply(this, args);
      window.dispatchEvent(new Event('flyout-locationchange'));
      return result;
    };
  }

  patchHistoryMethod('pushState');
  patchHistoryMethod('replaceState');

  window.addEventListener('popstate', () => {
    window.dispatchEvent(new Event('flyout-locationchange'));
  });

  window.addEventListener('flyout-locationchange', () => {
    setTimeout(ensurePanelExists, 250);
  });

  const observer = new MutationObserver(() => {
    ensurePanelExists();
  });
  observer.observe(document.documentElement, { childList: true, subtree: false });

  // ---------- Init ----------
  chrome.storage.local.get([GLOBAL_ENABLED_KEY], (result) => {
    globalEnabled = result[GLOBAL_ENABLED_KEY] !== false; // default: enabled
    if (globalEnabled) {
      buildPanel();
    }
  });

  // React live to the toolbar toggle without needing a page reload
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    if (changes[GLOBAL_ENABLED_KEY]) {
      globalEnabled = changes[GLOBAL_ENABLED_KEY].newValue !== false;
      if (globalEnabled) {
        ensurePanelExists();
      } else {
        destroyPanel();
      }
    }

    // Collapsing/expanding the formatting ribbon in one tab should be
    // reflected in any other open tab's panel too.
    if (changes[TOOLBAR_COLLAPSED_KEY] && shadowRoot) {
      toolbarCollapsed = changes[TOOLBAR_COLLAPSED_KEY].newValue === true;
      applyToolbarCollapsedState();
    }

    // Flyouts were added/removed/renamed/toggled from the toolbar popup —
    // keep this page's tabs and open panel in sync without a reload.
    if (changes[STORAGE_KEY] && shadowRoot) {
      flyouts = Array.isArray(changes[STORAGE_KEY].newValue) ? changes[STORAGE_KEY].newValue : [];
      const stillValidOpen = flyouts.find(f => f.id === openFlyoutId && f.enabled);
      if (!stillValidOpen) {
        openFlyoutId = null;
      }
      renderTabs();
      renderOpenPanel();
    }
  });
})();
