const $ = selector => document.querySelector(selector);
let state = null;
let chatRunning = false;
let scanRunning = false;
let linkTimer = null;

function notify(message) {
  const box = $('#notice');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(box._hide);
  box._hide = setTimeout(() => { box.hidden = true; }, 6500);
}

function goto(page) {
  for (const element of document.querySelectorAll('.page')) element.classList.toggle('active', element.id === `page-${page}`);
  for (const element of document.querySelectorAll('.nav-item')) element.classList.toggle('active', element.dataset.page === page);
  $('#page-breadcrumb').textContent = ({ home: 'Home', memory: 'Memory', agent: 'Pi Agent', account: 'Ditto Account' })[page];
}

function number(value) { return Number(value || 0).toLocaleString(); }

function renderRoots(roots) {
  const list = $('#roots-list'); list.replaceChildren();
  if (!roots.length) { list.textContent = 'Add a folder to index code.'; return; }
  for (const root of roots) {
    const row = document.createElement('div'); row.className = 'root-item';
    const label = document.createElement('span'); label.textContent = root;
    const remove = document.createElement('button'); remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      try { const next = await window.ditto.removeRoot(root); renderRoots(next); }
      catch (error) { notify(error.message); }
    });
    row.append(label, remove); list.append(row);
  }
}

async function refresh() {
  state = await window.ditto.status();
  $('#stat-code').textContent = number(state.stats.code);
  $('#stat-codex').textContent = number(state.stats.codex);
  $('#stat-cursor').textContent = number(state.stats.cursor);
  $('#stat-memories').textContent = number(state.stats.memories);
  $('#last-scan').textContent = state.stats.lastScan ? `Last scanned ${new Date(state.stats.lastScan).toLocaleString()}` : 'Waiting for first scan';
  $('#header-status').textContent = state.memoryEngine ? 'Local Ditto memory ready' : 'Local text memory ready';
  $('#workspace-path').textContent = state.workspace;
  $('#pi-setup').hidden = state.pi.ready;
  $('#pi-model-status').textContent = state.pi.model;
  $('#account-title').textContent = state.accountLinked ? 'This Mac is linked to Ditto' : 'Sign in with Ditto';
  $('#account-description').textContent = state.accountLinked ? 'Your Ditto sign-in is stored securely on this Mac.' : 'Use Ditto’s secure device sign-in to connect this desktop.';
  $('#link-start').hidden = state.accountLinked;
  $('#sign-out').hidden = !state.accountLinked;
  renderRoots(state.roots);
}

async function scan() {
  if (scanRunning) return;
  scanRunning = true;
  $('#home-scan').disabled = true; $('#memory-scan').disabled = true;
  $('#scan-progress').textContent = 'Scanning…';
  try {
    const result = await window.ditto.scan();
    await refresh();
    notify(`Indexed ${number(result.code + result.codex + result.cursor)} new items${result.memoriesAdded ? ` and saved ${number(result.memoriesAdded)} Ditto memories` : ''}.`);
  } catch (error) { notify(`Scan stopped: ${error.message}`); $('#scan-progress').textContent = error.message; }
  finally { scanRunning = false; $('#home-scan').disabled = false; $('#memory-scan').disabled = false; }
}

function renderResult(result) {
  const card = document.createElement('article'); card.className = 'result';
  const header = document.createElement('header');
  const title = document.createElement('strong'); title.textContent = result.title || 'Ditto memory';
  const source = document.createElement('span'); source.textContent = result.source || 'memory';
  header.append(title, source);
  const body = document.createElement('p'); body.textContent = result.excerpt || result.summary || result.prompt || JSON.stringify(result).slice(0, 450);
  card.append(header, body); return card;
}

async function search(event) {
  event.preventDefault();
  const query = $('#search-input').value.trim();
  if (!query) return;
  const list = $('#search-results'); list.textContent = 'Searching local memory…';
  try {
    const { matches, memories } = await window.ditto.search(query);
    list.replaceChildren();
    const items = [...memories.map(m => ({ ...m, source: 'ditto', title: m.title || 'Ditto memory' })), ...matches];
    if (!items.length) { list.textContent = 'No local memory found for this search.'; return; }
    for (const item of items) list.append(renderResult(item));
  } catch (error) { list.textContent = error.message; }
}

async function startLink() {
  try {
    const challenge = await window.ditto.linkStart();
    $('#device-code-panel').hidden = false;
    $('#device-code').textContent = challenge.userCode;
    $('#device-link-status').textContent = 'Waiting for approval…';
    let interval = challenge.intervalSeconds * 1000;
    async function poll() {
      try {
        const result = await window.ditto.linkPoll();
        if (result.kind === 'linked') {
          $('#device-code-panel').hidden = true; clearTimeout(linkTimer); await refresh(); notify('This Mac is linked to Ditto.'); return;
        }
        if (result.kind === 'expired' || result.kind === 'denied') { $('#device-link-status').textContent = `Sign-in ${result.kind}. Start again.`; return; }
        if (result.kind === 'slow-down') interval += 5000;
        linkTimer = setTimeout(poll, interval);
      } catch (error) { $('#device-link-status').textContent = error.message; }
    }
    clearTimeout(linkTimer); linkTimer = setTimeout(poll, interval);
  } catch (error) { notify(error.message); }
}

function addChatLine(text, className) {
  const line = document.createElement('div'); line.className = className; line.textContent = text;
  $('#chat-output').append(line); $('#chat-output').scrollTop = $('#chat-output').scrollHeight;
  return line;
}

let responseLine = null;
window.ditto.onChatEvent(event => {
  if (event.type === 'start') { $('#context-count').textContent = `${event.memoryCount} local sources`; }
  if (event.type === 'text') {
    if (!responseLine) responseLine = addChatLine('', 'chat-message');
    responseLine.textContent += event.text;
    $('#chat-output').scrollTop = $('#chat-output').scrollHeight;
  }
  if (event.type === 'tool') addChatLine(`↳ Pi used ${event.name}`, 'tool-line');
  if (event.type === 'error') addChatLine(event.message, 'error-line');
});

async function chat(event) {
  event.preventDefault();
  if (chatRunning) return;
  const question = $('#chat-input').value.trim();
  if (!question) return;
  chatRunning = true; responseLine = null;
  $('#chat-output').replaceChildren();
  addChatLine(`You: ${question}\n`, 'tool-line');
  $('#chat-send').disabled = true; $('#chat-cancel').hidden = false;
  try { await window.ditto.chat(question); $('#chat-input').value = ''; }
  catch (error) { if (!responseLine) notify(error.message); }
  finally { chatRunning = false; $('#chat-send').disabled = false; $('#chat-cancel').hidden = true; }
}

document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => goto(button.dataset.page)));
document.querySelectorAll('[data-goto]').forEach(button => button.addEventListener('click', () => goto(button.dataset.goto)));
$('#home-scan').addEventListener('click', scan); $('#memory-scan').addEventListener('click', scan);
$('#search-form').addEventListener('submit', search);
$('#chat-form').addEventListener('submit', chat);
$('#chat-cancel').addEventListener('click', () => window.ditto.cancelChat());
$('#add-root').addEventListener('click', async () => { try { const roots = await window.ditto.chooseRoot(); if (roots) renderRoots(roots); } catch (error) { notify(error.message); } });
$('#choose-workspace').addEventListener('click', async () => { try { const folder = await window.ditto.chooseWorkspace(); if (folder) $('#workspace-path').textContent = folder; } catch (error) { notify(error.message); } });
$('#export-bundle').addEventListener('click', async () => { try { const file = await window.ditto.exportBundle(); notify(`Cloud-ready bundle saved locally: ${file}`); } catch (error) { notify(error.message); } });
$('#link-start').addEventListener('click', startLink);
$('#sign-out').addEventListener('click', async () => { try { await window.ditto.signOut(); await refresh(); notify('Signed out of Ditto.'); } catch (error) { notify(error.message); } });
$('#pi-login').addEventListener('click', async () => { try { await window.ditto.piLogin(); notify('Pi sign-in opened in Terminal. Choose /login there.'); } catch (error) { notify(error.message); } });
window.ditto.onProgress(message => { $('#scan-progress').textContent = message; });
window.ditto.onScanFinished(() => { void refresh(); });
refresh().catch(error => notify(`Could not load Ditto: ${error.message}`));
