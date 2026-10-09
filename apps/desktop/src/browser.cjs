const { WebContentsView } = require("electron");

function browserUrl(raw) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 2048)
    throw new Error("Enter a web address.");
  const address = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(address) && !/^https?:\/\//i.test(address)) {
    throw new Error("Only HTTP and HTTPS pages can open in the desktop browser.");
  }
  const value = /^https?:\/\//i.test(address) ? address : `https://${address}`;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid web address.");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Only HTTP and HTTPS pages can open in the desktop browser.");
  return url.toString();
}

class DesktopBrowser {
  constructor(window, onState) {
    this.window = window;
    this.onState = onState;
    this.view = null;
    this.visible = false;
  }

  ensure() {
    if (this.view) return this.view;
    const view = new WebContentsView({
      webPreferences: {
        partition: "persist:ditto-browser",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    view.webContents.setWindowOpenHandler(({ url }) => {
      try {
        void this.navigate(browserUrl(url)).catch(() => {});
      } catch {
        /* Reject non-web popups. */
      }
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, url) => {
      try {
        browserUrl(url);
      } catch {
        event.preventDefault();
      }
    });
    for (const event of [
      "did-navigate",
      "did-navigate-in-page",
      "page-title-updated",
      "did-fail-load",
    ]) {
      view.webContents.on(event, () => this.onState(this.status()));
    }
    this.view = view;
    return view;
  }

  status() {
    const contents = this.view?.webContents;
    return {
      visible: this.visible,
      url: contents?.getURL() || "",
      title: contents?.getTitle() || "Browser",
      canGoBack: Boolean(contents?.navigationHistory.canGoBack()),
      canGoForward: Boolean(contents?.navigationHistory.canGoForward()),
    };
  }

  show(bounds) {
    const view = this.ensure();
    if (!this.visible) this.window.contentView.addChildView(view);
    this.visible = true;
    const size = this.window.getContentBounds();
    view.setBounds({
      x: Math.max(0, Math.floor(bounds.x)),
      y: Math.max(0, Math.floor(bounds.y)),
      width: Math.max(1, Math.min(Math.floor(bounds.width), size.width)),
      height: Math.max(1, Math.min(Math.floor(bounds.height), size.height)),
    });
    this.onState(this.status());
    return this.status();
  }

  hide() {
    if (this.view && this.visible) this.window.contentView.removeChildView(this.view);
    this.visible = false;
    this.onState(this.status());
  }

  async navigate(raw) {
    const url = browserUrl(raw);
    await this.ensure().webContents.loadURL(url);
    this.onState(this.status());
    return this.status();
  }

  back() {
    if (this.view?.webContents.navigationHistory.canGoBack())
      this.view.webContents.navigationHistory.goBack();
    return this.status();
  }
  forward() {
    if (this.view?.webContents.navigationHistory.canGoForward())
      this.view.webContents.navigationHistory.goForward();
    return this.status();
  }
  reload() {
    this.view?.webContents.reload();
    return this.status();
  }

  async snapshot() {
    if (!this.view?.webContents.getURL()) throw new Error("Open a page before inspecting it.");
    return this.view.webContents.executeJavaScript(`(() => {
      const controls = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')].slice(0, 150);
      return { title: document.title, url: location.href,
        text: (document.body?.innerText || '').slice(0, 12000),
        controls: controls.map((node, index) => {
          const ref = 'd' + (index + 1); node.setAttribute('data-ditto-ref', ref);
          return { ref, role: node.getAttribute('role') || node.tagName.toLowerCase(),
            name: (node.getAttribute('aria-label') || node.innerText || node.getAttribute('placeholder') || '').trim().slice(0, 120),
            href: node.tagName === 'A' ? node.href : undefined };
        }) };
    })()`);
  }

  async click(ref) {
    if (!/^d\d{1,3}$/.test(ref))
      throw new Error("Inspect the page and use a listed element reference.");
    const rect = await this.ensure().webContents.executeJavaScript(`(() => {
      const node = document.querySelector('[data-ditto-ref="${ref}"]');
      if (!node) return null;
      node.scrollIntoView({ block: 'center' });
      const r = node.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), width: r.width, height: r.height };
    })()`);
    if (!rect || rect.width <= 0 || rect.height <= 0)
      throw new Error("The referenced control is no longer visible. Inspect again.");
    const debuggerClient = this.view.webContents.debugger;
    if (!debuggerClient.isAttached()) debuggerClient.attach("1.3");
    await debuggerClient.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: rect.x,
      y: rect.y,
    });
    await debuggerClient.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: rect.x,
      y: rect.y,
      button: "left",
      clickCount: 1,
    });
    await debuggerClient.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: rect.x,
      y: rect.y,
      button: "left",
      clickCount: 1,
    });
    return this.status();
  }

  async fill(ref, value) {
    if (!/^d\d{1,3}$/.test(ref) || typeof value !== "string" || value.length > 10000)
      throw new Error("Use a listed field and shorter text.");
    const result = await this.ensure().webContents.executeJavaScript(`(() => {
      const node = document.querySelector('[data-ditto-ref="${ref}"]');
      if (!node || !['INPUT', 'TEXTAREA'].includes(node.tagName)) return false;
      node.focus();
      const setter = Object.getOwnPropertyDescriptor(node.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value').set;
      setter.call(node, ${JSON.stringify(value)});
      node.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(value)} }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!result) throw new Error("The referenced field is no longer available. Inspect again.");
    return this.status();
  }

  close() {
    this.hide();
    this.view?.webContents.close();
    this.view = null;
  }
}

module.exports = { DesktopBrowser };
