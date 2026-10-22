(() => {
  if (!window.ditto) return;
  const movableNodes = new Map();
  const $ = (selector) => document.querySelector(selector) || movableNodes.get(selector);
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let computerEnabled = false;
  const computerControls = element("div", "ditto-computer-controls");
  computerControls.setAttribute("role", "group");
  computerControls.setAttribute("aria-label", "Computer Use controls");
  const computerStatus = element("span", "ditto-computer-status");
  computerStatus.setAttribute("role", "status");
  const computerStopButton = element("button", "v2-studio-rail-button ditto-computer-stop");
  computerStopButton.type = "button";
  computerStopButton.hidden = true;
  computerStopButton.title = "Stop computer use";
  computerStopButton.setAttribute("aria-label", "Stop computer use");
  const stopIcon = element("span", "ditto-computer-stop-icon");
  stopIcon.setAttribute("aria-hidden", "true");
  computerStopButton.append(stopIcon);
  computerStopButton.addEventListener("click", async () => {
    computerStopButton.disabled = true;
    try {
      await window.ditto.computerEnable(false);
      updateComputerControls(false);
    } finally {
      computerStopButton.disabled = false;
    }
  });
  function updateComputerControls(enabled) {
    computerEnabled = enabled;
    computerStopButton.hidden = !enabled;
    const control = computerControls.querySelector("[data-ditto-computer]");
    if (!control) return;
    const label = enabled ? "Computer Use is on — Open setup" : "Computer Use setup";
    control.dataset.enabled = String(enabled);
    control.title = label;
    control.setAttribute("aria-label", label);
    const status = enabled ? "Computer Use is on" : "Computer Use is off";
    if (computerStatus.textContent !== status) computerStatus.textContent = status;
  }
  const number = (value) => Number(value || 0).toLocaleString();
  const desktopError = (error) =>
    String(error.message || error).replace(
      /^Error invoking remote method '[^']+': (?:Error: )?/,
      "",
    );
  function createDesktopAccountLink(bridge, render, changed) {
    let generation = 0;
    let timer;
    let linked = false;
    let busy = false;
    const update = (message) => render({ linked, busy, message });
    const idle = () =>
      linked ? "Desktop services are connected to Ditto." : "Desktop services are not connected.";
    const refresh = async () => {
      const owner = generation;
      const status = await bridge.status();
      if (owner !== generation || busy) return;
      linked = status.accountLinked;
      update(idle());
    };
    const start = async () => {
      if (busy || linked) return;
      const owner = ++generation;
      busy = true;
      update("Opening Ditto sign-in in your browser…");
      try {
        const request = await bridge.linkStart();
        if (owner !== generation) return;
        let interval = Math.max(1, Number(request.intervalSeconds) || 5);
        update(`Approve desktop services in your browser. Verification code: ${request.userCode}`);
        const poll = async () => {
          try {
            const result = await bridge.linkPoll();
            if (owner !== generation) return;
            if (result.kind === "pending" || result.kind === "slow-down") {
              if (result.kind === "slow-down") interval += 5;
              timer = setTimeout(poll, interval * 1000);
              return;
            }
            busy = false;
            linked = result.kind === "linked";
            update(
              linked
                ? idle()
                : result.kind === "denied"
                  ? "Connection declined. You can try again."
                  : "Sign-in expired. Please try again.",
            );
            if (linked) changed();
          } catch (error) {
            if (owner !== generation) return;
            busy = false;
            update(desktopError(error));
          }
        };
        timer = setTimeout(poll, interval * 1000);
      } catch (error) {
        if (owner !== generation) return;
        busy = false;
        update(desktopError(error));
      }
    };
    const cancel = async () => {
      ++generation;
      clearTimeout(timer);
      // Invalidate the native request before allowing another attempt.
      let message = "Sign-in cancelled. Desktop services are not connected.";
      try {
        await bridge.linkCancel();
      } catch (error) {
        message = desktopError(error);
      } finally {
        busy = false;
        update(message);
      }
    };
    const disconnect = async () => {
      if (busy || !linked) return;
      ++generation;
      busy = true;
      update("Disconnecting desktop services…");
      try {
        await bridge.signOut();
        linked = false;
        changed();
      } catch (error) {
        busy = false;
        update(desktopError(error));
        return;
      }
      busy = false;
      update(idle());
    };
    return { refresh, start, cancel, disconnect };
  }
  let activePanel = null;
  let cloudCodeMode = false;
  let defaultCodeOpenPending = false;
  function markActive() {
    const target = ["Local", "Browser"].includes(activePanel)
      ? "Code"
      : location.pathname.startsWith("/code")
        ? "Code"
        : location.pathname === "/"
          ? "Chats"
          : null;
    if (!target) return;
    for (const button of document.querySelectorAll("nav.v2-studio-rail a.v2-sidebar-nav-button")) {
      const selected = button.getAttribute("aria-label") === target;
      button.classList.toggle("is-selected", selected);
      if (selected) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    for (const button of document.querySelectorAll("[data-ditto-code-mode]")) {
      button.classList.toggle(
        "is-selected",
        button.dataset.dittoCodeMode ===
          (activePanel === "Local" ? "local" : activePanel === "Browser" ? "browser" : "cloud"),
      );
    }
  }
  function openPanel(name) {
    activePanel = name;
    desktopMode(name === "Local");
    document.body.classList.remove("ditto-local-from-chat");
    document.body.classList.toggle("ditto-local-open", name === "Local");
    document.body.classList.toggle("ditto-browser-open", name === "Browser");
    if (name !== "Browser" && codeTool !== "browser") void window.ditto.browserHide();
    markActive();
    if (name === "Local") void refresh();
    else if (name === "Browser") void showBrowser();
  }
  function mountSidebars() {
    if (
      (activePanel === "Local" &&
        location.pathname !== "/code" &&
        !(
          location.pathname === "/" && document.body.classList.contains("ditto-local-from-chat")
        )) ||
      (activePanel === "Browser" && location.pathname !== "/code")
    ) {
      activePanel = null;
      desktopMode(false);
      document.body.classList.remove(
        "ditto-local-open",
        "ditto-browser-open",
        "ditto-local-from-chat",
      );
      desktopMode(false);
      void window.ditto.browserHide();
    }
    const rail = document.querySelector("nav.v2-studio-rail");
    if (!rail) return;
    const width = Math.round(rail.getBoundingClientRect().right);
    if (width)
      document.documentElement.style.setProperty("--ditto-desktop-rail-width", `${width}px`);
    const sidebar = document.querySelector("aside.v2-desktop-sidebar");
    const sidebarWidth = Math.round(sidebar?.getBoundingClientRect().right || 320);
    if (sidebarWidth)
      document.documentElement.style.setProperty(
        "--ditto-desktop-sidebar-width",
        `${sidebarWidth}px`,
      );
    if (!rail.querySelector("[data-ditto-computer]")) {
      const control = element("button", "v2-studio-rail-button");
      control.type = "button";
      control.dataset.dittoComputer = "true";
      control.setAttribute("aria-label", "Computer Use setup");
      control.title = "Computer Use setup";
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      for (const [name, value] of Object.entries({
        width: "24",
        height: "24",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "1.6",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "aria-hidden": "true",
      }))
        icon.setAttribute(name, value);
      const screen = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      for (const [name, value] of Object.entries({
        x: "3",
        y: "3",
        width: "18",
        height: "14",
        rx: "2",
      }))
        screen.setAttribute(name, value);
      const stand = document.createElementNS("http://www.w3.org/2000/svg", "path");
      stand.setAttribute("d", "M12 17v4M8 21h8");
      icon.append(screen, stand);
      control.append(icon);
      control.addEventListener("click", () => {
        void window.ditto.computerSettings();
      });
      computerControls.replaceChildren(control, computerStatus, computerStopButton);
      rail.insertBefore(computerControls, rail.querySelector(".v2-studio-rail-spacer"));
      updateComputerControls(computerEnabled);
    }
    markActive();
    mountCodeSource();
    mountLocalCode();
    mountCodeTools();
    syncCodeTools();
    if (
      location.pathname === "/code" &&
      !activePanel &&
      !cloudCodeMode &&
      !defaultCodeOpenPending
    ) {
      defaultCodeOpenPending = true;
      setTimeout(() => {
        defaultCodeOpenPending = false;
        if (location.pathname === "/code" && !activePanel && !cloudCodeMode) openPanel("Local");
      }, 0);
    }
  }
  function mountCodeSource() {
    const panel = document.querySelector(".v2-code-panel");
    if (!panel || panel.querySelector(".ditto-desktop-code-group")) return;
    const group = element("section", "ditto-desktop-code-group");
    group.setAttribute("aria-label", "Code conversations");
    const fresh = element("button", "v2-studio-create ditto-code-new", "＋  New chat");
    fresh.type = "button";
    fresh.addEventListener("click", () => {
      if (running) return;
      newLocalTask();
      cloudCodeMode = false;
      openPanel("Local");
    });
    const search = element("input", "ditto-code-search");
    search.type = "search";
    search.placeholder = "Search chats";
    search.value = codeSearch;
    search.setAttribute("aria-label", "Search Code chats");
    search.addEventListener("input", () => {
      codeSearch = search.value;
      renderCodeHistory();
    });
    const filters = element("div", "ditto-code-filters");
    filters.setAttribute("aria-label", "Code chat views");
    for (const [archived, text] of [
      [false, "Chats"],
      [true, "Archived"],
    ]) {
      const button = element("button", "", text);
      button.type = "button";
      button.dataset.archived = String(archived);
      button.setAttribute("aria-pressed", String(codeArchived === archived));
      button.addEventListener("click", () => {
        codeArchived = archived;
        for (const item of filters.children)
          item.setAttribute("aria-pressed", String(item === button));
        renderCodeHistory();
      });
      filters.append(button);
    }
    const history = element("div", "ditto-desktop-local-history");
    history.setAttribute("aria-label", "Code chats");
    const footer = element("div", "ditto-code-sidebar-footer");
    for (const [mode, text] of [
      ["local", "On this Mac"],
      ["cloud", "Cloud tasks"],
    ]) {
      const button = element("button", "ditto-desktop-code-mode", text);
      button.type = "button";
      button.dataset.dittoCodeMode = mode;
      button.addEventListener("click", () => {
        if (mode === "local") {
          cloudCodeMode = false;
          openPanel("Local");
        } else {
          cloudCodeMode = true;
          activePanel = null;
          desktopMode(false);
          document.body.classList.remove("ditto-local-open", "ditto-desktop-settings");
          syncCodeTools();
          markActive();
        }
      });
      footer.append(button);
    }
    const settings = element("button", "ditto-code-settings", "Desktop settings");
    settings.type = "button";
    settings.addEventListener("click", () => {
      openPanel("Local");
      document.body.classList.add("ditto-desktop-settings");
      syncCodeTools();
    });
    footer.append(settings);
    group.append(fresh, search, filters, history, footer);
    panel.prepend(group);
    renderCodeHistory();
    markActive();
  }
  let railFrame = 0;
  const observer = new MutationObserver(() => {
    if (railFrame) return;
    railFrame = requestAnimationFrame(() => {
      railFrame = 0;
      mountSidebars();
    });
  });
  observer.observe(document.querySelector("#root") || document.body, {
    childList: true,
    subtree: true,
  });
  document.addEventListener(
    "click",
    (event) => {
      const railLink = event.target.closest("nav.v2-studio-rail a");
      if (railLink?.getAttribute("aria-label") === "Code") {
        cloudCodeMode = false;
        openPanel("Local");
        return;
      }
      if (railLink) {
        cloudCodeMode = false;
        activePanel = null;
        desktopMode(false);
        document.body.classList.remove(
          "ditto-local-open",
          "ditto-browser-open",
          "ditto-local-from-chat",
        );
        void window.ditto.browserHide();
        markActive();
        return;
      }
      const cloudCode = event.target.closest(".v2-code-panel button");
      if (cloudCode && !cloudCode.closest(".ditto-desktop-code-group") && activePanel === "Local") {
        cloudCodeMode = true;
        activePanel = null;
        desktopMode(false);
        document.body.classList.remove("ditto-local-open", "ditto-local-from-chat");
        markActive();
      }
    },
    true,
  );

  const local = element("main", "ditto-local-page");
  local.setAttribute("aria-label", "Desktop settings");
  local.innerHTML = `
    <div class="ditto-local-inner">
      <div class="ditto-local-hero"><div class="ditto-local-eyebrow">On this Mac</div>
        <h1>Desktop settings</h1>
        <p>Local memory, permissions, connected devices, and Teleport.</p><button id="dl-back-chat" type="button">Back to Ditto Code</button></div>
      <div class="ditto-local-grid">
        <div class="ditto-local-stat"><strong id="dl-code">0</strong><span>Code chunks</span></div>
        <div class="ditto-local-stat"><strong id="dl-codex">0</strong><span>Codex messages</span></div>
        <div class="ditto-local-stat"><strong id="dl-cursor">0</strong><span>Cursor messages</span></div>
        <div class="ditto-local-stat"><strong id="dl-memories">0</strong><span>Ditto memories</span></div>
      </div>
      <section class="ditto-local-card"><div class="ditto-local-row between"><div><h2>Local sources</h2><p>Scans selected code folders and your Codex and Cursor histories.</p></div>
        <div class="ditto-local-row"><button id="dl-scan" class="primary">Scan this Mac</button><button id="dl-add-root">Add code folder</button><button id="dl-export">Prepare Ditto import</button></div></div>
        <div id="dl-progress" class="ditto-local-status" role="status"></div><div id="dl-roots" class="ditto-local-list"></div></section>
      <section class="ditto-local-card"><h2>Search local memory</h2><p>Find relevant code and agent work before you ask Ditto Code.</p>
        <form id="dl-search-form" class="ditto-local-form"><input id="dl-query" type="search" placeholder="Search code, Codex, and Cursor" aria-label="Search local memory"><button class="primary">Search</button></form>
        <div id="dl-results" class="ditto-local-list"></div></section>
      <section class="ditto-local-card"><div class="ditto-local-row between"><div><h2>Ditto Code on this Mac</h2><p id="dl-pi-status">Checking model…</p></div><button id="dl-pi-login" hidden>Set up Ditto Code model</button></div>
        <div class="ditto-local-row" style="margin-top:12px"><span class="ditto-local-muted">Working folder: <span id="dl-workspace" class="ditto-local-path"></span></span><button id="dl-choose-workspace">Change folder</button></div>
        <div class="ditto-local-row" style="margin-top:12px"><label for="dl-provider" class="ditto-local-muted">Coding engine</label><select id="dl-provider" aria-label="Coding engine">
          <option value="pi">Ditto Code (default)</option><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="cursor">Cursor Agent</option><option value="grok">Grok</option>
        </select><button id="dl-provider-login" type="button" hidden>Sign in to provider</button></div>
        <div class="ditto-local-row ditto-computer-control" style="margin-top:12px"><label><input id="dl-computer-enable" type="checkbox"> Allow computer use in Ditto Desktop</label><span id="dl-computer-status" class="ditto-local-muted"></span><button id="dl-computer-settings">Computer Use setup</button><button id="dl-computer-refresh">Check permission</button></div>
        <form id="dl-chat-form" style="margin-top:13px"><textarea id="dl-prompt" placeholder="Ask Ditto Code to use your local memory and work on a project…" aria-label="Ask Ditto Code"></textarea>
          <div class="ditto-local-row" style="margin-top:9px"><button id="dl-run" class="primary">Run Ditto Code locally</button><button id="dl-cancel" type="button" hidden>Stop</button><span id="dl-context" class="ditto-local-muted"></span></div></form>
        <div id="dl-output" class="ditto-local-output" aria-live="polite"></div></section>
      <section class="ditto-local-card"><h2>Recent local executions</h2><p>Saved privately on this Mac.</p><div id="dl-runs" class="ditto-local-list"></div></section>
      <section class="ditto-local-card"><h2>Ditto account for desktop services</h2><p>Connect this Mac for Teleport, Remote Control, and paired devices. Connecting does not start Remote Control or upload a project.</p>
        <div class="ditto-local-row"><button id="dl-account-connect" class="primary">Connect Ditto account</button><button id="dl-account-cancel" hidden>Cancel sign-in</button><button id="dl-account-disconnect" hidden>Disconnect desktop services</button></div>
        <div id="dl-account-status" class="ditto-local-status" role="status">Checking desktop connection…</div></section>
      <section class="ditto-local-card"><h2>Remote Control</h2><p>Keep a coding session on this Mac available from your signed-in Ditto apps.</p>
        <div class="ditto-local-row" style="margin-top:12px"><label for="dl-remote-provider" class="ditto-local-muted">Host engine</label>
          <select id="dl-remote-provider" aria-label="Remote Control engine"><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="grok">Grok</option></select>
          <label for="dl-endpoint" class="ditto-local-muted">Endpoint</label><select id="dl-endpoint" aria-label="Ditto endpoint"><option value="">Loading…</option></select>
          <button id="dl-remote-start" class="primary">Start Remote Control</button><button id="dl-remote-stop" hidden>Stop</button></div>
        <div id="dl-remote-status" class="ditto-local-status" role="status">Checking this Mac…</div>
        </section>
      <section class="ditto-local-card"><h2>Your Ditto devices</h2><p>Pair your Macs to manage their coding engines. Keep Ditto Desktop open on each Mac.</p>
        <div class="ditto-local-row" style="margin-top:12px"><button id="dl-devices-start" class="primary">Connect this Mac</button><button id="dl-devices-stop" hidden>Disconnect this Mac</button><button id="dl-remote-refresh">Refresh devices</button></div>
        <div id="dl-devices-status" class="ditto-local-status" role="status"></div>
        <div class="ditto-local-row" style="margin-top:12px"><button id="dl-pair-create">Get pairing code</button><input id="dl-pair-code" placeholder="Code from another Mac" aria-label="Code from another Mac" inputmode="numeric" maxlength="6"><button id="dl-pair-claim">Pair Mac</button></div>
        <div id="dl-pair-status" class="ditto-local-status" role="status"></div><div id="dl-remote-devices" class="ditto-local-list"></div></section>
      <section class="ditto-local-card"><div class="ditto-local-row between"><div><h2 id="dl-engines-title">Coding engines on this Mac</h2><p>Updates use each engine’s original installer.</p></div><button id="dl-engines-refresh">Check engines</button><button id="dl-engines-local" hidden>Back to this Mac</button></div>
        <div id="dl-engines-status" class="ditto-local-status" role="status"></div><div id="dl-engines" class="ditto-local-list"></div></section>
      <section class="ditto-local-card"><h2>Ditto Teleport</h2><p>Preview this project, save a capsule, or continue it in Ditto Cloud. Upload happens only when you choose a push action.</p>
        <div class="ditto-local-row" style="margin-top:12px"><label for="dl-cloud-endpoint" class="ditto-local-muted">Cloud endpoint</label><select id="dl-cloud-endpoint" aria-label="Personal Ditto cloud endpoint"><option value="">Loading…</option></select><span class="ditto-local-muted">Personal Ditto endpoint</span></div>
        <div class="ditto-local-row" style="margin-top:12px"><button id="dl-teleport-plan">Preview project</button>
          <button id="dl-teleport-push" class="primary">Save capsule</button><button id="dl-teleport-cloud">Continue in cloud</button>
          <button id="dl-teleport-list">Refresh capsules</button></div>
        <div id="dl-teleport-status" class="ditto-local-status" role="status"></div><div id="dl-teleport-results" class="ditto-local-list"></div></section>
    </div>`;
  const executionCard = local.querySelector("#dl-chat-form").closest(".ditto-local-card");
  executionCard.classList.add("ditto-local-execution-card");
  local
    .querySelector(".ditto-local-hero")
    .after(executionCard, local.querySelector("#dl-runs").closest(".ditto-local-card"));
  document.body.append(local);
  for (const id of ["dl-provider", "dl-cancel"]) movableNodes.set(`#${id}`, $(`#${id}`));

  const browserPage = element("section", "ditto-browser-page");
  browserPage.setAttribute("aria-label", "Ditto local browser");
  browserPage.innerHTML = `<div class="ditto-browser-head"><div><div class="ditto-local-eyebrow">On this Mac</div>
      <h1>Browser</h1><p>Browse with Ditto Code. The page stays in this desktop app.</p></div>
      <div class="ditto-browser-actions"><button id="db-back" title="Back">←</button><button id="db-forward" title="Forward">→</button><button id="db-reload" title="Reload">↻</button></div></div>
    <form id="db-address-form" class="ditto-browser-address"><input id="db-address" type="url" placeholder="https://example.com" aria-label="Web address"><button class="primary">Go</button></form>
    <div id="db-status" class="ditto-local-status" role="status">Enter a web address to open a local browser tab.</div>
    <div id="db-viewport" class="ditto-browser-viewport"></div>
    <div class="ditto-browser-inspect"><button id="db-inspect">Inspect page</button><span id="db-inspect-output"></span></div>`;
  document.body.append(browserPage);
  const browserBounds = () => {
    const rect = browserPage.querySelector("#db-viewport").getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  function codeBrowserAllowed() {
    if (
      !codePaneVisible ||
      codeTool !== "browser" ||
      document.body.classList.contains("ditto-code-resizing")
    )
      return false;
    return ![
      ...document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [aria-modal="true"], .v2-shell-header [data-active="true"]',
      ),
    ].some(
      (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden",
    );
  }
  async function showBrowser() {
    try {
      const state = await window.ditto.browserStatus();
      if (state.url && codeBrowserAllowed()) await window.ditto.browserShow(browserBounds());
      browserState(state);
    } catch (error) {
      browserPage.querySelector("#db-status").textContent = desktopError(error);
    }
  }
  let inspectedBrowserUrl = "";
  function clearBrowserInspection() {
    inspectedBrowserUrl = "";
    browserPage.querySelector("#db-inspect-output").textContent = "";
  }
  function browserState(state) {
    if (inspectedBrowserUrl && inspectedBrowserUrl !== state.url) clearBrowserInspection();
    if (state.url && document.activeElement !== browserPage.querySelector("#db-address"))
      browserPage.querySelector("#db-address").value = state.url;
    browserPage.querySelector("#db-back").disabled = !state.canGoBack;
    browserPage.querySelector("#db-forward").disabled = !state.canGoForward;
    if (state.url) browserPage.querySelector("#db-status").textContent = state.title || state.url;
  }
  new ResizeObserver(() => {
    if (
      (activePanel === "Browser" || (codePaneVisible && codeTool === "browser")) &&
      !document.body.classList.contains("ditto-code-resizing")
    )
      void showBrowser();
  }).observe(browserPage.querySelector("#db-viewport"));
  browserPage.querySelector("#db-address-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    clearBrowserInspection();
    try {
      const state = await window.ditto.browserNavigate(
        browserPage.querySelector("#db-address").value,
      );
      if (codeBrowserAllowed()) await window.ditto.browserShow(browserBounds());
      browserState(state);
    } catch (error) {
      browserPage.querySelector("#db-status").textContent = desktopError(error);
    }
  });
  for (const [id, action] of [
    ["db-back", "browserBack"],
    ["db-forward", "browserForward"],
    ["db-reload", "browserReload"],
  ]) {
    browserPage.querySelector(`#${id}`).addEventListener("click", async () => {
      clearBrowserInspection();
      try {
        browserState(await window.ditto[action]());
      } catch (error) {
        browserPage.querySelector("#db-status").textContent = desktopError(error);
      }
    });
  }
  browserPage.querySelector("#db-inspect").addEventListener("click", async () => {
    try {
      const snapshot = await window.ditto.browserSnapshot();
      inspectedBrowserUrl = snapshot.url;
      browserPage.querySelector("#db-inspect-output").textContent =
        `${number(snapshot.controls.length)} controls · ${snapshot.text.slice(0, 240)}`;
    } catch (error) {
      browserPage.querySelector("#db-inspect-output").textContent = desktopError(error);
    }
  });
  window.ditto.onBrowserState(browserState);
  window.ditto.onBrowserOpen(() => {
    if (location.pathname === "/code") openCodeTool("browser");
  });

  let running = false;
  let workspaceReady = false;
  let localSessionId = crypto.randomUUID();
  let localTurns = [];
  let activeCodeThread = null;
  let codeThreads = [];
  let codeArchived = false;
  let codeSearch = "";
  let localWorkspace = "";
  let defaultLocalWorkspace = "";
  const localChat = element("div", "v2-code-start ditto-desktop-code-chat");
  localChat.setAttribute("aria-label", "Local Ditto Code conversation");
  localChat.innerHTML =
    '<header class="v2-code-start-header"><h1>What can we build?</h1><p>Ask a question, explore an idea, or make something on this Mac.</p></header><div id="dl-transcript" aria-live="polite"></div><div id="dl-chat-status" role="status"></div>';
  const sharedOutput = $("#dl-output");
  sharedOutput.classList.add("ditto-desktop-code-response");
  localChat.querySelector("#dl-transcript").append(sharedOutput);
  const responseSources = new WeakMap();
  let localScrollTarget;
  let followLocalOutput = true;
  let localScrollFrame = 0;
  function scrollLocalCode(force = false) {
    if (force) followLocalOutput = true;
    if (!followLocalOutput || localScrollFrame || activePanel !== "Local") return;
    localScrollFrame = requestAnimationFrame(() => {
      localScrollFrame = 0;
      if (followLocalOutput && activePanel === "Local" && localScrollTarget)
        localScrollTarget.scrollTop = localScrollTarget.scrollHeight;
    });
  }
  function setCodeResponse(target, source) {
    responseSources.set(target, source);
    const render = window.dittoDesktopRenderCodeResponse;
    if (render) {
      try {
        render(target, source);
        return;
      } catch (error) {
        console.error("Local Code rendering failed", error);
      }
    }
    target.textContent = source;
  }
  function clearCodeResponses() {
    for (const target of localChat.querySelectorAll(".ditto-desktop-code-response"))
      window.dittoDesktopRenderCodeResponse?.(target, null);
  }
  window.addEventListener("ditto-desktop-code-renderer-ready", () => {
    for (const target of localChat.querySelectorAll(".ditto-desktop-code-response"))
      setCodeResponse(target, responseSources.get(target) || "");
  });
  function desktopMode(localMode, prompt) {
    document.body.classList.remove("ditto-desktop-settings");
    window.dispatchEvent(
      new CustomEvent("ditto-desktop-execution-mode", {
        detail: { local: localMode, ...(prompt === undefined ? {} : { prompt }) },
      }),
    );
  }
  function mountLocalCode() {
    const provider = $("#dl-provider");
    const engineName = provider.selectedOptions[0]?.textContent || "Ditto Code";
    const description =
      provider.value === "pi"
        ? "Ask a question, explore an idea, or make something on this Mac."
        : `Describe the task. ${engineName} runs through its installed CLI on this Mac.`;
    const subtitle = localChat.querySelector("header p");
    if (subtitle.textContent !== description) subtitle.textContent = description;
    const modeDescription = document.querySelector('[data-ditto-code-mode="local"] small');
    const localDescription =
      provider.value === "pi" ? "Ditto Code on this Mac" : `${engineName} on this Mac`;
    if (modeDescription && modeDescription.textContent !== localDescription)
      modeDescription.textContent = localDescription;
    const main = document.querySelector(".v2-code-surface-main");
    if (main && !main.contains(localChat)) main.append(localChat);
    if (main && main !== localScrollTarget) {
      localScrollTarget = main;
      main.addEventListener(
        "scroll",
        () => {
          followLocalOutput = main.scrollHeight - main.clientHeight - main.scrollTop < 80;
        },
        { passive: true },
      );
    }
    scrollLocalCode();
    const context = document.querySelector(".v2-composer-context-panel");
    if (main && context && !context.querySelector(".ditto-desktop-workspace")) {
      const button = element(
        "button",
        "v2-composer-context-chip ditto-desktop-workspace",
        localWorkspace ? localWorkspace.split("/").at(-1) : "Choose local folder",
      );
      button.type = "button";
      button.setAttribute("aria-label", "Choose local working folder");
      button.addEventListener("click", () => {
        $("#dl-choose-workspace").click();
      });
      context.append(button);
    }
    if (main && context && !context.querySelector("#dl-default-workspace")) {
      const home = element(
        "button",
        "v2-composer-context-chip ditto-desktop-workspace",
        "Use Ditto workspace",
      );
      home.id = "dl-default-workspace";
      home.type = "button";
      home.addEventListener("click", async () => {
        if (running) return;
        try {
          localWorkspace = await window.ditto.defaultWorkspace();
          workspaceReady = true;
          newLocalTask();
          openPanel("Local");
          void refresh();
        } catch {
          show("#dl-context", "Couldn't open the Ditto workspace. Please try again.");
        }
      });
      context.append(home);
    }
    mountCodeTools();
    const fresh = document.querySelector(".ditto-code-new");
    if (fresh) fresh.disabled = running;
    const status = localChat.querySelector("#dl-chat-status");
    const home = $("#dl-default-workspace");
    if (home) {
      home.hidden = Boolean(localWorkspace) && localWorkspace === defaultLocalWorkspace;
      home.disabled = running;
    }
    if (status.textContent !== $("#dl-context").textContent)
      status.textContent = $("#dl-context").textContent;
  }
  let codeTool = null;
  let codePaneWidth = 440;
  try {
    codePaneWidth = Number(localStorage.getItem("ditto.code.paneWidth")) || 440;
  } catch {}
  const codeTools = element("div", "ditto-code-tools");
  codeTools.setAttribute("aria-label", "Code tools");
  const codePane = element("aside", "ditto-code-pane");
  codePane.id = "ditto-code-pane";
  codePane.setAttribute("aria-label", "Code tool pane");
  codePane.hidden = true;
  const paneHead = element("div", "ditto-code-pane-head");
  const paneTabs = element("div", "ditto-code-pane-tabs");
  paneTabs.setAttribute("role", "tablist");
  paneTabs.setAttribute("aria-label", "Code tools");
  const toolSymbols = { terminal: "terminal", browser: "browser", activity: "activity" };
  function codeIcon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.7");
    svg.setAttribute("aria-hidden", "true");
    const paths = {
      terminal: "M4 5h16v14H4z M7 9l3 3-3 3 M13 15h4",
      browser: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c5 5 5 13 0 18-5-5-5-13 0-18",
      activity: "M4 6h16 M4 12h16 M4 18h10",
      close: "M6 6l12 12 M6 18L18 6",
      more: "M5 12h1 M11 12h1 M17 12h1",
    };
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", paths[name]);
    svg.append(path);
    return svg;
  }
  for (const [name, label] of [
    ["terminal", "Terminal"],
    ["browser", "Browser"],
    ["activity", "Activity"],
  ]) {
    const trigger = element("button", "v2-studio-icon-button ditto-code-tool-button");
    trigger.type = "button";
    trigger.title = label;
    trigger.dataset.codeTool = name;
    trigger.setAttribute("aria-label", `Open ${label.toLowerCase()}`);
    trigger.setAttribute("aria-controls", codePane.id);
    trigger.setAttribute("aria-expanded", "false");
    trigger.append(codeIcon(toolSymbols[name]));
    trigger.addEventListener("click", () => openCodeTool(codeTool === name ? null : name));
    codeTools.append(trigger);
    const tab = element("button", "", label);
    tab.type = "button";
    tab.dataset.codeTool = name;
    tab.id = `ditto-code-tab-${name}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", `ditto-code-panel-${name}`);
    tab.addEventListener("click", () => openCodeTool(name));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...paneTabs.children];
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
              tabs.length;
      tabs[next].click();
      tabs[next].focus();
    });
    paneTabs.append(tab);
  }
  const closePane = element("button", "v2-studio-icon-button");
  closePane.type = "button";
  closePane.title = "Close tool pane";
  closePane.setAttribute("aria-label", "Close tool pane");
  closePane.append(codeIcon("close"));
  closePane.addEventListener("click", () => {
    const name = codeTool;
    openCodeTool(null);
    codeTools.querySelector(`[data-code-tool="${name}"]`)?.focus();
  });
  paneHead.append(paneTabs, closePane);
  const paneResize = element("div", "ditto-code-pane-resize");
  paneResize.setAttribute("role", "separator");
  paneResize.tabIndex = 0;
  paneResize.setAttribute("aria-label", "Resize tool pane");
  paneResize.setAttribute("aria-orientation", "vertical");
  let appliedCodePaneWidth = null;
  function resizeCodePane(value) {
    codePaneWidth = Math.round(Math.max(300, Math.min(value, window.innerWidth * 0.6, 900)));
    if (appliedCodePaneWidth !== codePaneWidth) {
      appliedCodePaneWidth = codePaneWidth;
      document.documentElement.style.setProperty("--ditto-code-pane-width", `${codePaneWidth}px`);
      try {
        localStorage.setItem("ditto.code.paneWidth", String(codePaneWidth));
      } catch {}
    }
    paneResize.setAttribute("aria-valuenow", String(codePaneWidth));
    paneResize.setAttribute("aria-valuemin", "300");
    paneResize.setAttribute(
      "aria-valuemax",
      String(Math.round(Math.min(window.innerWidth * 0.6, 900))),
    );
    fitCodeTerminal();
  }
  paneResize.addEventListener("pointerdown", (event) => {
    paneResize.setPointerCapture(event.pointerId);
    document.body.classList.add("ditto-code-resizing");
    void window.ditto.browserHide();
  });
  paneResize.addEventListener("pointermove", (event) => {
    if (paneResize.hasPointerCapture(event.pointerId))
      resizeCodePane(window.innerWidth - event.clientX);
  });
  const endPaneResize = () => {
    document.body.classList.remove("ditto-code-resizing");
    if (codeTool === "browser") void showBrowser();
  };
  paneResize.addEventListener("pointerup", endPaneResize);
  paneResize.addEventListener("lostpointercapture", endPaneResize);
  paneResize.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault();
    resizeCodePane(
      event.key === "Home" ? 440 : codePaneWidth + (event.key === "ArrowLeft" ? 32 : -32),
    );
  });
  const terminalPanel = element("section", "ditto-code-tool-panel ditto-code-terminal-panel");
  const terminalBar = element("div", "ditto-code-terminal-bar");
  const terminalLocation = element("span", "", "Your working folder");
  const restartTerminal = element("button", "", "Restart");
  restartTerminal.type = "button";
  restartTerminal.setAttribute("aria-label", "Restart terminal");
  restartTerminal.addEventListener("click", async () => {
    const key = codeTerminalKey();
    try {
      await window.ditto.terminalClose(key);
      terminals.get(key)?.term.dispose();
      terminals.delete(key);
      await showCodeTerminal();
    } catch {
      terminalLocation.textContent = "Couldn't restart terminal. Try again.";
    }
  });
  const stopTerminal = element("button", "", "Stop");
  stopTerminal.type = "button";
  stopTerminal.setAttribute("aria-label", "Stop terminal");
  stopTerminal.addEventListener("click", () => {
    void window.ditto.terminalClose(codeTerminalKey()).catch(() => {
      terminalLocation.textContent = "Couldn't stop terminal. Try again.";
    });
  });
  terminalBar.append(terminalLocation, restartTerminal, stopTerminal);
  const terminalHost = element("div", "ditto-code-terminal-host");
  terminalPanel.append(terminalBar, terminalHost);
  const activityPanel = element("section", "ditto-code-tool-panel ditto-code-activity-panel");
  activityPanel.append(
    element("h2", "", "Tool activity"),
    element("p", "ditto-code-empty", "Tool calls from the current task will appear here."),
  );
  for (const [name, panel] of [
    ["terminal", terminalPanel],
    ["browser", browserPage],
    ["activity", activityPanel],
  ]) {
    panel.id = `ditto-code-panel-${name}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", `ditto-code-tab-${name}`);
    panel.hidden = true;
  }
  codePane.append(paneResize, paneHead, terminalPanel, browserPage, activityPanel);
  codePane.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !terminalPanel.contains(event.target)) {
      event.stopPropagation();
      closePane.click();
    }
  });
  document.body.append(codePane);
  let browserVisibilityFrame = 0;
  let nativeBrowserAllowed = false;
  // Native WebContentsView layers sit above HTML, so detach them while a dialog
  // or header drawer owns the foreground. Watch portals outside the app root too.
  new MutationObserver(() => {
    if (browserVisibilityFrame) return;
    browserVisibilityFrame = requestAnimationFrame(() => {
      browserVisibilityFrame = 0;
      const allowed = codeBrowserAllowed();
      if (allowed === nativeBrowserAllowed) return;
      nativeBrowserAllowed = allowed;
      if (allowed) void showBrowser();
      else void window.ditto.browserHide();
    });
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "data-active", "aria-modal", "open"],
  });
  const terminals = new Map();
  const activities = new Map();
  let codePaneVisible = false;
  let codePaneLastTool = null;
  let codePaneLastThread = null;
  const codeTerminalKey = () => activeCodeThread?.threadId || `session:${localSessionId}`;
  function mountCodeTools() {
    const header = document.querySelector(".v2-shell-header");
    if (header && !header.contains(codeTools)) {
      header.insertBefore(codeTools, header.querySelector(".v2-header-search-trigger") || null);
      const engine = $("#dl-provider");
      engine.setAttribute("aria-label", "Coding engine");
      const stop = $("#dl-cancel");
      stop.classList.add("ditto-code-task-stop");
      stop.textContent = "Stop task";
      codeTools.prepend(engine, stop);
    }
    const title = document.querySelector(".v2-shell-header .v2-studio-header-title");
    if (activePanel === "Local" && title) {
      const text = activeCodeThread?.title || "New chat";
      if (title.textContent !== text) title.textContent = text;
    }
  }
  function syncCodeTools() {
    const inCode =
      activePanel === "Local" && !document.body.classList.contains("ditto-desktop-settings");
    const visible = inCode && Boolean(codeTool);
    codeTools.hidden = !inCode;
    codePane.hidden = !visible;
    document.body.classList.toggle("ditto-code-tools-open", visible);
    for (const button of codeTools.querySelectorAll("[data-code-tool]"))
      button.setAttribute("aria-expanded", String(visible && button.dataset.codeTool === codeTool));
    for (const tab of paneTabs.children) {
      tab.setAttribute("aria-selected", String(tab.dataset.codeTool === codeTool));
      tab.tabIndex = tab.dataset.codeTool === codeTool ? 0 : -1;
    }
    for (const [name, panel] of [
      ["terminal", terminalPanel],
      ["browser", browserPage],
      ["activity", activityPanel],
    ])
      panel.hidden = !visible || name !== codeTool;
    const header = document.querySelector(".v2-shell-header");
    if (header)
      document.documentElement.style.setProperty(
        "--ditto-code-pane-top",
        `${Math.round(header.getBoundingClientRect().bottom)}px`,
      );
    resizeCodePane(codePaneWidth);
    const thread = codeTerminalKey();
    if (
      visible !== codePaneVisible ||
      codeTool !== codePaneLastTool ||
      thread !== codePaneLastThread
    ) {
      codePaneVisible = visible;
      codePaneLastTool = codeTool;
      codePaneLastThread = thread;
      if (visible && codeTool === "browser") void showBrowser();
      else void window.ditto.browserHide();
      if (visible && codeTool === "terminal") void showCodeTerminal();
      if (visible && codeTool === "activity") renderCodeActivity();
    }
  }
  function openCodeTool(name) {
    codeTool = name;
    if (activePanel !== "Local") {
      cloudCodeMode = false;
      openPanel("Local");
    }
    syncCodeTools();
    if (name === "terminal") void showCodeTerminal();
    if (name === "activity") renderCodeActivity();
    if (name === "browser") browserPage.querySelector("#db-address").focus();
  }
  let terminalFitFrame = 0;
  function fitCodeTerminal() {
    if (terminalFitFrame || !codePaneVisible || codeTool !== "terminal") return;
    terminalFitFrame = requestAnimationFrame(() => {
      terminalFitFrame = 0;
      const current = terminals.get(codeTerminalKey());
      if (!current || current.opening) return;
      current.fit.fit();
      if (
        !current.closed &&
        (current.cols !== current.term.cols || current.rows !== current.term.rows)
      ) {
        current.cols = current.term.cols;
        current.rows = current.term.rows;
        void window.ditto
          .terminalResize(codeTerminalKey(), current.term.cols, current.term.rows)
          .catch(() => {});
      }
    });
  }
  async function showCodeTerminal() {
    if (typeof window.Terminal !== "function" || !window.FitAddon) {
      terminalLocation.textContent = "Restart Ditto Desktop to load the terminal.";
      return;
    }
    const key = codeTerminalKey();
    for (const [id, session] of terminals) session.host.hidden = id !== key;
    let current = terminals.get(key);
    if (!current) {
      const host = element("div", "ditto-code-terminal-instance");
      terminalHost.append(host);
      const term = new window.Terminal({
        fontSize: 12,
        fontFamily: '"SFMono-Regular", Consolas, monospace',
        cursorBlink: false,
        scrollback: 3000,
        screenReaderMode: true,
        theme: { background: "#101115", foreground: "#e3e5eb" },
      });
      const fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(host);
      current = { term, fit, host, opening: true, closed: false };
      terminals.set(key, current);
      term.onData((data) => {
        if (!current.closed)
          void window.ditto.terminalWrite(key, data).catch(() => {
            terminalLocation.textContent = "Terminal disconnected. Restart to reconnect.";
          });
      });
      try {
        fit.fit();
        const state = await window.ditto.terminalOpen(key, term.cols, term.rows);
        current.cwd = state.cwd;
        term.write(state.output);
      } catch {
        current.closed = true;
        term.writeln("\r\nCouldn't start the local terminal. Use Restart to try again.");
      } finally {
        current.opening = false;
      }
    }
    if (key !== codeTerminalKey() || codeTool !== "terminal") return;
    current.host.hidden = false;
    terminalLocation.textContent = current.closed
      ? "Terminal stopped · Restart to reopen"
      : (current.cwd || localWorkspace).split("/").at(-1) || "Ditto workspace";
    fitCodeTerminal();
    current.term.focus();
  }
  window.ditto.onTerminalEvent((event) => {
    const current = terminals.get(event.key);
    if (!current) return;
    if (event.type === "data") current.term.write(event.data);
    if (event.type === "exit") {
      current.closed = true;
      current.term.writeln("\r\n[Terminal stopped]");
      if (event.key === codeTerminalKey())
        terminalLocation.textContent = "Terminal stopped · Restart to reopen";
    }
  });
  new ResizeObserver(fitCodeTerminal).observe(terminalHost);
  window.addEventListener("resize", syncCodeTools);
  function recordCodeActivity(event) {
    if (!["start", "tool", "tool-error", "done", "error", "cancelled"].includes(event.type)) return;
    const key = codeTerminalKey();
    const rows = activities.get(key) || [];
    rows.push({
      name:
        event.type === "tool"
          ? event.name
          : event.type === "tool-error"
            ? `${event.name} failed`
            : {
                start: "Task started",
                done: "Task complete",
                error: "Task failed",
                cancelled: "Task stopped",
              }[event.type],
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    });
    activities.set(key, rows.slice(-100));
    renderCodeActivity();
  }
  function renderCodeActivity() {
    activityPanel.replaceChildren(element("h2", "", "Tool activity"));
    const rows = activities.get(codeTerminalKey()) || [];
    if (!rows.length)
      activityPanel.append(
        element("p", "ditto-code-empty", "Tool calls from the current task will appear here."),
      );
    for (const row of rows) {
      const item = element("div", "ditto-code-activity-row");
      item.append(element("span", "", row.name), element("time", "", row.time));
      activityPanel.append(item);
    }
  }
  async function openCodeConversation(thread) {
    if (running) return;
    try {
      const turns = await window.ditto.openCodeThread(thread.threadId);
      const latest = turns.at(-1);
      activeCodeThread = thread;
      localWorkspace = latest.workspace;
      workspaceReady = true;
      localSessionId = latest.session_id || crypto.randomUUID();
      localTurns = turns.map((turn) => ({ prompt: turn.prompt, provider: turn.provider }));
      $("#dl-provider").value = latest.provider || "pi";
      const transcript = localChat.querySelector("#dl-transcript");
      clearCodeResponses();
      transcript.replaceChildren();
      for (const turn of turns) {
        const response = element("div", "ditto-desktop-code-response");
        transcript.append(element("article", "ditto-desktop-code-question", turn.prompt), response);
        setCodeResponse(response, turn.response || turn.error || "");
      }
      transcript.append(sharedOutput);
      setCodeResponse(sharedOutput, "");
      localChat.classList.add("has-turns");
      cloudCodeMode = false;
      openPanel("Local");
      desktopMode(true, "");
      scrollLocalCode(true);
      renderCodeHistory();
      renderCodeActivity();
      if (codeTool === "terminal") void showCodeTerminal();
      show(
        "#dl-context",
        latest.provider === "pi" && latest.session_id
          ? "Continue this conversation"
          : "Saved execution · Your next message starts a new task",
      );
    } catch {
      show(
        "#dl-context",
        "Couldn't open this chat. Check that its working folder is still available.",
      );
    }
  }
  function renderCodeHistory() {
    const history = document.querySelector(".ditto-desktop-local-history");
    if (!history) return;
    history.replaceChildren();
    const matches = codeThreads.filter(
      (thread) =>
        Boolean(thread.archived) === codeArchived &&
        `${thread.title} ${thread.provider}`.toLowerCase().includes(codeSearch.toLowerCase()),
    );
    for (const [pinned, label] of codeArchived
      ? [[null, "Archived chats"]]
      : [
          [true, "Pinned"],
          [false, "Recent"],
        ]) {
      const threads = matches.filter(
        (thread) => pinned === null || Boolean(thread.pinned) === pinned,
      );
      if (!threads.length) continue;
      history.append(element("h3", "ditto-code-history-heading", label));
      for (const thread of threads) {
        const row = element("div", "v2-studio-recent-row ditto-code-chat-row");
        row.classList.toggle("is-active", activeCodeThread?.threadId === thread.threadId);
        const button = element("button", "v2-studio-recent ditto-code-chat-title", thread.title);
        button.type = "button";
        button.title = thread.title;
        if (activeCodeThread?.threadId === thread.threadId)
          button.setAttribute("aria-current", "true");
        button.addEventListener("click", () => {
          void openCodeConversation(thread);
        });
        const menu = element("details", "ditto-code-chat-menu");
        const toggle = element("summary", "v2-studio-icon-button");
        toggle.title = `Chat actions for ${thread.title}`;
        toggle.setAttribute("aria-label", toggle.title);
        toggle.append(codeIcon("more"));
        menu.addEventListener("toggle", () => {
          if (menu.open)
            menu.classList.toggle(
              "opens-up",
              menu.getBoundingClientRect().bottom + 88 > history.getBoundingClientRect().bottom,
            );
        });
        menu.append(toggle);
        const actions = element("div", "ditto-code-chat-menu-items");
        for (const [field, text] of [
          ["pinned", thread.pinned ? "Unpin chat" : "Pin chat"],
          ["archived", thread.archived ? "Restore chat" : "Archive chat"],
        ]) {
          const action = element("button", "", text);
          action.type = "button";
          action.disabled = running && activeCodeThread?.threadId === thread.threadId;
          action.addEventListener("click", async () => {
            action.disabled = true;
            try {
              codeThreads = await window.ditto.updateCodeThread(thread.threadId, {
                [field]: !thread[field],
              });
              if (
                field === "archived" &&
                !thread.archived &&
                activeCodeThread?.threadId === thread.threadId
              )
                newLocalTask();
              renderCodeHistory();
            } catch {
              show("#dl-context", "Couldn't update this chat. Please try again.");
              action.disabled = false;
            }
          });
          actions.append(action);
        }
        menu.append(actions);
        row.append(button, menu);
        history.append(row);
      }
    }
    if (!matches.length)
      history.append(
        element(
          "p",
          "ditto-code-empty",
          codeSearch
            ? "No matching chats."
            : codeArchived
              ? "No archived chats."
              : "Your Code chats will appear here.",
        ),
      );
  }
  document.addEventListener("click", (event) => {
    for (const menu of document.querySelectorAll(".ditto-code-chat-menu[open]"))
      if (!menu.contains(event.target)) menu.open = false;
  });

  function newLocalTask() {
    if (activeCodeThread || localTurns.length) localSessionId = crypto.randomUUID();
    activeCodeThread = null;
    localTurns = [];
    renderCodeHistory();
    syncCodeTools();
    clearCodeResponses();
    localChat.querySelector("#dl-transcript").replaceChildren(sharedOutput);
    setCodeResponse(sharedOutput, "");
    localChat.classList.remove("has-turns");
    show("#dl-context", `${$("#dl-provider").selectedOptions[0].textContent} · On this Mac`);
    desktopMode(true, "");
    scrollLocalCode(true);
  }
  function addLocalTurn(prompt, provider) {
    const transcript = localChat.querySelector("#dl-transcript");
    const previousResponse = responseSources.get(sharedOutput) || "";
    if (previousResponse) {
      const response = element("div", "ditto-desktop-code-response");
      transcript.append(response);
      setCodeResponse(response, previousResponse);
    }
    const question = element("article", "ditto-desktop-code-question", prompt);
    question.setAttribute("aria-label", "Your task");
    transcript.append(question, sharedOutput);
    setCodeResponse(sharedOutput, "");
    localChat.classList.add("has-turns");
    localTurns.push({ prompt, provider });
    scrollLocalCode(true);
  }
  async function runLocalTask(prompt) {
    const provider = $("#dl-provider").value;
    if (!activeCodeThread)
      activeCodeThread = { threadId: `session:${localSessionId}`, title: prompt };
    running = true;
    syncCodeTools();
    $("#dl-provider").disabled = true;
    if ($("#dl-default-workspace")) $("#dl-default-workspace").disabled = true;
    $("#dl-run").disabled = true;
    $("#dl-cancel").hidden = false;
    addLocalTurn(prompt, provider);
    show("#dl-context", "Working on this Mac…");
    mountLocalCode();
    try {
      if (provider === "pi") await window.ditto.chat(prompt, localSessionId);
      else await window.ditto.runProvider(provider, prompt);
    } catch (error) {
      show("#dl-context", error.message);
    } finally {
      running = false;
      $("#dl-provider").disabled = false;
      if ($("#dl-default-workspace")) $("#dl-default-workspace").disabled = false;
      $("#dl-run").disabled = false;
      $("#dl-cancel").hidden = true;
      mountLocalCode();
      void refresh();
    }
  }
  window.dittoDesktopStartCode = async (input) => {
    if (activePanel !== "Local") return null;
    if (running)
      return {
        status: "blocked",
        reason: "A local task is still running. Stop it or wait for it to finish.",
      };
    if (!workspaceReady) {
      const folder = await window.ditto.workspace();
      workspaceReady = true;
      localWorkspace = folder;
      show("#dl-workspace", folder);
    }
    void runLocalTask(input.prompt);
    return { status: "started", jobId: localSessionId };
  };
  $("#dl-back-chat").addEventListener("click", () => {
    document.body.classList.remove("ditto-desktop-settings");
  });
  const show = (target, message) => {
    if (target === "#dl-output") {
      setCodeResponse(sharedOutput, message);
      return;
    }
    $(target).textContent = message;
  };
  const item = (title, subtitle, body) => {
    const card = element("div", "ditto-local-item");
    card.append(
      element("strong", "", title),
      element("small", "", subtitle),
      element("p", "", body || ""),
    );
    return card;
  };
  function roots(items) {
    const list = $("#dl-roots");
    list.replaceChildren();
    for (const root of items) {
      const row = element("div", "ditto-local-row");
      const label = element("span", "ditto-local-muted ditto-local-path", root);
      const remove = element("button", "", "Remove");
      remove.addEventListener("click", async () => {
        try {
          roots(await window.ditto.removeRoot(root));
        } catch (error) {
          show("#dl-progress", error.message);
        }
      });
      row.append(label, remove);
      list.append(row);
    }
  }
  async function refresh() {
    try {
      const [status, runs] = await Promise.all([window.ditto.status(), window.ditto.recentRuns()]);
      for (const name of ["code", "codex", "cursor", "memories"])
        show(`#dl-${name}`, number(status.stats[name]));
      show(
        "#dl-pi-status",
        status.pi.ready ? `Ready · ${status.pi.model}` : "Ditto Code needs a model to run.",
      );
      $("#dl-pi-login").hidden = status.pi.ready;
      for (const provider of status.providers) {
        const option = $("#dl-provider").querySelector(`[value="${provider.id}"]`);
        if (option) {
          option.disabled = !provider.available;
          option.title = provider.detail;
        }
        const remoteOption = $("#dl-remote-provider").querySelector(`[value="${provider.id}"]`);
        if (remoteOption) remoteOption.disabled = !provider.available;
      }
      workspaceReady = Boolean(status.workspace);
      localWorkspace = status.workspace || "";
      defaultLocalWorkspace = status.defaultWorkspace;
      show("#dl-workspace", status.workspace || "Choose a project folder");
      const home = $("#dl-default-workspace");
      if (home) {
        home.hidden = status.workspace === status.defaultWorkspace;
        home.disabled = running;
      }
      for (const button of document.querySelectorAll(
        ".ditto-desktop-workspace:not(#dl-default-workspace)",
      ))
        button.textContent =
          status.workspace === status.defaultWorkspace
            ? "Ditto workspace"
            : status.workspace?.split("/").at(-1) || "Ditto workspace";
      roots(status.roots);
      const list = $("#dl-runs");
      list.replaceChildren();
      for (const run of runs) {
        list.append(
          item(
            run.prompt,
            `${new Date(run.started_at).toLocaleString()} · ${run.provider === "pi" || !run.provider ? "Ditto Code" : run.provider} · ${run.status} · ${run.workspace}`,
            run.response || run.error,
          ),
        );
      }
      if (!runs.length) list.append(element("p", "ditto-local-muted", "No local executions yet."));
      mountLocalCode();
      codeThreads = await window.ditto.codeThreads();
      renderCodeHistory();
    } catch (error) {
      show("#dl-progress", `Could not load local memory: ${error.message}`);
    }
  }
  $("#dl-scan").addEventListener("click", async () => {
    const button = $("#dl-scan");
    button.disabled = true;
    show("#dl-progress", "Scanning this Mac…");
    try {
      await window.ditto.scan();
      await refresh();
      show("#dl-progress", "Scan complete. Local memory is ready.");
    } catch (error) {
      show("#dl-progress", error.message);
    } finally {
      button.disabled = false;
    }
  });
  $("#dl-add-root").addEventListener("click", async () => {
    try {
      const result = await window.ditto.chooseRoot();
      if (result) roots(result);
    } catch (error) {
      show("#dl-progress", error.message);
    }
  });
  $("#dl-export").addEventListener("click", async () => {
    const button = $("#dl-export");
    button.disabled = true;
    try {
      const result = await window.ditto.exportBundle();
      show(
        "#dl-progress",
        `${number(result.records)} items prepared. Finder opened the import folder.`,
      );
    } catch (error) {
      show("#dl-progress", error.message);
    } finally {
      button.disabled = false;
    }
  });
  let localSearchGeneration = 0;
  $("#dl-query").addEventListener("input", () => {
    localSearchGeneration++;
    if (!$("#dl-query").value.trim()) $("#dl-results").replaceChildren();
  });
  $("#dl-search-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const generation = ++localSearchGeneration;
    const query = $("#dl-query").value.trim();
    const list = $("#dl-results");
    if (!query) {
      list.replaceChildren();
      return;
    }
    list.textContent = "Searching…";
    try {
      const results = await window.ditto.search(query);
      if (generation !== localSearchGeneration) return;
      list.replaceChildren();
      // Exact local source matches should lead broad trajectory suggestions.
      for (const match of results.matches)
        list.append(
          item(match.title || "Source", `${match.source} · ${match.path}`, match.excerpt || ""),
        );
      for (const memory of results.memories) {
        const prompt = memory.prompt?.trim();
        const answer = memory.response?.trim();
        list.append(
          item(
            prompt?.slice(0, 160) || memory.summary || "Ditto memory",
            `${memory.source || "Memory"} · ${memory.sourceContext || "Local trajectory"}`,
            answer?.slice(0, 500) || memory.summary || "",
          ),
        );
      }
      if (!list.children.length)
        list.append(element("p", "ditto-local-muted", "No matching local memory."));
    } catch (error) {
      if (generation === localSearchGeneration) list.textContent = error.message;
    }
  });
  $("#dl-choose-workspace").addEventListener("click", async () => {
    try {
      const folder = await window.ditto.chooseWorkspace();
      if (folder) {
        workspaceReady = true;
        if (localWorkspace !== folder) newLocalTask();
        localWorkspace = folder;
        show("#dl-workspace", folder);
        void refresh();
      }
    } catch (error) {
      show("#dl-pi-status", error.message);
    }
  });
  $("#dl-pi-login").addEventListener("click", async () => {
    try {
      await window.ditto.piLogin();
      show("#dl-pi-status", "Ditto Code model setup opened in Terminal.");
    } catch (error) {
      show("#dl-pi-status", error.message);
    }
  });
  $("#dl-provider").addEventListener("change", () => {
    const provider = $("#dl-provider").value;
    const localLabel = document.querySelector('[data-ditto-code-mode="local"] strong');
    if (localLabel)
      localLabel.textContent =
        provider === "pi"
          ? "Local · Ditto Code"
          : `Local · ${$("#dl-provider").selectedOptions[0]?.textContent || provider}`;
    if (localTurns.length && localTurns.at(-1).provider !== provider) newLocalTask();

    $("#dl-provider-login").hidden = provider === "pi";
    if (provider !== "pi") {
      const label = $("#dl-provider").selectedOptions[0]?.textContent || provider;
      $("#dl-provider-login").textContent = `Sign in to ${label}`;
      $("#dl-run").textContent = `Dispatch locally to ${label}`;
      show("#dl-context", `${label} runs through its installed local CLI. Sign in here if needed.`);
    } else {
      $("#dl-run").textContent = "Run Ditto Code locally";
      show("#dl-context", "Ditto Code · On this Mac");
    }
    void refresh();
  });
  $("#dl-provider-login").addEventListener("click", async () => {
    try {
      await window.ditto.providerLogin($("#dl-provider").value);
      show("#dl-context", "Provider sign-in opened in Terminal.");
    } catch (error) {
      show("#dl-context", error.message);
    }
  });
  $("#dl-chat-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (running) return;
    const prompt = $("#dl-prompt").value.trim();
    if (!prompt) return;
    if (!workspaceReady) {
      try {
        const folder = await window.ditto.workspace();
        workspaceReady = true;
        show("#dl-workspace", folder);
      } catch (error) {
        show("#dl-context", error.message);
        return;
      }
    }
    running = true;
    $("#dl-run").disabled = true;
    $("#dl-cancel").hidden = false;
    const provider = $("#dl-provider").value;
    show("#dl-output", "");
    show(
      "#dl-context",
      `Starting ${provider === "pi" ? "Ditto Code" : $("#dl-provider").selectedOptions[0]?.textContent || provider} on this Mac…`,
    );
    try {
      if (provider === "pi") await window.ditto.chat(prompt);
      else await window.ditto.runProvider(provider, prompt);
      $("#dl-prompt").value = "";
    } catch (error) {
      show("#dl-context", error.message);
    } finally {
      running = false;
      $("#dl-run").disabled = false;
      $("#dl-cancel").hidden = true;
      void refresh();
    }
  });
  $("#dl-cancel").addEventListener("click", () => {
    void window.ditto.cancelChat();
  });
  const checkComputer = () =>
    window.ditto
      .computerStatus()
      .then((status) => {
        $("#dl-computer-enable").checked = status.enabled;
        updateComputerControls(status.enabled);
        show(
          "#dl-computer-status",
          status.enabled
            ? "Computer Use is on."
            : status.running
              ? "Computer Use is off. Open setup to check access."
              : "Computer Use is stopped.",
        );
      })
      .catch((error) => show("#dl-computer-status", error.message));
  void checkComputer();
  $("#dl-computer-refresh").addEventListener("click", checkComputer);
  $("#dl-computer-settings").addEventListener("click", () => {
    void window.ditto
      .computerSettings()
      .catch((error) => show("#dl-computer-status", error.message));
  });
  $("#dl-computer-enable").addEventListener("change", async () => {
    try {
      await window.ditto.computerEnable($("#dl-computer-enable").checked);
    } catch (error) {
      $("#dl-computer-enable").checked = false;
      show("#dl-computer-status", error.message);
    }
  });
  window.ditto.onComputerEnabled((enabled) => {
    updateComputerControls(enabled);
    $("#dl-computer-enable").checked = enabled;
  });
  const remoteStatus = (status) => {
    show(
      "#dl-remote-status",
      status.detail || (status.running ? "Connected to Ditto." : "Remote Control is off."),
    );
    $("#dl-remote-start").hidden = Boolean(status.running);
    $("#dl-remote-stop").hidden = !status.running;
    $("#dl-remote-provider").disabled = Boolean(status.running);
  };
  async function loadEndpoints() {
    const select = $("#dl-endpoint");
    const cloudSelect = $("#dl-cloud-endpoint");
    try {
      const endpoints = (await window.ditto.remoteEndpoints())
        .filter((endpoint) => endpoint.status === "active" && endpoint.access?.use !== false)
        .sort((left, right) => Number(Boolean(right.codeMode)) - Number(Boolean(left.codeMode)));
      select.replaceChildren();
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose endpoint";
      select.append(placeholder);
      for (const endpoint of endpoints) {
        const option = document.createElement("option");
        option.value = endpoint.slug || endpoint.id;
        option.textContent = `${endpoint.name || endpoint.slug || endpoint.id}${endpoint.codeMode ? " · Code" : ""}`;
        select.append(option);
        if (endpoint.isDefault || endpoint.default) select.value = option.value;
      }
      if (!endpoints.length) {
        placeholder.textContent = "No Ditto endpoint";
        show(
          "#dl-remote-status",
          "Create a Ditto inference endpoint in Settings → Developer to use Remote Control or cloud execution.",
        );
      }
      cloudSelect.replaceChildren();
      const personal = endpoints.filter((endpoint) => !endpoint.companyId);
      for (const endpoint of personal) {
        const option = document.createElement("option");
        option.value = endpoint.slug || endpoint.id;
        option.textContent = endpoint.name || endpoint.slug || endpoint.id;
        cloudSelect.append(option);
      }
      if (!personal.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No personal endpoint";
        cloudSelect.append(option);
      }
    } catch (error) {
      select.replaceChildren();
      cloudSelect.replaceChildren();
      show("#dl-remote-status", error.message);
    }
  }
  const accountLink = createDesktopAccountLink(
    window.ditto,
    ({ linked, busy, message }) => {
      $("#dl-account-connect").hidden = linked || busy;
      $("#dl-account-cancel").hidden = linked || !busy;
      $("#dl-account-disconnect").hidden = !linked;
      $("#dl-account-disconnect").disabled = busy;
      show("#dl-account-status", message);
    },
    () => {
      void loadEndpoints();
      void window.ditto
        .remoteStatus()
        .then(remoteStatus)
        .catch((error) => show("#dl-remote-status", desktopError(error)));
      void window.ditto
        .devicesStatus()
        .then(networkStatus)
        .catch((error) => show("#dl-devices-status", desktopError(error)));
    },
  );
  $("#dl-account-connect").addEventListener("click", () => void accountLink.start());
  $("#dl-account-cancel").addEventListener("click", () => void accountLink.cancel());
  $("#dl-account-disconnect").addEventListener("click", () => void accountLink.disconnect());
  void accountLink.refresh().catch((error) => show("#dl-account-status", desktopError(error)));
  void loadEndpoints();
  void window.ditto
    .remoteStatus()
    .then(remoteStatus)
    .catch((error) => show("#dl-remote-status", error.message));
  window.ditto.onRemoteStatus(remoteStatus);
  $("#dl-remote-start").addEventListener("click", async () => {
    const button = $("#dl-remote-start");
    button.disabled = true;
    try {
      if (!$("#dl-endpoint").value) throw new Error("Choose a Ditto endpoint for Remote Control.");
      remoteStatus(
        await window.ditto.remoteStart($("#dl-remote-provider").value, $("#dl-endpoint").value),
      );
    } catch (error) {
      show("#dl-remote-status", error.message);
    } finally {
      button.disabled = false;
    }
  });
  $("#dl-remote-stop").addEventListener("click", async () => {
    try {
      remoteStatus(await window.ditto.remoteStop());
    } catch (error) {
      show("#dl-remote-status", error.message);
    }
  });
  let enginePeer = null;
  let enginePeerName = null;
  let engineUpdating = false;
  const networkStatus = (status) => {
    show("#dl-devices-status", status.detail);
    $("#dl-devices-start").hidden = status.enabled;
    $("#dl-devices-stop").hidden = !status.enabled;
    $("#dl-pair-create").disabled = !status.online;
    $("#dl-pair-claim").disabled = !status.online;
    if (!status.online && enginePeer) {
      enginePeer = null;
      enginePeerName = null;
      $("#dl-engines-local").hidden = true;
      $("#dl-engines-title").textContent = "Coding engines on this Mac";
      $("#dl-engines").replaceChildren();
    }
  };
  void window.ditto
    .devicesStatus()
    .then(networkStatus)
    .catch((error) => show("#dl-devices-status", error.message));
  window.ditto.onDevicesStatus(networkStatus);
  $("#dl-devices-start").addEventListener("click", async () => {
    try {
      networkStatus(await window.ditto.devicesStart());
    } catch (error) {
      show("#dl-devices-status", desktopError(error));
    }
  });
  $("#dl-devices-stop").addEventListener("click", async () => {
    networkStatus(await window.ditto.devicesStop());
  });
  $("#dl-pair-create").addEventListener("click", async () => {
    try {
      const result = await window.ditto.devicesPairCode();
      show(
        "#dl-pair-status",
        `Enter ${result.code} on your other Mac. Expires ${new Date(result.expiresAt).toLocaleTimeString()}.`,
      );
    } catch (error) {
      show("#dl-pair-status", desktopError(error));
    }
  });
  $("#dl-pair-claim").addEventListener("click", async () => {
    const button = $("#dl-pair-claim");
    button.disabled = true;
    try {
      await window.ditto.devicesClaim($("#dl-pair-code").value.trim());
      $("#dl-pair-code").value = "";
      show("#dl-pair-status", "Mac paired.");
      await refreshDevices();
    } catch (error) {
      show("#dl-pair-status", desktopError(error));
    } finally {
      networkStatus(await window.ditto.devicesStatus());
    }
  });
  const refreshEngines = async () => {
    const button = $("#dl-engines-refresh");
    button.disabled = true;
    const peer = enginePeer;
    try {
      show("#dl-engines-status", "Checking installed engines…");
      const status = peer
        ? await window.ditto.devicesRequest(peer, "engines.status")
        : await window.ditto.enginesStatus();
      if (peer !== enginePeer) return;
      const list = $("#dl-engines");
      list.replaceChildren();
      for (const engine of status.engines) {
        const card = item(
          engine.name,
          engine.version || (engine.installed ? "Installed" : "Not installed"),
          engine.detail,
        );
        if (engine.updatable) {
          const update = element("button", "", `Update ${engine.name}`);
          update.disabled = Boolean(engineUpdating || status.updating || status.busy);
          update.addEventListener("click", async () => {
            if (engineUpdating) return;
            engineUpdating = true;
            list.querySelectorAll("button").forEach((node) => {
              node.disabled = true;
            });
            $("#dl-engines-refresh").disabled = true;
            $("#dl-engines-local").disabled = true;
            show(
              "#dl-engines-status",
              `Updating ${engine.name}${peer ? ` on ${enginePeerName}` : ""}…`,
            );
            try {
              const result = peer
                ? await window.ditto.devicesRequest(peer, "engines.update", { provider: engine.id })
                : await window.ditto.enginesUpdate(engine.id);
              if (result.version) card.querySelector("small").textContent = result.version;
              show(
                "#dl-engines-status",
                `${engine.name} update finished${result.version ? ` · ${result.version}` : ""}.`,
              );
            } catch (error) {
              show("#dl-engines-status", `${engine.name} update failed. ${desktopError(error)}`);
            } finally {
              engineUpdating = false;
              $("#dl-engines-refresh").disabled = false;
              $("#dl-engines-local").disabled = false;
              list.querySelectorAll("button").forEach((node) => {
                node.disabled = false;
              });
            }
          });
          card.append(update);
        }
        list.append(card);
      }
      show(
        "#dl-engines-status",
        status.updating
          ? "An engine update is in progress."
          : status.busy
            ? "Wait for coding tasks to finish before updating."
            : "Installed engines checked.",
      );
    } catch (error) {
      show("#dl-engines-status", desktopError(error));
    } finally {
      button.disabled = engineUpdating;
    }
  };
  $("#dl-engines-refresh").addEventListener("click", refreshEngines);
  $("#dl-engines-local").addEventListener("click", () => {
    enginePeer = null;
    enginePeerName = null;
    $("#dl-engines-local").hidden = true;
    $("#dl-engines-title").textContent = "Coding engines on this Mac";
    void refreshEngines();
  });
  window.ditto.onEngineUpdate((status) => {
    if (!enginePeer) show("#dl-engines-status", status.detail);
  });
  const refreshDevices = async () => {
    const button = $("#dl-remote-refresh");
    button.disabled = true;
    try {
      const [hosts, status] = await Promise.all([
        window.ditto.remoteHosts(),
        window.ditto.devicesStatus(),
      ]);
      const list = $("#dl-remote-devices");
      list.replaceChildren();
      for (const host of hosts) {
        const isThisMac = host.id === status.hostId;
        const card = item(
          `${host.name || "Ditto device"}${isThisMac ? " · This Mac" : ""}`,
          `${host.online ? "Online" : "Offline"} · ${host.kind || "host"} · ${host.platform || "Mac"}`,
          [
            host.version && `Version ${host.version}`,
            host.paired ? "Paired" : !isThisMac ? "Pair this Mac to manage it" : "",
          ]
            .filter(Boolean)
            .join(" · "),
        );
        if (!isThisMac && host.kind === "desktop") {
          const manage = element("button", "", "Manage coding engines");
          manage.disabled = !host.online || !host.paired || !status.online || engineUpdating;
          manage.addEventListener("click", () => {
            if (engineUpdating) return;
            enginePeer = host.id;
            enginePeerName = host.name || "your other Mac";
            $("#dl-engines-title").textContent = `Coding engines on ${enginePeerName}`;
            $("#dl-engines-local").hidden = false;
            void refreshEngines();
          });
          card.append(manage);
        }
        if (host.paired && !isThisMac) {
          const unpair = element("button", "", "Unpair");
          unpair.disabled = !status.online || engineUpdating;
          unpair.addEventListener("click", async () => {
            try {
              await window.ditto.devicesUnpair(host.id);
              if (enginePeer === host.id) {
                enginePeer = null;
                enginePeerName = null;
                $("#dl-engines-local").hidden = true;
                $("#dl-engines-title").textContent = "Coding engines on this Mac";
                $("#dl-engines").replaceChildren();
              }
              await refreshDevices();
            } catch (error) {
              show("#dl-devices-status", desktopError(error));
            }
          });
          card.append(unpair);
        }
        list.append(card);
      }
      if (!hosts.length) list.append(element("p", "ditto-local-muted", "No linked devices yet."));
    } catch (error) {
      show("#dl-devices-status", desktopError(error));
    } finally {
      button.disabled = false;
    }
  };
  $("#dl-remote-refresh").addEventListener("click", refreshDevices);
  const teleportStatus = (message) => show("#dl-teleport-status", message);
  const teleportBusy = async (button, action) => {
    button.disabled = true;
    try {
      await action();
    } catch (error) {
      teleportStatus(error.message);
    } finally {
      button.disabled = false;
    }
  };
  $("#dl-teleport-plan").addEventListener("click", () =>
    teleportBusy($("#dl-teleport-plan"), async () => {
      teleportStatus("Inspecting this project…");
      const plan = await window.ditto.teleportPlan();
      const projects = plan.repos?.flatMap((repo) => repo.projects || []) || [];
      const list = $("#dl-teleport-results");
      list.replaceChildren();
      list.append(
        item(
          `${number(plan.repos?.length)} repositories · ${number(projects.length)} projects`,
          plan.root || "Selected project",
          projects
            .map((project) => `${project.relPath}: ${(project.labels || []).join(", ")}`)
            .join("\n") || "Ready to save.",
        ),
      );
      teleportStatus("Preview complete. Nothing was uploaded.");
    }),
  );
  const push = (button, cloud) =>
    teleportBusy(button, async () => {
      if (cloud && !$("#dl-cloud-endpoint").value)
        throw new Error("Choose a personal Ditto endpoint before continuing in cloud.");
      teleportStatus(
        cloud ? "Sending this project to Ditto Cloud…" : "Saving this project as a Ditto capsule…",
      );
      const result = await window.ditto.teleportPush(
        cloud,
        cloud ? $("#dl-cloud-endpoint").value : undefined,
      );
      teleportStatus(
        cloud
          ? "Cloud session started. Find it in Code."
          : `Capsule saved: ${result.name || result.capsuleId || "project"}.`,
      );
      void listCapsules();
    });
  $("#dl-teleport-push").addEventListener("click", () => push($("#dl-teleport-push"), false));
  $("#dl-teleport-cloud").addEventListener("click", () => push($("#dl-teleport-cloud"), true));
  async function listCapsules() {
    const result = await window.ditto.teleportList();
    const list = $("#dl-teleport-results");
    list.replaceChildren();
    for (const capsule of result.capsules || [])
      list.append(
        item(
          capsule.name,
          `Generation ${capsule.headGeneration || 0} · ${capsule.status || "active"}`,
          capsule.id,
        ),
      );
    if (!list.children.length) list.append(element("p", "ditto-local-muted", "No capsules yet."));
  }
  $("#dl-teleport-list").addEventListener("click", () =>
    teleportBusy($("#dl-teleport-list"), async () => {
      await listCapsules();
      teleportStatus("Capsules refreshed.");
    }),
  );
  window.ditto.onTeleportProgress((progress) => teleportStatus(progress.trim().slice(-250)));
  window.ditto.onProgress((message) => {
    show("#dl-progress", message);
  });
  window.ditto.onScanFinished(() => {
    if (activePanel === "Local") void refresh();
  });
  window.ditto.onChatEvent((event) => {
    recordCodeActivity(event);
    if (event.type === "start") show("#dl-context", `${event.memoryCount} local sources`);
    if (event.type === "text") {
      const box = $("#dl-output");
      setCodeResponse(box, (responseSources.get(box) || "") + event.text);
      scrollLocalCode();
    }
    if (event.type === "tool") show("#dl-context", `Ditto Code used ${event.name}`);
    if (event.type === "tool-error") show("#dl-context", `${event.name}: ${event.message}`);
    if (event.type === "error") show("#dl-context", event.message);
    if (event.type === "done") show("#dl-context", "Complete");
    if (event.type === "cancelled") show("#dl-context", "Stopped");
    mountLocalCode();
  });

  window.addEventListener("ditto-desktop-local-packet", async (event) => {
    const packet = event.detail;
    cloudCodeMode = false;
    $("#dl-provider").value = "pi";
    $("#dl-provider").dispatchEvent(new Event("change"));
    document.querySelector('nav.v2-studio-rail a[aria-label="Code"]')?.click();
    openPanel("Local");
    await refresh();
    desktopMode(
      true,
      `Use the local knowledge packet at ${packet.path} as context for this task.\n\n`,
    );
    document.querySelector('[data-testid="chat-composer-textarea"]')?.focus();
    show("#dl-context", `${packet.messageCount} chat messages ready for Ditto Code`);
  });
  mountSidebars();
})();
