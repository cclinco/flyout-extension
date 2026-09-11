(() => {
  const HOST_ID = 'flyout-agenda-host';

  // Avoid double-injection if the script somehow runs twice on the same document
  if (document.getElementById(HOST_ID)) return;

  const STORAGE_KEY = 'flyouts';
  const GLOBAL_ENABLED_KEY = 'globalEnabled';
  const OPEN_FLYOUT_KEY = 'openFlyoutId';
  const DEFAULT_PANEL_WIDTH = 320; // px, used when a flyout has no saved width yet
  const MIN_PANEL_WIDTH = 240;     // px
  const MAX_PANEL_WIDTH = 600;     // px
  const DEFAULT_CONTENT_URL = chrome.runtime.getURL('panel-content.html');

  let hostEl = null;
  let shadowRoot = null;
  let flyouts = [];        // [{ id, name, enabled, html, width }]
  let openFlyoutId = null; // id of the currently open panel, or null
  let globalEnabled = true;

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

  // Sets --panel-width on the shadow host so both the panel and the tab
  // stack (which are siblings inside the shadow root) can read it — a
  // custom property set on the host element inherits into the shadow tree.
  function setPanelWidthVar(px) {
    if (hostEl) hostEl.style.setProperty('--panel-width', `${px}px`);
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

  // ---------- Build the panel ----------
  async function buildPanel() {
    flyouts = await loadFlyouts();

    const storedOpenId = await loadOpenFlyoutId();
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

        .panel-content:focus {
          background: #fafafa;
        }
      </style>

      <div class="tab-stack"></div>
      <div class="panel">
        <div class="panel-header">
          <span class="flyout-title"></span>
          <div class="panel-header-actions">
            <button class="reset-btn" title="Reset this flyout's content">Reset</button>
            <button class="close-btn" title="Close">Close</button>
          </div>
        </div>
        <div class="panel-content" contenteditable="true" spellcheck="false"></div>
        <div class="resize-handle" title="Drag to resize"></div>
      </div>
    `;

    shadowRoot.querySelector('.close-btn').addEventListener('click', () => setOpenFlyout(null));
    shadowRoot.querySelector('.reset-btn').addEventListener('click', onResetClick);
    setupResizeHandle();

    const editableEl = shadowRoot.querySelector('.panel-content');
    stopKeyPropagation(editableEl);
    let saveTimer = null;
    editableEl.addEventListener('input', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const flyout = flyouts.find(f => f.id === openFlyoutId);
        if (flyout) {
          flyout.html = editableEl.innerHTML;
          saveFlyouts();
        }
      }, 500);
    });

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
