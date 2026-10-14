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
  const number = (value) => Number(value || 0).toLocaleString();
  const desktopError = (error) =>
    String(error.message || error).replace(
      /^Error invoking remote method '[^']+': (?:Error: )?/,
      "",
    );
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
    if (name !== "Browser") void window.ditto.browserHide();
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
    markActive();
    mountCodeSource();
    mountLocalCode();
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
    const group = element("section", "v2-studio-section ditto-desktop-code-group");
    group.setAttribute("aria-label", "Code execution");
    const heading = element("div", "v2-studio-section-head");
    heading.append(element("span", "ditto-desktop-code-heading", "Execution"));
    group.append(heading);
    for (const [mode, title, description, glyph] of [
      ["local", "Local · Ditto Code", "Pi agent on this Mac", "⌂"],
      ["cloud", "Cloud · Ditto", "Ditto cloud tasks and projects", "☁"],
      ["browser", "Browser · Local", "Shared with Ditto Code", "◎"],
    ]) {
      const row = element("div", "v2-studio-recent-row");
      const button = element("button", "v2-studio-recent ditto-desktop-code-mode");
      button.type = "button";
      button.dataset.dittoCodeMode = mode;
      button.setAttribute(
        "aria-label",
        mode === "local"
          ? "Run Ditto Code locally"
          : mode === "cloud"
            ? "Run Ditto Code in the cloud"
            : "Open local browser",
      );
      button.append(element("span", "ditto-desktop-local-mark", glyph));
      const copy = element("span");
      copy.append(element("strong", "", title), element("small", "", description));
      button.append(copy);
      button.addEventListener("click", () => {
        if (mode === "local") {
          cloudCodeMode = false;
          $("#dl-provider").dispatchEvent(new Event("change"));
          openPanel("Local");
        } else if (mode === "browser") {
          cloudCodeMode = false;
          openPanel("Browser");
        } else {
          cloudCodeMode = true;
          activePanel = null;
          desktopMode(false);
          document.body.classList.remove(
            "ditto-local-open",
            "ditto-local-from-chat",
            "ditto-browser-open",
            "ditto-desktop-settings",
          );
          void window.ditto.browserHide();
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
        $("#dl-provider").value = "pi";
        $("#dl-provider").dispatchEvent(new Event("change"));
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
      <section class="ditto-local-card"><h2>Search local memory</h2><p>Find relevant code and agent work before you ask Pi.</p>
        <form id="dl-search-form" class="ditto-local-form"><input id="dl-query" type="search" placeholder="Search code, Codex, and Cursor" aria-label="Search local memory"><button class="primary">Search</button></form>
        <div id="dl-results" class="ditto-local-list"></div></section>
      <section class="ditto-local-card"><div class="ditto-local-row between"><div><h2>Ditto Code on this Mac</h2><p id="dl-pi-status">Checking model…</p></div><button id="dl-pi-login" hidden>Sign in to Pi</button></div>
        <div class="ditto-local-row" style="margin-top:12px"><span class="ditto-local-muted">Working folder: <span id="dl-workspace" class="ditto-local-path"></span></span><button id="dl-choose-workspace">Change folder</button></div>
        <div class="ditto-local-row" style="margin-top:12px"><label for="dl-provider" class="ditto-local-muted">Coding engine</label><select id="dl-provider" aria-label="Coding engine">
          <option value="pi">Ditto Code · Pi (default)</option><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="cursor">Cursor Agent</option><option value="grok">Grok</option>
        </select><button id="dl-provider-login" type="button" hidden>Sign in to provider</button></div>
        <div class="ditto-local-row ditto-computer-control" style="margin-top:12px"><label><input id="dl-computer-enable" type="checkbox"> Allow Mac computer control for the next Pi task</label><span id="dl-computer-status" class="ditto-local-muted"></span><button id="dl-computer-settings">Open Accessibility settings</button><button id="dl-computer-refresh">Check permission</button></div>
        <form id="dl-chat-form" style="margin-top:13px"><textarea id="dl-prompt" placeholder="Ask Pi to use your local memory and work on a project…" aria-label="Ask Pi"></textarea>
          <div class="ditto-local-row" style="margin-top:9px"><button id="dl-run" class="primary">Run locally with Pi</button><button id="dl-cancel" type="button" hidden>Stop</button><span id="dl-context" class="ditto-local-muted"></span></div></form>
        <div id="dl-output" class="ditto-local-output" aria-live="polite"></div></section>
      <section class="ditto-local-card"><h2>Recent local executions</h2><p>Saved privately on this Mac.</p><div id="dl-runs" class="ditto-local-list"></div></section>
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
  async function showBrowser() {
    try {
      const state = await window.ditto.browserStatus();
      if (state.url) await window.ditto.browserShow(browserBounds());
      browserState(state);
    } catch (error) {
      browserPage.querySelector("#db-status").textContent = error.message;
    }
  }
  function browserState(state) {
    if (state.url && document.activeElement !== browserPage.querySelector("#db-address"))
      browserPage.querySelector("#db-address").value = state.url;
    browserPage.querySelector("#db-back").disabled = !state.canGoBack;
    browserPage.querySelector("#db-forward").disabled = !state.canGoForward;
    if (state.url) browserPage.querySelector("#db-status").textContent = state.title || state.url;
  }
  new ResizeObserver(() => {
    if (activePanel === "Browser") void showBrowser();
  }).observe(browserPage.querySelector("#db-viewport"));
  browserPage.querySelector("#db-address-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const state = await window.ditto.browserNavigate(
        browserPage.querySelector("#db-address").value,
      );
      await window.ditto.browserShow(browserBounds());
      browserState(state);
    } catch (error) {
      browserPage.querySelector("#db-status").textContent = error.message;
    }
  });
  for (const [id, action] of [
    ["db-back", "browserBack"],
    ["db-forward", "browserForward"],
    ["db-reload", "browserReload"],
  ]) {
    browserPage.querySelector(`#${id}`).addEventListener("click", async () => {
      try {
        browserState(await window.ditto[action]());
      } catch (error) {
        browserPage.querySelector("#db-status").textContent = error.message;
      }
    });
  }
  browserPage.querySelector("#db-inspect").addEventListener("click", async () => {
    try {
      const snapshot = await window.ditto.browserSnapshot();
      browserPage.querySelector("#db-inspect-output").textContent =
        `${number(snapshot.controls.length)} controls · ${snapshot.text.slice(0, 240)}`;
    } catch (error) {
      browserPage.querySelector("#db-inspect-output").textContent = error.message;
    }
  });
  window.ditto.onBrowserState(browserState);
  window.ditto.onBrowserOpen(() => {
    if (location.pathname === "/code") openPanel("Browser");
  });

  let running = false;
  let workspaceReady = false;
  let localSessionId = crypto.randomUUID();
  let localTurns = [];
  let localWorkspace = "";
  const localChat = element("div", "v2-code-start ditto-desktop-code-chat");
  localChat.setAttribute("aria-label", "Local Ditto Code conversation");
  localChat.innerHTML =
    '<header class="v2-code-start-header"><h1>What should Ditto Code do?</h1><p>Describe the task. Ditto Code uses Pi and your private memory to work on this Mac.</p></header><div id="dl-transcript" aria-live="polite"></div><div id="dl-chat-status" role="status"></div>';
  const sharedOutput = $("#dl-output");
  sharedOutput.classList.add("ditto-desktop-code-response");
  localChat.querySelector("#dl-transcript").append(sharedOutput);
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
        ? "Describe the task. Ditto Code uses Pi and your private memory to work on this Mac."
        : `Describe the task. ${engineName} runs through its installed CLI on this Mac.`;
    const subtitle = localChat.querySelector("header p");
    if (subtitle.textContent !== description) subtitle.textContent = description;
    const modeDescription = document.querySelector('[data-ditto-code-mode="local"] small');
    const localDescription =
      provider.value === "pi" ? "Pi agent on this Mac" : `${engineName} on this Mac`;
    if (modeDescription && modeDescription.textContent !== localDescription)
      modeDescription.textContent = localDescription;
    const main = document.querySelector(".v2-code-surface-main");
    if (main && !main.contains(localChat)) main.append(localChat);
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
    const group = document.querySelector(".ditto-desktop-code-group");
    if (group && !group.querySelector(".ditto-desktop-local-actions")) {
      const actions = element("div", "ditto-desktop-local-actions");
      const label = element("label", "", "Local engine");
      label.htmlFor = "dl-provider";
      actions.append(label, $("#dl-provider"));
      const fresh = element("button", "v2-studio-create", "New local task");
      fresh.type = "button";
      fresh.addEventListener("click", () => {
        if (!running) {
          newLocalTask();
          cloudCodeMode = false;
          openPanel("Local");
        }
      });
      const settings = element("button", "v2-studio-create", "Desktop settings");
      settings.type = "button";
      settings.addEventListener("click", () => {
        openPanel("Local");
        document.body.classList.add("ditto-desktop-settings");
      });
      actions.append(fresh, settings, $("#dl-cancel"));
      group.append(actions);
      const history = element("div", "ditto-desktop-local-history");
      history.setAttribute("aria-label", "Local tasks");
      group.append(history);
    }
    const status = localChat.querySelector("#dl-chat-status");
    if (status.textContent !== $("#dl-context").textContent)
      status.textContent = $("#dl-context").textContent;
  }
  function newLocalTask() {
    localSessionId = crypto.randomUUID();
    localTurns = [];
    localChat.querySelector("#dl-transcript").replaceChildren(sharedOutput);
    sharedOutput.textContent = "";
    localChat.classList.remove("has-turns");
    show("#dl-context", `${$("#dl-provider").selectedOptions[0].textContent} · On this Mac`);
    desktopMode(true, "");
  }
  function addLocalTurn(prompt, provider) {
    const transcript = localChat.querySelector("#dl-transcript");
    if (sharedOutput.textContent)
      transcript.append(element("div", "ditto-desktop-code-response", sharedOutput.textContent));
    const question = element("article", "ditto-desktop-code-question", prompt);
    question.setAttribute("aria-label", "Your task");
    transcript.append(question, sharedOutput);
    sharedOutput.textContent = "";
    localChat.classList.add("has-turns");
    localTurns.push({ prompt, provider });
  }
  async function runLocalTask(prompt) {
    const provider = $("#dl-provider").value;
    running = true;
    $("#dl-provider").disabled = true;
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
      const folder = await window.ditto.chooseWorkspace();
      if (!folder) return { status: "blocked", reason: "Choose a local project folder first." };
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
        status.pi.ready ? `Ready · ${status.pi.model}` : "Pi needs a model to run.",
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
      show("#dl-workspace", status.workspace || "Choose a project folder");
      for (const button of document.querySelectorAll(".ditto-desktop-workspace"))
        button.textContent = status.workspace
          ? status.workspace.split("/").at(-1)
          : "Choose local folder";
      roots(status.roots);
      const list = $("#dl-runs");
      list.replaceChildren();
      for (const run of runs) {
        list.append(
          item(
            run.prompt,
            `${new Date(run.started_at).toLocaleString()} · ${run.provider || "pi"} · ${run.status} · ${run.workspace}`,
            run.response || run.error,
          ),
        );
      }
      if (!runs.length) list.append(element("p", "ditto-local-muted", "No local executions yet."));
      mountLocalCode();
      const history = document.querySelector(".ditto-desktop-local-history");
      if (history) {
        history.replaceChildren();
        const seenSessions = new Set();
        for (const run of runs) {
          if ((run.provider || "pi") !== $("#dl-provider").value) continue;
          if (run.session_id && seenSessions.has(run.session_id)) continue;
          if (run.session_id) seenSessions.add(run.session_id);
          const button = element("button", "v2-studio-recent", run.prompt.slice(0, 70));
          button.type = "button";
          button.title = `${run.provider || "pi"} · ${run.status}`;
          button.addEventListener("click", () => {
            if (running) return;
            cloudCodeMode = false;
            openPanel("Local");
            const resumable =
              run.provider === "pi" && run.session_id && run.workspace === localWorkspace;
            localSessionId = resumable ? run.session_id : crypto.randomUUID();
            localTurns = [{ prompt: run.prompt, provider: run.provider }];
            $("#dl-provider").value = run.provider || "pi";
            const transcript = localChat.querySelector("#dl-transcript");
            transcript.replaceChildren();
            const turns = run.session_id
              ? runs.filter((turn) => turn.session_id === run.session_id).reverse()
              : [run];
            for (const turn of turns) {
              transcript.append(
                element("article", "ditto-desktop-code-question", turn.prompt),
                element("div", "ditto-desktop-code-response", turn.response || turn.error || ""),
              );
            }
            sharedOutput.textContent = "";
            transcript.append(sharedOutput);
            localChat.classList.add("has-turns");
            desktopMode(true, "");
            show(
              "#dl-context",
              resumable
                ? "Continue this local Pi conversation"
                : "Saved execution · A new task will start on this Mac",
            );
          });
          history.append(button);
        }
      }
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
  $("#dl-search-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = $("#dl-query").value.trim();
    if (!query) return;
    const list = $("#dl-results");
    list.textContent = "Searching…";
    try {
      const results = await window.ditto.search(query);
      list.replaceChildren();
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
      for (const match of results.matches)
        list.append(
          item(match.title || "Source", `${match.source} · ${match.path}`, match.excerpt || ""),
        );
      if (!list.children.length)
        list.append(element("p", "ditto-local-muted", "No matching local memory."));
    } catch (error) {
      list.textContent = error.message;
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
      show("#dl-pi-status", "Pi sign-in opened in Terminal.");
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
    $("#dl-computer-enable").disabled = provider !== "pi";
    $("#dl-provider-login").hidden = provider === "pi";
    if (provider !== "pi") {
      const label = $("#dl-provider").selectedOptions[0]?.textContent || provider;
      $("#dl-provider-login").textContent = `Sign in to ${label}`;
      $("#dl-run").textContent = `Dispatch locally to ${label}`;
      show("#dl-context", `${label} runs through its installed local CLI. Sign in here if needed.`);
    } else {
      $("#dl-run").textContent = "Run locally with Pi";
      show("#dl-context", "Ditto Code · Pi · On this Mac");
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
        const folder = await window.ditto.chooseWorkspace();
        if (!folder) {
          show("#dl-context", "Choose a project folder to run local code.");
          return;
        }
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
      `Starting ${provider === "pi" ? "Pi" : $("#dl-provider").selectedOptions[0]?.textContent || provider} on this Mac…`,
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
        show(
          "#dl-computer-status",
          status.locked
            ? "Unlock this Mac to use computer control."
            : status.trusted
              ? "Accessibility is ready."
              : "Grant Ditto Desktop Accessibility in macOS Settings.",
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
    if (event.type === "start") show("#dl-context", `${event.memoryCount} local sources`);
    if (event.type === "text") {
      const box = $("#dl-output");
      box.textContent += event.text;
      box.scrollTop = box.scrollHeight;
    }
    if (event.type === "tool") show("#dl-context", `Pi used ${event.name}`);
    if (event.type === "tool-error") show("#dl-context", `${event.name}: ${event.message}`);
    if (event.type === "error") show("#dl-context", event.message);
    if (event.type === "done") show("#dl-context", "Complete");
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
