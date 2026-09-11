const STORAGE_KEY = 'flyouts';
const GLOBAL_ENABLED_KEY = 'globalEnabled';

const enableToggle = document.getElementById('enableToggle');
const statusText = document.getElementById('statusText');
const flyoutListEl = document.getElementById('flyoutList');
const newNameInput = document.getElementById('newFlyoutName');
const addBtn = document.getElementById('addFlyoutBtn');

let flyouts = [];

function makeId() {
  return 'flyout-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
}

function placeholderHtml(name) {
  const div = document.createElement('div');
  div.textContent = name;
  return `<h2>${div.innerHTML}</h2><p>Click here and start typing to edit this flyout.</p>`;
}

function updateStatus(enabled) {
  statusText.textContent = enabled
    ? 'Flyouts are shown on pages you visit.'
    : 'Flyouts are hidden on all pages until re-enabled.';
}

function saveFlyouts() {
  chrome.storage.local.set({ [STORAGE_KEY]: flyouts });
}

function renderFlyoutList() {
  flyoutListEl.innerHTML = '';

  if (flyouts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-msg';
    empty.textContent = 'No flyouts yet. Add one below.';
    flyoutListEl.appendChild(empty);
    return;
  }

  flyouts.forEach((f) => {
    const row = document.createElement('div');
    row.className = 'flyout-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = f.enabled;
    checkbox.title = f.enabled ? 'Enabled — shown on pages' : 'Disabled — hidden on pages';
    checkbox.addEventListener('change', () => {
      f.enabled = checkbox.checked;
      saveFlyouts();
    });

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = f.name;
    nameInput.addEventListener('change', () => {
      const newName = nameInput.value.trim();
      if (newName) {
        f.name = newName;
        saveFlyouts();
      } else {
        nameInput.value = f.name;
      }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => {
      if (!confirm(`Delete flyout "${f.name}"? This cannot be undone.`)) return;
      flyouts = flyouts.filter((x) => x.id !== f.id);
      saveFlyouts();
      renderFlyoutList();
    });

    row.appendChild(checkbox);
    row.appendChild(nameInput);
    row.appendChild(deleteBtn);
    flyoutListEl.appendChild(row);
  });
}

function addFlyout() {
  const name = newNameInput.value.trim();
  if (!name) return;
  flyouts.push({
    id: makeId(),
    name,
    enabled: true,
    html: placeholderHtml(name)
  });
  saveFlyouts();
  newNameInput.value = '';
  renderFlyoutList();
}

addBtn.addEventListener('click', addFlyout);
newNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addFlyout();
});

// ---------- Init ----------
chrome.storage.local.get([GLOBAL_ENABLED_KEY, STORAGE_KEY], (result) => {
  const enabled = result[GLOBAL_ENABLED_KEY] !== false; // default: enabled
  enableToggle.checked = enabled;
  updateStatus(enabled);

  flyouts = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
  renderFlyoutList();
});

enableToggle.addEventListener('change', () => {
  const enabled = enableToggle.checked;
  chrome.storage.local.set({ [GLOBAL_ENABLED_KEY]: enabled });
  updateStatus(enabled);
});
