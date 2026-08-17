/* ===== Words — app logic ===== */
"use strict";

const DOCS_KEY = 'words.docs';
const STATE_KEY = 'words.state';
const SAVE_DELAY = 700;

/* ----- state ----- */
let docs = [];            // { id, title, content, updatedAt, createdAt }
let currentId = null;
let chats = {};           // { docId: [ {role, content} ] }
let models = [];
let selectedModel = null;
let saveTimer = null;
let dirty = false;
let chatRunning = false;
let panelsCollapsed = false;

/* ----- dom ----- */
const $ = (id) => document.getElementById(id);
const docListEl = $('docList');
const docCountEl = $('docCount');
const searchInput = $('searchInput');
const newDocBtn = $('newDocBtn');
const docTitle = $('docTitle');
const saveStatus = $('saveStatus');
const editorBody = $('editorBody');
const blockType = $('blockType');
const fontName = $('fontName');
const fontSizeSel = $('fontSize');
const colorInput = $('colorInput');
const exportBtn = $('exportBtn');
const exportMenu = $('exportMenu');
const menuBackdrop = $('menuBackdrop');
const modelPicker = $('modelPicker');
const chatLog = $('chatLog');
const chatInput = $('chatInput');
const sendBtn = $('sendBtn');
const panelToggle = $('panelToggle');

/* ============================================================
   INIT
   ============================================================ */
async function init() {
  const savedDocs = await window.chatoss.scopedData.get(DOCS_KEY);
  docs = Array.isArray(savedDocs) ? savedDocs : [];
  const state = await window.chatoss.scopedData.get(STATE_KEY);
  if (state && typeof state === 'object') {
    chats = state.chats || {};
    selectedModel = state.selectedModel || null;
    currentId = state.currentId || null;
    panelsCollapsed = !!state.panelsCollapsed;
  }
  if (!docs.length) {
    const d = createDocObject('Welcome to Words');
    d.content = welcomeContent();
    docs.push(d);
    currentId = d.id;
    await persistDocs();
  }
  if (!currentId || !docs.find(d => d.id === currentId)) currentId = docs[0].id;

  renderDocList();
  loadDoc(currentId);
  applyPanelsCollapsed();
  attachEvents();

  // models
  try {
    models = await window.chatoss.chat.listModels();
    populateModels();
  } catch (e) {
    const opt = document.createElement('option');
    opt.textContent = 'AI unavailable';
    modelPicker.appendChild(opt);
  }
}

function populateModels() {
  modelPicker.innerHTML = '';
  let defaultId = null;
  try { defaultId = window.chatoss.chat.getDefaultModel && window.chatoss.chat.getDefaultModel(); } catch(e){}
  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name || m.id;
    if (m.available === false) { opt.disabled = true; opt.textContent += ' (unavailable)'; }
    modelPicker.appendChild(opt);
  });
  const chosen = selectedModel || defaultId;
  if (chosen && [...modelPicker.options].some(o => o.value === chosen)) modelPicker.value = chosen;
  selectedModel = modelPicker.value || (models[0] && models[0].id);
}

/* ============================================================
   DOCUMENT CRUD
   ============================================================ */
function uid() { return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function createDocObject(title) {
  const now = Date.now();
  return { id: uid(), title: title || 'Untitled document', content: '', createdAt: now, updatedAt: now };
}

async function newDoc() {
  await flushSave();
  const d = createDocObject('Untitled document');
  docs.unshift(d);
  currentId = d.id;
  await persistDocs();
  renderDocList();
  loadDoc(d.id);
  docTitle.focus();
  docTitle.select();
}

async function selectDoc(id) {
  if (id === currentId) return;
  await flushSave();
  currentId = id;
  await persistState();
  renderDocList();
  loadDoc(id);
}

async function deleteDoc(id) {
  const ok = await confirmModal('Delete this document? This cannot be undone.');
  if (!ok) return;
  const idx = docs.findIndex(d => d.id === id);
  if (idx < 0) return;
  docs.splice(idx, 1);
  delete chats[id];
  if (currentId === id) currentId = docs[0] ? docs[0].id : null;
  if (!docs.length) {
    const d = createDocObject('Untitled document');
    docs.unshift(d);
    currentId = d.id;
  }
  await persistDocs();
  await persistState();
  renderDocList();
  loadDoc(currentId);
}

async function renameCurrent(title) {
  const d = docs.find(d => d.id === currentId);
  if (!d) return;
  d.title = title.trim() || 'Untitled document';
  d.updatedAt = Date.now();
  scheduleSave();
  renderDocList();
}

/* ============================================================
   PERSISTENCE
   ============================================================ */
async function persistDocs() { await window.chatoss.scopedData.set(DOCS_KEY, docs); }
async function persistState() { await window.chatoss.scopedData.set(STATE_KEY, { currentId, selectedModel, chats, panelsCollapsed }); }

function scheduleSave() {
  dirty = true;
  setSaveStatus('unsaved');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DELAY);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (!dirty) return;
  const d = docs.find(d => d.id === currentId);
  if (d) {
    d.content = serializedContent();
    d.title = docTitle.value.trim() || 'Untitled document';
    d.updatedAt = Date.now();
  }
  dirty = false;
  setSaveStatus('saving');
  await persistDocs();
  renderDocList();
  setSaveStatus('saved');
}

/* Flatten the editor's .page wrappers back into a plain sequence of
   blocks — identical to the pre-pagination storage format, so saved
   docs, search snippets, and exports are unaffected by pagination. */
function serializedContent() {
  const tmp = document.createElement('div');
  tmp.innerHTML = editorBody.innerHTML;
  tmp.querySelectorAll('.page').forEach(pg => {
    const parent = pg.parentNode;
    while (pg.firstChild) parent.insertBefore(pg.firstChild, pg);
    parent.removeChild(pg);
  });
  return tmp.innerHTML;
}
function setSaveStatus(s) {
  saveStatus.className = 'save-status ' + s;
  saveStatus.textContent = s === 'saving' ? 'Saving…' : s === 'unsaved' ? 'Unsaved' : 'Saved';
}

/* ============================================================
   PANEL COLLAPSE (hide file list + writing assistant)
   ============================================================ */
function applyPanelsCollapsed() {
  document.getElementById('app').classList.toggle('panels-collapsed', panelsCollapsed);
  panelToggle.title = panelsCollapsed ? 'Show panels' : 'Hide panels';
  panelToggle.setAttribute('aria-label', panelsCollapsed ? 'Show panels' : 'Hide panels');
  panelToggle.setAttribute('aria-pressed', String(panelsCollapsed));
  requestAnimationFrame(paginate);
}

async function togglePanels() {
  panelsCollapsed = !panelsCollapsed;
  applyPanelsCollapsed();
  await persistState();
}

/* ============================================================
   RENDER
   ============================================================ */
function renderDocList() {
  const q = searchInput.value.trim().toLowerCase();
  docListEl.innerHTML = '';
  const list = docs.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  let shown = 0;
  list.forEach(d => {
    if (q && !matchesSearch(d, q)) return;
    const item = document.createElement('div');
    item.className = 'doc-item' + (d.id === currentId ? ' active' : '');
    item.dataset.id = d.id;
    const titleEl = document.createElement('div');
    titleEl.className = 'di-title';
    titleEl.textContent = d.title || 'Untitled document';
    const metaEl = document.createElement('div');
    metaEl.className = 'di-meta';
    metaEl.textContent = formatDate(d.updatedAt) + ' · ' + snippet(d.content);
    const del = document.createElement('button');
    del.className = 'di-del';
    del.title = 'Delete';
    del.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteDoc(d.id); });
    item.appendChild(titleEl);
    item.appendChild(metaEl);
    item.appendChild(del);
    item.addEventListener('click', () => selectDoc(d.id));
    docListEl.appendChild(item);
    shown++;
  });
  docCountEl.textContent = shown + (shown === 1 ? ' document' : ' documents');
}

function matchesSearch(d, q) {
  if (d.title.toLowerCase().includes(q)) return true;
  return plainText(d.content).toLowerCase().includes(q);
}

function plainText(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  return (tmp.textContent || '').replace(/\s+/g, ' ').trim();
}

function snippet(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  const t = (tmp.textContent || '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 38) + (t.length > 38 ? '…' : '') : 'Empty';
}

function formatDate(ts) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function loadDoc(id) {
  const d = docs.find(d => d.id === id);
  if (!d) return;
  docTitle.value = d.title;
  editorBody.innerHTML = d.content || '';
  editorBody.setAttribute('data-placeholder', 'Start writing…');
  setSaveStatus('saved');
  renderChat();
  // Reset undo history for the freshly loaded document.
  undoStack = []; redoStack = [];
  requestAnimationFrame(() => {
    paginate();
    lastSnapshot = snapshot();
  });
}

/* ============================================================
   PAGINATION — real "pages"
   The editor holds a stack of <div class="page"> elements. Each
   page is a fixed physical size (8.5x11in) with 1in margins and a
   gap between pages. After every edit we redistribute the document's
   block elements across pages so no page ever overflows: blocks are
   greedily packed into a page until the next block would spill, then
   a new page is started. A single block taller than the remaining
   space (e.g. a long paragraph) is split at the exact text position
   that fills the page, and the remainder continues on the next page —
   exactly how Google Docs / Word paginate. The caret is saved as a
   global character offset and restored after the reshuffle so the
   cursor lands where the user expects (including on a freshly
   created page).
   The page geometry (8.5x11in, 1in margins, 18px gap) lives in style.css
   on the .page rule. Overflow is measured at runtime via
   page.scrollHeight vs page.clientHeight.
   ============================================================ */
const OVERFLOW_TOL = 1;     // sub-pixel tolerance when measuring overflow
let paginateScheduled = false;

function newPage() {
  const p = document.createElement('div');
  p.className = 'page';
  return p;
}

function getPages() {
  return Array.from(editorBody.querySelectorAll(':scope > .page'));
}

/* True if a page's content exceeds its printable area. */
function pageOverflows(page) {
  return page.scrollHeight > page.clientHeight + OVERFLOW_TOL;
}

/* True if any page currently overflows its printable area. */
function pagesOverflow() {
  for (const pg of getPages()) {
    if (pg.scrollHeight > pg.clientHeight + OVERFLOW_TOL) return true;
  }
  return false;
}

function pageIsEmpty(page) {
  return page.childNodes.length === 0;
}

function isInlineNode(node) {
  if (node.nodeType === 3) return true;            // text
  if (node.nodeType !== 1) return false;
  const t = node.tagName;
  return /^(A|B|STRONG|I|EM|U|S|STRIKE|SPAN|CODE|SUB|SUP|SMALL|FONT|BR)$/.test(t);
}

/* Ensure every child of the editor lives inside a .page wrapper.
   Legacy docs and AI-injected HTML arrive as loose blocks; wrap them.
   Also fold any bare inline content (text/br/spans) that sits directly
   inside a page into a <p> — without this, pressing Enter in an empty
   page splits the page div itself (creating a spurious new page); with
   text always inside a block, Enter splits the block instead. */
function normalizePages() {
  wrapBareInlineInPages();
  if (!getPages().length) {
    const p = newPage();
    while (editorBody.firstChild) p.appendChild(editorBody.firstChild);
    editorBody.appendChild(p);
    return;
  }
  // Wrap any loose (non-page) top-level nodes into a page at the end.
  const loose = Array.from(editorBody.childNodes).filter(
    n => !(n.nodeType === 1 && n.classList && n.classList.contains('page'))
  );
  if (loose.length) {
    const p = newPage();
    loose.forEach(n => p.appendChild(n));
    editorBody.appendChild(p);
  }
  wrapBareInlineInPages();
}

/* True if any page has inline content sitting directly inside it
   (not wrapped in a block). Cheap gate so the common all-blocks case
   costs only a scan. */
function hasBareInline() {
  for (const pg of getPages()) {
    for (const n of pg.childNodes) {
      if (isInlineNode(n)) return true;
    }
  }
  return false;
}

/* Wrap every run of consecutive inline direct-children of a page into a
   <p>, leaving block children untouched. Returns true if it changed anything. */
function wrapBareInlineInPages() {
  let changed = false;
  for (const pg of getPages()) {
    const kids = Array.from(pg.childNodes);
    let i = 0;
    while (i < kids.length) {
      if (isInlineNode(kids[i])) {
        const group = [];
        while (i < kids.length && isInlineNode(kids[i])) { group.push(kids[i]); i++; }
        const p = document.createElement('p');
        pg.insertBefore(p, group[0]);
        group.forEach(n => p.appendChild(n));
        changed = true;
      } else {
        i++;
      }
    }
  }
  return changed;
}

/* A brand-new / fully-deleted document is a single empty page. Give it an
   empty <p><br></p> so the very first keystroke (or Enter) lands inside a
   block — never bare in the page, and never splitting the page. */
function ensureEmptyDocHasBlock() {
  const pages = getPages();
  if (pages.length !== 1) return;
  if ((pages[0].textContent || '').replace(/\u200b/g, '').trim().length) return;
  pages[0].innerHTML = '<p><br></p>';
}

/* Split a single inline node (text or inline element) by characters so
   that `top` (already in the DOM) stays <= maxH. Appends the fitting
   part to `top`; returns the leftover part (detached) or null. */
function splitInline(node, maxH, top) {
  if (node.tagName === 'BR') return node;          // hand BR back to caller
  const text = node.textContent != null ? node.textContent : node.nodeValue;
  const make = (s) => node.nodeType === 3
    ? document.createTextNode(s)
    : (() => { const c = node.cloneNode(false); c.textContent = s; return c; })();

  const probe = make('');
  top.appendChild(probe);
  let lo = 0, hi = text.length, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    probe.textContent = text.slice(0, mid);
    if (top.scrollHeight <= maxH) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  top.removeChild(probe);
  if (best === 0 && text.length > 0) best = 1;     // guarantee progress
  if (best > 0) top.appendChild(make(text.slice(0, best)));
  const rest = text.slice(best);
  return rest ? make(rest) : null;
}

/* Block `block` does not fit in `page` even alone. Clone its shell,
   fill `page` with as many of its children as fit (splitting the one
   that crosses the boundary), and return the leftover block (detached)
   or null if everything fit. `block` is consumed. */
function splitBlockToFit(block, page) {
  const maxH = page.clientHeight;
  const top = block.cloneNode(false);
  page.appendChild(top);
  const bottom = block.cloneNode(false);
  const kids = Array.from(block.childNodes);
  let i = 0;
  for (; i < kids.length; i++) {
    const kid = kids[i];
    top.appendChild(kid);                          // moves kid out of block into top
    if (top.scrollHeight > maxH) {
      top.removeChild(kid);
      if (kid.tagName === 'BR') { bottom.appendChild(kid); i++; break; }
      if (isInlineNode(kid)) {
        const rest = splitInline(kid, maxH, top);
        if (rest) bottom.appendChild(rest);
      } else {
        bottom.appendChild(kid);                   // nested block → move whole
      }
      i++;
      break;
    }
  }
  for (; i < kids.length; i++) bottom.appendChild(kids[i]);

  // Safety: if nothing fit at all, force the first kid in to guarantee progress.
  if (top.childNodes.length === 0 && kids.length) {
    top.appendChild(kids[0]);
    if (bottom.firstChild === kids[0]) bottom.removeChild(kids[0]);
  }
  return bottom.childNodes.length ? bottom : null;
}

/* Save the caret so it survives pagination's DOM reshuffle.
   We record BOTH:
     - block:   the top-level block (direct child of a .page) that contains
                the caret, kept by node identity (pagination moves whole blocks
                rather than recreating them, so identity is preserved — this is
                what makes a freshly-created empty line from Enter restorable).
     - offset:  character offset within that block (0 at its start).
     - global:  fallback character offset across the whole editor, used only
                when the block was split/cloned by splitBlockToFit (rare).
   Returns null when the selection is outside the editor. */
function saveCaret() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const node = sel.anchorNode, off = sel.anchorOffset;
  if (!node || !editorBody.contains(node)) return null;

  // Find the nearest ancestor that is a direct child of a .page (a top-level block).
  let block = null, n = node;
  while (n && n !== editorBody) {
    if (n.parentNode && n.nodeType === 1 && n.parentNode.classList && n.parentNode.classList.contains('page')) {
      block = n; break;
    }
    n = n.parentNode;
  }
  const global = globalCharOffset(node, off);
  if (!block) return { block: null, offset: 0, global };
  return { block, offset: charOffsetWithin(block, node, off), global };
}

/* Count raw text characters in the editor before the boundary (node, off). */
function globalCharOffset(node, off) {
  if (node === editorBody) return 0;
  let total = 0;
  const walker = document.createTreeWalker(editorBody, NodeFilter.SHOW_TEXT, null);
  while (walker.nextNode()) {
    const tn = walker.currentNode;
    if (tn === node) return total + Math.min(off, tn.nodeValue.length);
    const pos = tn.compareDocumentPosition(node);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) total += tn.nodeValue.length;
    else if (pos & Node.DOCUMENT_POSITION_CONTAINED_BY) { if (textBeforeChildOffset(tn, node, off)) total += tn.nodeValue.length; }
    else if (pos & Node.DOCUMENT_POSITION_PRECEDING) break;
  }
  return total;
}

/* Count raw text characters within `block` before the boundary (node, off). */
function charOffsetWithin(block, node, off) {
  let total = 0;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  while (walker.nextNode()) {
    const tn = walker.currentNode;
    if (tn === node) return total + Math.min(off, tn.nodeValue.length);
    const pos = tn.compareDocumentPosition(node);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) total += tn.nodeValue.length;
    else if (pos & Node.DOCUMENT_POSITION_CONTAINED_BY) { if (textBeforeChildOffset(tn, node, off)) total += tn.nodeValue.length; }
    else if (pos & Node.DOCUMENT_POSITION_PRECEDING) break;
  }
  return total;
}

/* For an element-anchor caret at (node, off): is text node tn located
   before the off-th child of node? */
function textBeforeChildOffset(tn, node, off) {
  let cur = tn, child = null;
  while (cur && cur !== node) { child = cur; cur = cur.parentNode; }
  if (!child) return false;
  const idx = Array.from(node.childNodes).indexOf(child);
  return idx >= 0 && idx < off;
}

/* Restore the caret from a saved snapshot. Prefer block-identity (handles
   empty lines from Enter); fall back to the global offset if the block was
   split/removed during pagination. */
function restoreCaret(snap) {
  if (!snap) return;
  if (snap.block && editorBody.contains(snap.block)) {
    placeCaretInBlock(snap.block, snap.offset);
  } else {
    placeCaretGlobal(snap.global);
  }
}

function placeCaretInBlock(block, offset) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  let acc = 0, last = null;
  while (walker.nextNode()) {
    last = walker.currentNode;
    const len = last.nodeValue.length;
    if (acc + len >= offset) { placeCaret(last, Math.min(offset - acc, len)); return; }
    acc += len;
  }
  if (last) placeCaret(last, last.nodeValue.length);   // end of block's text
  else placeCaret(block, 0);                            // empty block (e.g. a fresh Enter line)
}

function placeCaretGlobal(offset) {
  if (offset == null) return;
  const walker = document.createTreeWalker(editorBody, NodeFilter.SHOW_TEXT, null);
  let acc = 0, last = null;
  while (walker.nextNode()) {
    last = walker.currentNode;
    const len = last.nodeValue.length;
    if (acc + len >= offset) { placeCaret(last, Math.min(offset - acc, len)); return; }
    acc += len;
  }
  if (last) placeCaret(last, last.nodeValue.length);
  else { const page = editorBody.querySelector('.page') || editorBody; placeCaret(page, 0); }
}

function placeCaret(node, offset) {
  try {
    const r = document.createRange();
    r.setStart(node, Math.min(offset, (node.nodeValue != null ? node.nodeValue.length : node.childNodes.length)));
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  } catch (e) { /* ignore */ }
}

/* The core: redistribute all blocks across pages. */
function paginate() {
  if (!editorBody) return;
  const savedCaret = saveCaret();
  clearPlaceholder();
  normalizePages();

  // Gather every block (in order) from all pages into a detached array.
  const queue = [];
  getPages().forEach(pg => {
    while (pg.firstChild) queue.push(pg.removeChild(pg.firstChild));
  });
  // Also any loose top-level nodes (defensive).
  Array.from(editorBody.childNodes).forEach(n => {
    if (!(n.nodeType === 1 && n.classList && n.classList.contains('page'))) queue.push(n);
  });

  editorBody.innerHTML = '';
  let page = newPage();
  editorBody.appendChild(page);

  let i = 0;
  while (i < queue.length) {
    const block = queue[i];
    page.appendChild(block);                        // detached → into current page
    if (pageOverflows(page)) {
      page.removeChild(block);
      if (pageIsEmpty(page)) {
        // Block too tall for an empty page → split it to fill, then continue the rest on a new page.
        const rest = splitBlockToFit(block, page);
        if (rest) { page = newPage(); editorBody.appendChild(page); queue[i] = rest; continue; }
        i++; continue;
      }
      // Page already has content that fills it → move block to a fresh page.
      page = newPage();
      editorBody.appendChild(page);
      page.appendChild(block);
      if (pageOverflows(page)) {
        page.removeChild(block);
        const rest = splitBlockToFit(block, page);
        if (rest) { page = newPage(); editorBody.appendChild(page); queue[i] = rest; continue; }
        i++; continue;
      }
    }
    i++;
  }

  if (!getPages().length) editorBody.appendChild(newPage());   // always >= 1 page
  trimTrailingEmptyPages();
  ensureEmptyDocHasBlock();
  updatePlaceholder();
  restoreCaret(savedCaret);
}

/* Remove empty pages at the end, but always keep at least one. */
function trimTrailingEmptyPages() {
  const pages = getPages();
  for (let k = pages.length - 1; k > 0; k--) {
    if (pages[k].childNodes.length === 0) pages[k].remove();
    else break;
  }
}

function clearPlaceholder() {
  const p = editorBody.querySelector('.page.show-placeholder');
  if (p) p.classList.remove('show-placeholder');
}

function updatePlaceholder() {
  const first = editorBody.querySelector('.page');
  if (!first) return;
  const hasText = Array.from(getPages()).some(pg => (pg.textContent || '').trim().length > 0);
  first.classList.toggle('show-placeholder', !hasText);
}

function schedulePaginate() {
  if (paginateScheduled) return;
  paginateScheduled = true;
  requestAnimationFrame(() => {
    paginateScheduled = false;
    paginate();
  });
}

/* ============================================================
   UNDO / REDO — snapshot-based
   Pagination reshuffles the DOM between edits, which conflicts with
   the browser's native contenteditable undo stack. We keep our own
   stack of serialized-content + caret snapshots instead.
   ============================================================ */
const UNDO_LIMIT = 80;
let undoStack = [];
let redoStack = [];
let lastSnapshot = null;
let undoCoalesceTimer = null;

function snapshot() {
  return { html: serializedContent(), caret: saveCaret() };
}

function pushUndoIfChanged() {
  // Coalesce rapid typing: only push when content differs from the last pushed snapshot.
  clearTimeout(undoCoalesceTimer);
  undoCoalesceTimer = setTimeout(() => {
    const snap = snapshot();
    if (lastSnapshot && snap.html === lastSnapshot.html) return;
    undoStack.push(snap);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = [];
    lastSnapshot = snap;
  }, 450);
}

function pushUndoNow() {
  clearTimeout(undoCoalesceTimer);
  const snap = snapshot();
  if (lastSnapshot && snap.html === lastSnapshot.html) return;
  undoStack.push(snap);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack = [];
  lastSnapshot = snap;
}

function restoreSnapshot(snap) {
  editorBody.innerHTML = snap.html || '';
  paginate();
  if (snap.caret != null) {
    editorBody.focus();
    restoreCaret(snap.caret);
  }
  scheduleSave();
  lastSnapshot = snap;
}

function doUndo() {
  if (!undoStack.length) return;
  // The current live state is the "top"; push it to redo, then restore the previous.
  const current = snapshot();
  if (!lastSnapshot || current.html !== lastSnapshot.html) {
    redoStack.push(current);
  } else if (redoStack.length === 0) {
    // nothing undone yet
  }
  const prev = undoStack.pop();
  if (prev) {
    redoStack.push(current);
    restoreSnapshot(prev);
  }
}

function doRedo() {
  if (!redoStack.length) return;
  const next = redoStack.pop();
  undoStack.push(next);
  restoreSnapshot(next);
}

/* ============================================================
   EDITOR / TOOLBAR
   ============================================================ */
function exec(cmd, val) {
  pushUndoNow();
  editorBody.focus();
  document.execCommand(cmd, false, val);
  scheduleSave();
  updatePlaceholder();
  if (pagesOverflow()) schedulePaginate();
  setTimeout(updateToolbarState, 0);
}

function updateToolbarState() {
  ['bold', 'italic', 'underline', 'strikeThrough'].forEach(cmd => {
    const btn = document.querySelector(`.tb-btn[data-cmd="${cmd}"]`);
    if (!btn) return;
    try { btn.classList.toggle('active', document.queryCommandState(cmd)); } catch (e) {}
  });
  try {
    const blk = (document.queryCommandValue('formatBlock') || 'p').toLowerCase().replace(/[<>]/g, '');
    if (['p', 'h1', 'h2', 'h3'].includes(blk)) blockType.value = blk;
  } catch (e) {}
}

function attachEditorEvents() {
  editorBody.addEventListener('input', (e) => {
    scheduleSave();
    pushUndoIfChanged();
    updatePlaceholder();
    // Keep text inside block elements: if any page has bare inline content
    // (e.g. the first character typed into an empty page), wrap it in a <p>
    // so the next Enter splits the block — not the page div itself.
    if (hasBareInline()) {
      const snap = saveCaret();
      wrapBareInlineInPages();
      restoreCaret(snap);
    }
    // Only reshuffle pages when something actually changed the layout:
    // a deletion (needs pull-up + empty-page removal) or an insertion that
    // overflowed a page. Plain typing and Enter within a page are left native
    // so the caret and line breaks behave exactly as the browser intends.
    const it = (e && e.inputType) || '';
    if (it.indexOf('delete') === 0 || pagesOverflow()) schedulePaginate();
  });
  editorBody.addEventListener('keyup', updateToolbarState);
  editorBody.addEventListener('mouseup', updateToolbarState);
  editorBody.addEventListener('focus', updateToolbarState);
  window.addEventListener('resize', schedulePaginate);

  document.querySelectorAll('.tb-btn[data-cmd]').forEach(btn => {
    const cmd = btn.dataset.cmd;
    if (cmd === 'undo' || cmd === 'redo') return;   // handled separately below
    btn.addEventListener('click', () => exec(cmd));
  });

  $('undoBtn').addEventListener('click', doUndo);
  $('redoBtn').addEventListener('click', doRedo);

  blockType.addEventListener('change', () => exec('formatBlock', '<' + blockType.value + '>'));
  fontName.addEventListener('change', () => exec('fontName', fontName.value));
  fontSizeSel.addEventListener('change', () => exec('fontSize', fontSizeSel.value));
  colorInput.addEventListener('input', () => exec('foreColor', colorInput.value));

  $('insertLink').addEventListener('click', insertLink);
  docTitle.addEventListener('input', () => renameCurrent(docTitle.value));
  docTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); editorBody.focus(); } });

  // Undo/redo keys — intercept so our snapshot stack is used instead of native undo
  // (which conflicts with pagination's DOM reshuffling).
  editorBody.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (e.key === 'z' || e.key === 'Z') {
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
    } else if (e.key === 'y' || e.key === 'Y') {
      e.preventDefault();
      doRedo();
    }
  });
}

async function insertLink() {
  const sel = window.getSelection();
  const hasSel = sel && sel.rangeCount && !sel.isCollapsed;
  const url = await promptModal('Insert link', 'Enter the URL', 'https://');
  if (!url) return;
  editorBody.focus();
  // try to restore selection
  if (hasSel) {
    try { exec('createLink', url); } catch (e) { exec('createLink', url); }
  } else {
    const text = url;
    document.execCommand('insertHTML', false, `<a href="${escapeAttr(url)}">${escapeHtml(text)}</a>`);
  }
  scheduleSave();
}

/* ============================================================
   EXPORT
   ============================================================ */
function openExportMenu() {
  exportMenu.classList.remove('hidden');
  menuBackdrop.classList.remove('hidden');
}
function closeExportMenu() {
  exportMenu.classList.add('hidden');
  menuBackdrop.classList.add('hidden');
}

/* Walk the contenteditable editor and produce an array of plain-text
   paragraphs (one string per block/line). Used by the documents API,
   which takes { title, paragraphs }. List items become their own lines. */
function editorToParagraphs() {
  const paragraphs = [];
  const pushLine = (text) => {
    const t = (text || '').replace(/\u00a0/g, ' ').trim();
    if (t) paragraphs.push(t);
  };

  // Build a detached, page-flattened tree so the walker only sees blocks.
  const root = document.createElement('div');
  root.innerHTML = serializedContent();

  const walkBlock = (node) => {
    if (node.nodeType === 3) {
      const t = node.textContent;
      if (t && t.trim()) {
        // bare text node directly under editor — group into one line
        if (!paragraphs.length || paragraphs[paragraphs.length - 1] === '') {
          pushLine(t);
        } else {
          paragraphs[paragraphs.length - 1] += t;
        }
      }
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === 'UL' || tag === 'OL') {
      let n = 0;
      for (const li of node.children) {
        if (li.tagName !== 'LI') continue;
        const prefix = tag === 'OL' ? (++n) + '. ' : '• ';
        pushLine(prefix + (li.innerText || li.textContent || ''));
      }
      return;
    }
    if (tag === 'BR') { paragraphs.push(''); return; }
    if (/^(P|H1|H2|H3|H4|H5|H6|DIV|BLOCKQUOTE|PRE)$/.test(tag)) {
      // one block = one paragraph line (block-level <br> splits lines)
      const text = (node.innerText || node.textContent || '').replace(/\u00a0/g, ' ');
      // innerText honors <br> as newlines; split them into separate paragraphs
      if (text.indexOf('\n') >= 0) {
        text.split(/\n/).forEach(l => pushLine(l));
      } else {
        pushLine(text);
      }
      return;
    }
    // inline element sitting as a direct child — append to last line
    const t = (node.innerText || node.textContent || '');
    if (t.trim()) {
      if (!paragraphs.length) pushLine('');
      paragraphs[paragraphs.length - 1] += t;
    }
  };

  for (const child of root.childNodes) walkBlock(child);
  if (!paragraphs.length) paragraphs.push('');
  return paragraphs;
}

function safeFileName(title, ext) {
  return (title || 'document').replace(/[^\w\- ]+/g, '_').slice(0, 60) + '.' + ext;
}

async function exportPDF() {
  const title = docTitle.value.trim() || 'Untitled document';
  const paragraphs = editorToParagraphs();
  try {
    toast('Generating PDF…');
    const saved = await window.chatoss.documents.save({
      type: 'pdf',
      content: { title, paragraphs },
      defaultPath: safeFileName(title, 'pdf')
    });
    if (saved) toast('Exported ' + saved.split(/[\\/]/).pop());
  } catch (e) {
    toast('PDF export failed: ' + (e && e.message ? e.message : e));
  }
}

async function exportWord() {
  const title = docTitle.value.trim() || 'Untitled document';
  const paragraphs = editorToParagraphs();
  try {
    toast('Generating Word document…');
    const saved = await window.chatoss.documents.save({
      type: 'docx',
      content: { title, paragraphs },
      defaultPath: safeFileName(title, 'docx')
    });
    if (saved) toast('Exported ' + saved.split(/[\\/]/).pop());
  } catch (e) {
    toast('Word export failed: ' + (e && e.message ? e.message : e));
  }
}

/* ============================================================
   AI CHAT
   ============================================================ */
function renderChat() {
  const hist = chats[currentId] || [];
  chatLog.innerHTML = '';
  if (!hist.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.innerHTML = 'Ask the assistant to draft, rewrite, expand, summarize, or fix your writing. Changes it makes appear in your document instantly.';
    chatLog.appendChild(empty);
    return;
  }
  hist.forEach(m => addChatBubble(m.role, m.content, false));
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addChatBubble(role, content, streaming) {
  const div = document.createElement('div');
  div.className = 'msg ' + (role === 'user' ? 'user' : 'ai') + (streaming ? ' streaming' : '');
  div.textContent = content || '';
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

function currentDocText() {
  const d = docs.find(d => d.id === currentId);
  if (!d) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = d.content || '';
  return (tmp.innerText || tmp.textContent || '').trim();
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'set_title',
      description: 'Rename the current document.',
      parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'replace_document',
      description: 'Replace the entire document body with new text. Use markdown (**bold**, *italic*, # Heading, - list items).',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'append_to_document',
      description: 'Append new text to the end of the document. Use markdown for formatting.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'replace_text',
      description: 'Find and replace a phrase within the document, preserving all other formatting.',
      parameters: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' } }, required: ['find', 'replace'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'insert_at_cursor',
      description: 'Insert text at the current cursor position in the document. Use markdown for formatting.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    }
  }
];

async function onToolCall(call) {
  const name = call.function.name;
  const a = call.function.arguments || {};
  try {
    if (name === 'set_title') {
      docTitle.value = a.title;
      renameCurrent(a.title);
      return 'Document renamed to "' + a.title + '".';
    }
    if (name === 'replace_document') {
      editorBody.innerHTML = markdownToHtml(a.text);
      paginate();
      scheduleSave();
      await flushSave();
      return 'Document replaced with the new content.';
    }
    if (name === 'append_to_document') {
      const html = markdownToHtml(a.text);
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      while (tmp.firstChild) editorBody.appendChild(tmp.firstChild);
      paginate();
      scheduleSave();
      await flushSave();
      return 'Text appended to the document.';
    }
    if (name === 'replace_text') {
      let count = 0;
      const walker = document.createTreeWalker(editorBody, NodeFilter.SHOW_TEXT, null);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach(n => {
        if (n.nodeValue.indexOf(a.find) >= 0) {
          n.nodeValue = n.nodeValue.split(a.find).join(a.replace);
          count++;
        }
      });
      if (count) { scheduleSave(); await flushSave(); }
      return count ? ('Replaced ' + count + ' occurrence(s).') : ('"' + a.find + '" not found in the document.');
    }
    if (name === 'insert_at_cursor') {
      const html = markdownToHtml(a.text);
      editorBody.focus();
      document.execCommand('insertHTML', false, html);
      paginate();
      scheduleSave();
      await flushSave();
      return 'Text inserted at the cursor.';
    }
    return 'Unknown tool.';
  } catch (e) {
    return 'Tool error: ' + (e && e.message ? e.message : e);
  }
}

async function sendChat() {
  if (chatRunning) return;
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  chatRunning = true;
  sendBtn.disabled = true;

  const hist = chats[currentId] || (chats[currentId] = []);
  hist.push({ role: 'user', content: text });
  addChatBubble('user', text, false);

  const bubble = addChatBubble('assistant', '', true);
  let streamed = '';

  const sys = 'You are a writing assistant inside the Words word processor. ' +
    'You can edit the user\'s document using tools (set_title, replace_document, append_to_document, replace_text, insert_at_cursor). ' +
    'When the user asks for edits, use the tools to apply them directly — do not just show text. ' +
    'For new prose, you may use replace_document or append_to_document with markdown formatting. ' +
    'Be concise in your replies.\n\n' +
    'Current document title: "' + (docTitle.value || 'Untitled') + '".\n' +
    'Current document content (plain text):\n"""\n' + (currentDocText().slice(0, 4000)) + '\n"""';

  const messages = [{ role: 'system', content: sys }].concat(
    hist.map(m => ({ role: m.role, content: m.content }))
  );

  try {
    const result = await window.chatoss.chat.runTurn({
      model: selectedModel || undefined,
      messages,
      tools: TOOLS,
      onToolCall,
      onToken: (t) => { streamed += t; bubble.textContent = streamed; chatLog.scrollTop = chatLog.scrollHeight; }
    });
    bubble.classList.remove('streaming');
    const finalText = (result && result.content) ? result.content : streamed;
    bubble.textContent = finalText;
    hist.push({ role: 'assistant', content: finalText });
    await persistState();
  } catch (e) {
    bubble.classList.remove('streaming');
    bubble.textContent = '⚠ ' + (e && e.message ? e.message : 'The request failed.');
    hist.push({ role: 'assistant', content: bubble.textContent });
    await persistState();
  } finally {
    chatRunning = false;
    sendBtn.disabled = false;
  }
}

/* ============================================================
   MARKDOWN -> HTML (lightweight, for AI tool output)
   ============================================================ */
function markdownToHtml(md) {
  if (!md) return '';
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let inUl = false, inOl = false;
  const closeLists = () => { if (inUl) { html += '</ul>'; inUl = false; } if (inOl) { html += '</ol>'; inOl = false; } };
  for (let raw of lines) {
    const line = raw;
    if (/^\s*$/.test(line)) { closeLists(); continue; }
    let m;
    if ((m = line.match(/^###\s+(.*)$/))) { closeLists(); html += '<h3>' + inlineMd(m[1]) + '</h3>'; }
    else if ((m = line.match(/^##\s+(.*)$/))) { closeLists(); html += '<h2>' + inlineMd(m[1]) + '</h2>'; }
    else if ((m = line.match(/^#\s+(.*)$/))) { closeLists(); html += '<h1>' + inlineMd(m[1]) + '</h1>'; }
    else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { if (!inUl) { closeLists(); html += '<ul>'; inUl = true; } html += '<li>' + inlineMd(m[1]) + '</li>'; }
    else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) { if (!inOl) { closeLists(); html += '<ol>'; inOl = true; } html += '<li>' + inlineMd(m[1]) + '</li>'; }
    else { closeLists(); html += '<p>' + inlineMd(line) + '</p>'; }
  }
  closeLists();
  return html;
}

function inlineMd(s) {
  s = escapeHtml(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return s;
}

/* ============================================================
   MODAL (no native prompt/confirm — sandbox-safe)
   ============================================================ */
function modalEl() {
  let m = $('appModal');
  if (m) return m;
  m = document.createElement('div');
  m.id = 'appModal';
  m.className = 'modal-overlay hidden';
  m.innerHTML =
    '<div class="modal-box">' +
      '<div class="modal-title"></div>' +
      '<input class="modal-input" type="text" style="display:none">' +
      '<div class="modal-msg"></div>' +
      '<div class="modal-actions">' +
        '<button class="modal-cancel">Cancel</button>' +
        '<button class="modal-ok primary-btn">OK</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(m);
  return m;
}

function confirmModal(message) {
  return new Promise(resolve => {
    const m = modalEl();
    m.querySelector('.modal-title').textContent = '';
    m.querySelector('.modal-msg').textContent = message;
    m.querySelector('.modal-msg').style.display = '';
    m.querySelector('.modal-input').style.display = 'none';
    m.querySelector('.modal-ok').textContent = 'Delete';
    m.classList.remove('hidden');
    const ok = m.querySelector('.modal-ok'), cancel = m.querySelector('.modal-cancel');
    const done = (val) => { cleanup(); resolve(val); };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onKey = (e) => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); };
    function cleanup() { ok.removeEventListener('click', onOk); cancel.removeEventListener('click', onCancel); document.removeEventListener('keydown', onKey); m.classList.add('hidden'); }
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
    ok.focus();
  });
}

function promptModal(title, message, defVal) {
  return new Promise(resolve => {
    const m = modalEl();
    m.querySelector('.modal-title').textContent = title;
    m.querySelector('.modal-msg').textContent = message;
    m.querySelector('.modal-msg').style.display = '';
    const input = m.querySelector('.modal-input');
    input.style.display = '';
    input.value = defVal || '';
    m.querySelector('.modal-ok').textContent = 'Insert';
    m.classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 0);
    const ok = m.querySelector('.modal-ok'), cancel = m.querySelector('.modal-cancel');
    const done = (val) => { cleanup(); resolve(val); };
    const onOk = () => done(input.value.trim() || null);
    const onCancel = () => done(null);
    const onKey = (e) => { if (e.key === 'Escape') done(null); if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim() || null); } };
    function cleanup() { ok.removeEventListener('click', onOk); cancel.removeEventListener('click', onCancel); input.removeEventListener('keydown', onKey); m.classList.add('hidden'); }
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

/* ----- toast ----- */
let toastTimer = null;
function toast(msg) {
  let t = $('appToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'appToast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ============================================================
   EVENTS
   ============================================================ */
function attachEvents() {
  attachEditorEvents();
  newDocBtn.addEventListener('click', newDoc);
  searchInput.addEventListener('input', renderDocList);
  panelToggle.addEventListener('click', togglePanels);

  modelPicker.addEventListener('change', async () => {
    selectedModel = modelPicker.value;
    await persistState();
  });

  sendBtn.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  // export menu
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (exportMenu.classList.contains('hidden')) openExportMenu(); else closeExportMenu();
  });
  menuBackdrop.addEventListener('click', closeExportMenu);
  exportMenu.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', async () => {
      const type = b.dataset.export;
      closeExportMenu();
      await flushSave();
      if (type === 'pdf') exportPDF();
      else if (type === 'word') exportWord();
    });
  });

  // save before unload-ish (window close handled by scopedData persistence; flush on visibilitychange)
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); flushSave(); toast('Saved'); }
  });
}

/* ============================================================
   UTIL
   ============================================================ */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function welcomeContent() {
  return '<h1>Welcome to Words</h1>' +
    '<p>This is your own offline word processor. Everything you type is saved automatically to this device.</p>' +
    '<h2>What you can do</h2>' +
    '<ul>' +
    '<li><b>Format</b> your text with the toolbar above — bold, italic, headings, lists, colors, and more.</li>' +
    '<li><b>Ask the assistant</b> in the middle panel to draft, rewrite, summarize, or edit your writing. Changes it makes appear here instantly.</li>' +
    '<li><b>Export</b> your document as a <b>PDF</b> or a <b>Word (.docx)</b> file, or <b>Print</b> it, using the Export button.</li>' +
    '<li>Create new documents from the panel on the left.</li>' +
    '</ul>' +
    '<p>Select all of this text and delete it, then start writing your own document.</p>';
}

/* boot */
window.addEventListener('DOMContentLoaded', init);