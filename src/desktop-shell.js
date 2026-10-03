(() => {
  if (!window.ditto) return;
  const $ = selector => document.querySelector(selector);
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const number = value => Number(value || 0).toLocaleString();
  let activePanel = null;
  let cloudCodeMode = false;
  let defaultCodeOpenPending = false;
  function markActive() {
    const target = activePanel === 'Inbox' ? 'Chats' : activePanel === 'Local' ? 'Code'
      : location.pathname.startsWith('/code') ? 'Code' : location.pathname === '/' ? 'Chats' : null;
    if (!target) return;
    for (const button of document.querySelectorAll('nav.v2-studio-rail a.v2-sidebar-nav-button')) {
      const selected = button.getAttribute('aria-label') === target;
      button.classList.toggle('is-selected', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    for (const button of document.querySelectorAll('[data-ditto-code-mode]')) {
      button.classList.toggle('is-selected', button.dataset.dittoCodeMode === (activePanel === 'Local' ? 'local' : 'cloud'));
    }
  }
  function openPanel(name) {
    activePanel = name;
    document.body.classList.remove('ditto-local-from-chat');
    document.body.classList.toggle('ditto-local-open', name === 'Local');
    document.body.classList.toggle('ditto-inbox-open', name === 'Inbox');
    markActive();
    if (name === 'Local') void refresh();
    else void selectService(selectedService);
  }
  function mountSidebars() {
    if ((activePanel === 'Local' && location.pathname !== '/code' &&
      !(location.pathname === '/' && document.body.classList.contains('ditto-local-from-chat'))) ||
      (activePanel === 'Inbox' && location.pathname !== '/')) {
      activePanel = null;
      document.body.classList.remove('ditto-local-open', 'ditto-inbox-open', 'ditto-local-from-chat');
    }
    const rail = document.querySelector('nav.v2-studio-rail');
    if (!rail) return;
    const width = Math.round(rail.getBoundingClientRect().right);
    if (width) document.documentElement.style.setProperty('--ditto-desktop-rail-width', `${width}px`);
    const sidebar = document.querySelector('aside.v2-desktop-sidebar');
    const sidebarWidth = Math.round(sidebar?.getBoundingClientRect().right || 320);
    if (sidebarWidth) document.documentElement.style.setProperty('--ditto-desktop-sidebar-width', `${sidebarWidth}px`);
    markActive();
    mountChatSources();
    mountCodeSource();
    if (location.pathname === '/code' && !activePanel && !cloudCodeMode && !defaultCodeOpenPending) {
      defaultCodeOpenPending = true;
      setTimeout(() => {
        defaultCodeOpenPending = false;
        if (location.pathname === '/code' && !activePanel && !cloudCodeMode) openPanel('Local');
      }, 0);
    }
  }
  function mountChatSources() {
    const body = document.querySelector('.v2-studio-section[data-section-id="chats"] > .v2-studio-section-body');
    if (!body || body.querySelector('.ditto-desktop-chat-group')) return;
    const group = element('section', 'v2-studio-chat-group ditto-desktop-chat-group');
    group.setAttribute('aria-label', 'Chats on this Mac');
    const heading = element('div', 'v2-studio-group-label');
    const title = element('div', 'v2-studio-group-name ditto-desktop-group-name');
    title.append(element('span', 'ditto-desktop-local-mark', '⌂'), element('span', 'v2-studio-group-title', 'On this Mac'));
    heading.append(title);
    group.append(heading);
    for (const [service, label, glyph] of [['discord', 'Discord', 'D'], ['telegram', 'Telegram', 'T'], ['imessage', 'iMessage', 'i']]) {
      const row = element('div', 'v2-studio-recent-row');
      const button = element('button', 'v2-studio-recent');
      button.type = 'button';
      button.setAttribute('aria-label', `${label} on this Mac`);
      button.append(element('span', `ditto-desktop-source-mark ${service}`, glyph));
      const copy = element('span');
      copy.append(element('strong', '', label), element('small', '', 'Local account'));
      button.append(copy);
      button.addEventListener('click', () => { selectedService = service; openPanel('Inbox'); });
      row.append(button);
      group.append(row);
    }
    body.insertBefore(group, body.firstElementChild?.nextSibling || null);
  }
  function mountCodeSource() {
    const panel = document.querySelector('.v2-code-panel');
    if (!panel || panel.querySelector('.ditto-desktop-code-group')) return;
    const group = element('section', 'v2-studio-section ditto-desktop-code-group');
    group.setAttribute('aria-label', 'Code execution');
    const heading = element('div', 'v2-studio-section-head');
    heading.append(element('span', 'ditto-desktop-code-heading', 'Execution'));
    group.append(heading);
    for (const [mode, title, description, glyph] of [
      ['local', 'Local · Pi', 'Codex and Claude available', '⌂'],
      ['cloud', 'Cloud · Ditto', 'Ditto cloud tasks and projects', '☁'],
    ]) {
      const row = element('div', 'v2-studio-recent-row');
      const button = element('button', 'v2-studio-recent ditto-desktop-code-mode');
      button.type = 'button';
      button.dataset.dittoCodeMode = mode;
      button.setAttribute('aria-label', mode === 'local' ? 'Run Ditto Code locally' : 'Run Ditto Code in the cloud');
      button.append(element('span', 'ditto-desktop-local-mark', glyph));
      const copy = element('span');
      copy.append(element('strong', '', title), element('small', '', description));
      button.append(copy);
      button.addEventListener('click', () => {
        if (mode === 'local') {
          cloudCodeMode = false;
          $('#dl-provider').value = 'pi';
          $('#dl-provider').dispatchEvent(new Event('change'));
          openPanel('Local');
        } else {
          cloudCodeMode = true;
          activePanel = null;
          document.body.classList.remove('ditto-local-open', 'ditto-local-from-chat');
          markActive();
        }
      });
      row.append(button);
      group.append(row);
    }
    panel.insertBefore(group, panel.firstElementChild?.nextSibling || null);
    markActive();
  }
  let railFrame = 0;
  const observer = new MutationObserver(() => {
    if (railFrame) return;
    railFrame = requestAnimationFrame(() => { railFrame = 0; mountSidebars(); });
  });
  observer.observe(document.querySelector('#root') || document.body, { childList: true, subtree: true });
  document.addEventListener('click', event => {
    const railLink = event.target.closest('nav.v2-studio-rail a');
    if (railLink?.getAttribute('aria-label') === 'Code') {
      cloudCodeMode = false;
      $('#dl-provider').value = 'pi';
      $('#dl-provider').dispatchEvent(new Event('change'));
      openPanel('Local');
      return;
    }
    if (railLink) {
      cloudCodeMode = false;
      activePanel = null;
      document.body.classList.remove('ditto-local-open', 'ditto-inbox-open', 'ditto-local-from-chat');
      markActive();
      return;
    }
    const cloudCode = event.target.closest('.v2-code-panel button');
    if (cloudCode && !cloudCode.closest('.ditto-desktop-code-group') && activePanel === 'Local') {
      cloudCodeMode = true;
      activePanel = null;
      document.body.classList.remove('ditto-local-open', 'ditto-local-from-chat');
      markActive();
    }
  }, true);

  const local = element('main', 'ditto-local-page');
  local.setAttribute('aria-label', 'Local memory and Pi');
  local.innerHTML = `
    <div class="ditto-local-inner">
      <div class="ditto-local-hero"><div class="ditto-local-eyebrow">On this Mac</div>
        <h1>Ditto Code</h1>
        <p>Pi runs coding tasks locally on this Mac, grounded in your private code and agent memory. Choose another engine only when you want to dispatch elsewhere.</p></div>
      <div class="ditto-local-grid">
        <div class="ditto-local-stat"><strong id="dl-code">0</strong><span>Code chunks</span></div>
        <div class="ditto-local-stat"><strong id="dl-codex">0</strong><span>Codex messages</span></div>
        <div class="ditto-local-stat"><strong id="dl-cursor">0</strong><span>Cursor messages</span></div>
        <div class="ditto-local-stat"><strong id="dl-memories">0</strong><span>Ditto memories</span></div>
      </div>
      <section class="ditto-local-card"><div class="ditto-local-row between"><div><h2>Local sources</h2><p>Scans selected code folders and your Codex and Cursor histories.</p></div>
        <div class="ditto-local-row"><button id="dl-scan" class="primary">Scan this Mac</button><button id="dl-add-root">Add code folder</button><button id="dl-export">Prepare Ditto import</button></div></div>
        <div id="dl-progress" class="ditto-local-status" role="status"></div><div id="dl-roots" class="ditto-local-list"></div></section>
      <section class="ditto-local-card"><h2>Search local memory</h2><p>Find relevant code and agent work before you ask Pi.</p>
        <form id="dl-search-form" class="ditto-local-form"><input id="dl-query" type="search" placeholder="Search code, Codex, and Cursor" aria-label="Search local memory"><button class="primary">Search</button></form>
        <div id="dl-results" class="ditto-local-list"></div></section>
      <section class="ditto-local-card"><div class="ditto-local-row between"><div><h2>Ditto Code on this Mac</h2><p id="dl-pi-status">Checking model…</p></div><button id="dl-pi-login" hidden>Sign in to Pi</button></div>
        <div class="ditto-local-row" style="margin-top:12px"><span class="ditto-local-muted">Working folder: <span id="dl-workspace" class="ditto-local-path"></span></span><button id="dl-choose-workspace">Change folder</button></div>
        <div class="ditto-local-row" style="margin-top:12px"><label for="dl-provider" class="ditto-local-muted">Coding engine</label><select id="dl-provider" aria-label="Coding engine">
          <option value="pi">Ditto Code · Pi (default)</option><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="cursor">Cursor Agent</option><option value="grok">Grok</option>
        </select><button id="dl-provider-login" type="button" hidden>Sign in to provider</button></div>
        <form id="dl-chat-form" style="margin-top:13px"><textarea id="dl-prompt" placeholder="Ask Pi to use your local memory and work on a project…" aria-label="Ask Pi"></textarea>
          <div class="ditto-local-row" style="margin-top:9px"><button id="dl-run" class="primary">Run locally with Pi</button><button id="dl-cancel" type="button" hidden>Stop</button><span id="dl-context" class="ditto-local-muted"></span></div></form>
        <div id="dl-output" class="ditto-local-output" aria-live="polite"></div></section>
      <section class="ditto-local-card"><h2>Recent local executions</h2><p>Saved privately on this Mac.</p><div id="dl-runs" class="ditto-local-list"></div></section>
      <section class="ditto-local-card"><h2>Remote Control</h2><p>Keep a coding session on this Mac available from your signed-in Ditto apps.</p>
        <div class="ditto-local-row" style="margin-top:12px"><label for="dl-remote-provider" class="ditto-local-muted">Host engine</label>
          <select id="dl-remote-provider" aria-label="Remote Control engine"><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="grok">Grok</option></select>
          <button id="dl-remote-start" class="primary">Start Remote Control</button><button id="dl-remote-stop" hidden>Stop</button></div>
        <div id="dl-remote-status" class="ditto-local-status" role="status">Checking this Mac…</div>
        <div class="ditto-local-row" style="margin-top:10px"><button id="dl-remote-refresh">Refresh devices</button></div>
        <div id="dl-remote-devices" class="ditto-local-list"></div></section>
      <section class="ditto-local-card"><h2>Ditto Teleport</h2><p>Preview this project, save a capsule, or continue it in Ditto Cloud. Upload happens only when you choose a push action.</p>
        <div class="ditto-local-row" style="margin-top:12px"><button id="dl-teleport-plan">Preview project</button>
          <button id="dl-teleport-push" class="primary">Save capsule</button><button id="dl-teleport-cloud">Continue in cloud</button>
          <button id="dl-teleport-list">Refresh capsules</button></div>
        <div id="dl-teleport-status" class="ditto-local-status" role="status"></div><div id="dl-teleport-results" class="ditto-local-list"></div></section>
    </div>`;
  const executionCard = local.querySelector('#dl-chat-form').closest('.ditto-local-card');
  executionCard.classList.add('ditto-local-execution-card');
  local.querySelector('.ditto-local-hero').after(executionCard, local.querySelector('#dl-runs').closest('.ditto-local-card'));
  document.body.append(local);

  let running = false;
  let workspaceReady = false;
  const show = (target, message) => { $(target).textContent = message; };
  const item = (title, subtitle, body) => {
    const card = element('div', 'ditto-local-item');
    card.append(element('strong', '', title), element('small', '', subtitle), element('p', '', body || ''));
    return card;
  };
  function roots(items) {
    const list = $('#dl-roots');
    list.replaceChildren();
    for (const root of items) {
      const row = element('div', 'ditto-local-row');
      const label = element('span', 'ditto-local-muted ditto-local-path', root);
      const remove = element('button', '', 'Remove');
      remove.addEventListener('click', async () => {
        try { roots(await window.ditto.removeRoot(root)); }
        catch (error) { show('#dl-progress', error.message); }
      });
      row.append(label, remove);
      list.append(row);
    }
  }
  async function refresh() {
    try {
      const [status, runs] = await Promise.all([window.ditto.status(), window.ditto.recentRuns()]);
      for (const name of ['code', 'codex', 'cursor', 'memories']) show(`#dl-${name}`, number(status.stats[name]));
      show('#dl-pi-status', status.pi.ready ? `Ready · ${status.pi.model}` : 'Pi needs a model to run.');
      $('#dl-pi-login').hidden = status.pi.ready;
      for (const provider of status.providers) {
        const option = $('#dl-provider').querySelector(`[value="${provider.id}"]`);
        if (option) { option.disabled = !provider.available; option.title = provider.detail; }
        const remoteOption = $('#dl-remote-provider').querySelector(`[value="${provider.id}"]`);
        if (remoteOption) remoteOption.disabled = !provider.available;
      }
      workspaceReady = Boolean(status.workspace);
      show('#dl-workspace', status.workspace || 'Choose a project folder');
      roots(status.roots);
      const list = $('#dl-runs');
      list.replaceChildren();
      for (const run of runs) {
        list.append(item(run.prompt, `${new Date(run.started_at).toLocaleString()} · ${run.provider || 'pi'} · ${run.status} · ${run.workspace}`, run.response || run.error));
      }
      if (!runs.length) list.append(element('p', 'ditto-local-muted', 'No local executions yet.'));
    } catch (error) { show('#dl-progress', `Could not load local memory: ${error.message}`); }
  }
  $('#dl-scan').addEventListener('click', async () => {
    const button = $('#dl-scan'); button.disabled = true; show('#dl-progress', 'Scanning this Mac…');
    try { await window.ditto.scan(); await refresh(); show('#dl-progress', 'Scan complete. Local memory is ready.'); }
    catch (error) { show('#dl-progress', error.message); }
    finally { button.disabled = false; }
  });
  $('#dl-add-root').addEventListener('click', async () => {
    try { const result = await window.ditto.chooseRoot(); if (result) roots(result); }
    catch (error) { show('#dl-progress', error.message); }
  });
  $('#dl-export').addEventListener('click', async () => {
    const button = $('#dl-export'); button.disabled = true;
    try { const result = await window.ditto.exportBundle(); show('#dl-progress', `${number(result.records)} items prepared. Finder opened the import folder.`); }
    catch (error) { show('#dl-progress', error.message); }
    finally { button.disabled = false; }
  });
  $('#dl-search-form').addEventListener('submit', async event => {
    event.preventDefault();
    const query = $('#dl-query').value.trim(); if (!query) return;
    const list = $('#dl-results'); list.textContent = 'Searching…';
    try {
      const results = await window.ditto.search(query);
      list.replaceChildren();
      for (const memory of results.memories) {
        const prompt = memory.prompt?.trim();
        const answer = memory.response?.trim();
        list.append(item(prompt?.slice(0, 160) || memory.summary || 'Ditto memory',
          `${memory.source || 'Memory'} · ${memory.sourceContext || 'Local trajectory'}`,
          answer?.slice(0, 500) || memory.summary || ''));
      }
      for (const match of results.matches) list.append(item(match.title || 'Source', `${match.source} · ${match.path}`, match.excerpt || ''));
      if (!list.children.length) list.append(element('p', 'ditto-local-muted', 'No matching local memory.'));
    } catch (error) { list.textContent = error.message; }
  });
  $('#dl-choose-workspace').addEventListener('click', async () => {
    try { const folder = await window.ditto.chooseWorkspace(); if (folder) { workspaceReady = true; show('#dl-workspace', folder); } }
    catch (error) { show('#dl-pi-status', error.message); }
  });
  $('#dl-pi-login').addEventListener('click', async () => {
    try { await window.ditto.piLogin(); show('#dl-pi-status', 'Pi sign-in opened in Terminal.'); }
    catch (error) { show('#dl-pi-status', error.message); }
  });
  $('#dl-provider').addEventListener('change', () => {
    const provider = $('#dl-provider').value;
    $('#dl-provider-login').hidden = provider === 'pi';
    if (provider !== 'pi') {
      const label = $('#dl-provider').selectedOptions[0]?.textContent || provider;
      $('#dl-provider-login').textContent = `Sign in to ${label}`;
      $('#dl-run').textContent = `Dispatch locally to ${label}`;
      show('#dl-context', `${label} runs through its installed local CLI. Sign in here if needed.`);
    } else {
      $('#dl-run').textContent = 'Run locally with Pi';
      show('#dl-context', 'Pi runs locally with your selected model.');
    }
  });
  $('#dl-provider-login').addEventListener('click', async () => {
    try { await window.ditto.providerLogin($('#dl-provider').value); show('#dl-context', 'Provider sign-in opened in Terminal.'); }
    catch (error) { show('#dl-context', error.message); }
  });
  $('#dl-chat-form').addEventListener('submit', async event => {
    event.preventDefault(); if (running) return;
    const prompt = $('#dl-prompt').value.trim(); if (!prompt) return;
    if (!workspaceReady) {
      try {
        const folder = await window.ditto.chooseWorkspace();
        if (!folder) { show('#dl-context', 'Choose a project folder to run local code.'); return; }
        workspaceReady = true;
        show('#dl-workspace', folder);
      } catch (error) { show('#dl-context', error.message); return; }
    }
    running = true; $('#dl-run').disabled = true; $('#dl-cancel').hidden = false;
    const provider = $('#dl-provider').value;
    show('#dl-output', ''); show('#dl-context', `Starting ${provider === 'pi' ? 'Pi' : $('#dl-provider').selectedOptions[0]?.textContent || provider} on this Mac…`);
    try {
      if (provider === 'pi') await window.ditto.chat(prompt);
      else await window.ditto.runProvider(provider, prompt);
      $('#dl-prompt').value = '';
    }
    catch (error) { show('#dl-context', error.message); }
    finally { running = false; $('#dl-run').disabled = false; $('#dl-cancel').hidden = true; void refresh(); }
  });
  $('#dl-cancel').addEventListener('click', () => { void window.ditto.cancelChat(); });
  const remoteStatus = status => {
    show('#dl-remote-status', status.detail || (status.running ? 'Connected to Ditto.' : 'Remote Control is off.'));
    $('#dl-remote-start').hidden = Boolean(status.running);
    $('#dl-remote-stop').hidden = !status.running;
    $('#dl-remote-provider').disabled = Boolean(status.running);
  };
  void window.ditto.remoteStatus().then(remoteStatus).catch(error => show('#dl-remote-status', error.message));
  window.ditto.onRemoteStatus(remoteStatus);
  $('#dl-remote-start').addEventListener('click', async () => {
    const button = $('#dl-remote-start'); button.disabled = true;
    try { remoteStatus(await window.ditto.remoteStart($('#dl-remote-provider').value)); }
    catch (error) { show('#dl-remote-status', error.message); }
    finally { button.disabled = false; }
  });
  $('#dl-remote-stop').addEventListener('click', async () => {
    try { remoteStatus(await window.ditto.remoteStop()); }
    catch (error) { show('#dl-remote-status', error.message); }
  });
  $('#dl-remote-refresh').addEventListener('click', async () => {
    const button = $('#dl-remote-refresh'); button.disabled = true;
    try {
      const hosts = await window.ditto.remoteHosts();
      const list = $('#dl-remote-devices'); list.replaceChildren();
      for (const host of hosts) list.append(item(host.name || 'Ditto device',
        `${host.online ? 'Online' : 'Offline'} · ${host.kind || 'host'} · ${host.platform || 'Mac'}`,
        `${number(host.sessions)} coding sessions`));
      if (!hosts.length) list.append(element('p', 'ditto-local-muted', 'No linked devices yet.'));
    } catch (error) { show('#dl-remote-status', error.message); }
    finally { button.disabled = false; }
  });
  const teleportStatus = message => show('#dl-teleport-status', message);
  const teleportBusy = async (button, action) => {
    button.disabled = true;
    try { await action(); }
    catch (error) { teleportStatus(error.message); }
    finally { button.disabled = false; }
  };
  $('#dl-teleport-plan').addEventListener('click', () => teleportBusy($('#dl-teleport-plan'), async () => {
    teleportStatus('Inspecting this project…');
    const plan = await window.ditto.teleportPlan();
    const projects = plan.repos?.flatMap(repo => repo.projects || []) || [];
    const list = $('#dl-teleport-results'); list.replaceChildren();
    list.append(item(`${number(plan.repos?.length)} repositories · ${number(projects.length)} projects`,
      plan.root || 'Selected project', projects.map(project => `${project.relPath}: ${(project.labels || []).join(', ')}`).join('\n') || 'Ready to save.'));
    teleportStatus('Preview complete. Nothing was uploaded.');
  }));
  const push = (button, cloud) => teleportBusy(button, async () => {
    teleportStatus(cloud ? 'Sending this project to Ditto Cloud…' : 'Saving this project as a Ditto capsule…');
    const result = await window.ditto.teleportPush(cloud);
    teleportStatus(cloud ? 'Cloud session started. Find it in Code.' : `Capsule saved: ${result.name || result.capsuleId || 'project'}.`);
    void listCapsules();
  });
  $('#dl-teleport-push').addEventListener('click', () => push($('#dl-teleport-push'), false));
  $('#dl-teleport-cloud').addEventListener('click', () => push($('#dl-teleport-cloud'), true));
  async function listCapsules() {
    const result = await window.ditto.teleportList();
    const list = $('#dl-teleport-results'); list.replaceChildren();
    for (const capsule of result.capsules || []) list.append(item(capsule.name,
      `Generation ${capsule.headGeneration || 0} · ${capsule.status || 'active'}`, capsule.id));
    if (!list.children.length) list.append(element('p', 'ditto-local-muted', 'No capsules yet.'));
  }
  $('#dl-teleport-list').addEventListener('click', () => teleportBusy($('#dl-teleport-list'), async () => {
    await listCapsules(); teleportStatus('Capsules refreshed.');
  }));
  window.ditto.onTeleportProgress(progress => teleportStatus(progress.trim().slice(-250)));
  window.ditto.onProgress(message => { show('#dl-progress', message); });
  window.ditto.onScanFinished(() => { if (activePanel === 'Local') void refresh(); });
  window.ditto.onChatEvent(event => {
    if (event.type === 'start') show('#dl-context', `${event.memoryCount} local sources`);
    if (event.type === 'text') { const box = $('#dl-output'); box.textContent += event.text; box.scrollTop = box.scrollHeight; }
    if (event.type === 'tool') show('#dl-context', `Pi used ${event.name}`);
    if (event.type === 'error') show('#dl-context', event.message);
    if (event.type === 'done') show('#dl-context', 'Complete');
  });

  const inbox = element('section', 'ditto-inbox-page');
  inbox.setAttribute('aria-label', 'Local chat inbox');
  inbox.innerHTML = `
    <aside class="ditto-inbox-sidebar">
      <div class="ditto-local-eyebrow">Private on this Mac</div><h1>Local chats</h1>
      <p>Local Discord, Telegram, and iMessage conversations.</p>
      <div class="ditto-inbox-service-list" role="tablist" aria-label="Local chat sources">
        <button type="button" data-service="discord">Discord</button>
        <button type="button" data-service="telegram">Telegram</button>
        <button type="button" data-service="imessage">iMessage</button>
      </div>
      <div id="di-status" class="ditto-inbox-status" role="status"></div>
      <div class="ditto-local-row"><button id="di-connect" class="primary" hidden>Connect on this Mac</button><button id="di-disconnect" hidden>Disconnect</button></div>
      <img id="di-qr" class="ditto-inbox-qr" alt="Scan with your signed-in phone" hidden>
      <input id="di-filter" type="search" placeholder="Find a conversation" aria-label="Find a local conversation">
      <div id="di-conversations" class="ditto-inbox-list"></div>
    </aside>
    <div class="ditto-inbox-main">
      <div class="ditto-inbox-head"><div><h2 id="di-title">Choose a conversation</h2><p id="di-subtitle">Messages stay on this Mac until you use them in a task.</p></div>
        <button id="di-packet" type="button" hidden>Use in Ditto Code →</button></div>
      <div id="di-messages" class="ditto-inbox-messages"><p>Choose a chat to read it here.</p></div>
      <form id="di-compose" class="ditto-inbox-compose" hidden><textarea id="di-draft" placeholder="Message as yourself…" aria-label="Reply as yourself"></textarea>
        <div class="ditto-inbox-compose-row"><button class="primary" id="di-send" type="submit">Send as me</button><span id="di-send-status">Only sends when you click.</span></div></form>
    </div>`;
  document.body.append(inbox);
  let selectedService = 'discord';
  let selectedConversation = null;
  let conversationRows = [];
  let displayedConversations = 100;
  let loginPoll = null;
  const sourceName = service => ({ discord: 'Discord', telegram: 'Telegram', imessage: 'iMessage' })[service];
  function renderConversations() {
    const list = $('#di-conversations'); list.replaceChildren();
    const query = $('#di-filter').value.trim().toLowerCase();
    const filtered = conversationRows.filter(row => `${row.title || ''} ${row.guildName || ''}`.toLowerCase().includes(query));
    for (const row of filtered.slice(0, displayedConversations)) {
      const button = element('button'); button.type = 'button';
      button.classList.toggle('active', selectedConversation?.id === row.id);
      button.append(element('strong', '', row.title || 'Untitled chat'),
        element('small', '', [row.guildName, row.kind].filter(Boolean).join(' · ') || sourceName(selectedService)));
      button.addEventListener('click', () => { void openConversation(row); });
      list.append(button);
    }
    if (filtered.length > displayedConversations) {
      const more = element('button', '', `Show ${Math.min(100, filtered.length - displayedConversations)} more`);
      more.addEventListener('click', () => { displayedConversations += 100; renderConversations(); });
      list.append(more);
    }
    if (!filtered.length) list.append(element('p', '', query ? 'No matching conversations.' : 'No local conversations yet.'));
  }
  async function loadConversations(service) {
    show('#di-status', `Loading ${sourceName(service)} conversations…`);
    try {
      const rows = await window.ditto.channelConversations(service);
      if (selectedService !== service) return;
      conversationRows = rows;
      displayedConversations = 100;
      renderConversations();
      show('#di-status', `${number(rows.length)} conversations on this Mac`);
    } catch (error) { show('#di-status', error.message); }
  }
  async function selectService(service) {
    if (loginPoll) { clearTimeout(loginPoll); loginPoll = null; }
    selectedService = service;
    selectedConversation = null;
    conversationRows = [];
    $('#di-filter').value = '';
    $('#di-conversations').replaceChildren();
    $('#di-messages').replaceChildren(element('p', '', 'Choose a chat to read it here.'));
    $('#di-compose').hidden = true;
    $('#di-packet').hidden = true;
    $('#di-qr').hidden = true;
    show('#di-title', `${sourceName(service)} on this Mac`);
    show('#di-status', 'Checking connection…');
    for (const button of inbox.querySelectorAll('[data-service]')) button.classList.toggle('active', button.dataset.service === service);
    try {
      const status = await window.ditto.channelStatus(service);
      if (selectedService !== service) return;
      show('#di-status', status.detail || (status.connected ? 'Connected' : 'Not connected'));
      $('#di-connect').hidden = service === 'imessage' || status.connected || status.restoring;
      $('#di-disconnect').hidden = service === 'imessage' || !status.connected;
      if (status.connected) void loadConversations(service);
      else if (status.restoring) loginPoll = setTimeout(() => { void selectService(service); }, 3500);
    } catch (error) { show('#di-status', error.message); }
  }
  async function openConversation(row) {
    selectedConversation = row;
    renderConversations();
    show('#di-title', row.title || 'Conversation');
    show('#di-subtitle', [sourceName(selectedService), row.guildName || row.kind].filter(Boolean).join(' · '));
    $('#di-packet').hidden = false;
    $('#di-compose').hidden = selectedService === 'imessage' && (row.kind !== 'direct' || !row.handle);
    const list = $('#di-messages'); list.replaceChildren(element('p', '', 'Loading messages…'));
    const currentService = selectedService;
    try {
      const messages = await window.ditto.channelMessages(currentService, row.id, 80);
      if (selectedConversation?.id !== row.id || selectedService !== currentService) return;
      list.replaceChildren();
      for (const message of messages) {
        const card = element('article', `ditto-inbox-message${message.author?.isSelf ? ' self' : ''}`);
        const name = element('strong', '', message.author?.displayName || 'Unknown');
        const stamp = element('small', '', message.timestamp ? new Date(message.timestamp).toLocaleString() : '');
        name.append(stamp);
        card.append(name, element('p', '', message.content || ''));
        if (message.attachments?.length) card.append(element('small', '', `${message.attachments.length} attachment${message.attachments.length === 1 ? '' : 's'}`));
        list.append(card);
      }
      if (!messages.length) list.append(element('p', '', 'No messages available in this conversation.'));
      list.scrollTop = list.scrollHeight;
    } catch (error) { list.replaceChildren(element('p', '', error.message)); }
  }
  for (const button of inbox.querySelectorAll('[data-service]')) button.addEventListener('click', () => { void selectService(button.dataset.service); });
  $('#di-filter').addEventListener('input', renderConversations);
  $('#di-connect').addEventListener('click', async () => {
    const service = selectedService;
    $('#di-connect').disabled = true;
    try {
      const result = await window.ditto.channelLogin(service);
      if (selectedService !== service) return;
      if (result.connected) { await selectService(service); return; }
      if (result.qrDataUrl) { $('#di-qr').src = result.qrDataUrl; $('#di-qr').hidden = false; }
      show('#di-status', `Scan this QR with your signed-in ${sourceName(service)} phone.`);
      let attempts = 0;
      const poll = async () => {
        if (selectedService !== service || activePanel !== 'Inbox' || attempts++ >= 24) return;
        try {
          const status = await window.ditto.channelStatus(service);
          if (status.connected) { await selectService(service); return; }
          if (status.detail) show('#di-status', status.detail);
        } catch (error) { show('#di-status', error.message); }
        loginPoll = setTimeout(poll, 5000);
      };
      loginPoll = setTimeout(poll, 5000);
    } catch (error) { show('#di-status', error.message); }
    finally { $('#di-connect').disabled = false; }
  });
  $('#di-disconnect').addEventListener('click', async () => {
    try { await window.ditto.channelLogout(selectedService); await selectService(selectedService); }
    catch (error) { show('#di-status', error.message); }
  });
  $('#di-compose').addEventListener('submit', async event => {
    event.preventDefault();
    if (!selectedConversation) return;
    const content = $('#di-draft').value.trim(); if (!content) return;
    $('#di-send').disabled = true; show('#di-send-status', 'Sending…');
    try {
      await window.ditto.channelSend(selectedService, selectedConversation.id, content, selectedConversation.handle);
      $('#di-draft').value = '';
      show('#di-send-status', 'Sent as you.');
      await openConversation(selectedConversation);
    } catch (error) { show('#di-send-status', error.message); }
    finally { $('#di-send').disabled = false; }
  });
  $('#di-packet').addEventListener('click', async () => {
    if (!selectedConversation) return;
    const button = $('#di-packet'); button.disabled = true;
    try {
      const packet = await window.ditto.createPacket(selectedService, selectedConversation.id);
      cloudCodeMode = false;
      $('#dl-provider').value = 'pi';
      $('#dl-provider').dispatchEvent(new Event('change'));
      activePanel = 'Local';
      document.body.classList.remove('ditto-inbox-open');
      document.body.classList.add('ditto-local-open', 'ditto-local-from-chat');
      markActive();
      await refresh();
      $('#dl-prompt').value = `Use the local knowledge packet at ${packet.path} as context for this task.\n\n`;
      $('#dl-prompt').focus();
      show('#dl-context', `${packet.messageCount} chat messages ready for Ditto Code`);
    } catch (error) { show('#di-status', error.message); }
    finally { button.disabled = false; }
  });
  mountSidebars();
})();
