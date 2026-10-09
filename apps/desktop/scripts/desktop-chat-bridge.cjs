// Desktop adds a native transport to the pinned web UI. Fail closed when an
// upstream anchor changes; build-web restores every overlaid file afterwards.
function replace(source, anchor, value) {
  if (!source.includes(anchor))
    throw new Error(`The upstream chat UI changed: ${anchor.slice(0, 90)}`);
  return source.replace(anchor, value);
}
const localImport = (names) => `import { ${names} } from "@/desktop/local-chats"\n`;
function sidebarOverlay(source) {
  source =
    localImport(
      "initializeLocalChannels, localSessions, localServices, localServiceName, LocalChatRows, LocalChatRow, isLocalSessionID",
    ) + source;
  source = replace(source, 'value={view() === "all" ? "apps" : view()}', "value={view()}");
  source = replace(
    source,
    '{view() === "recent" ? t(msg("One list")) : t(msg("By app"))}',
    '{view() === "all" ? t(msg("All chats")) : view() === "recent" ? t(msg("One list")) : t(msg("By app"))}',
  );
  source = replace(
    source,
    "  const appGroups = createMemo(() => {",
    "  initializeLocalChannels()\n  const appGroups = createMemo(() => {",
  );
  source = replace(
    source,
    "    return [...groups.values()].sort(",
    `    for (const provider of localServices) {
      if (!groups.has(provider)) groups.set(provider, { id: provider, label: localServiceName(provider), provider, rows: [], total: 1 })
    }
    return [...groups.values()].sort(`,
  );
  source = replace(
    source,
    "    const lane = useAppScopedThreads({",
    '    const [groupSearch, setGroupSearch] = createSignal("")\n    const lane = useAppScopedThreads({',
  );
  source = replace(
    source,
    '      search: () => "",\n      enabled: () => !!group.scoped',
    "      search: groupSearch,\n      enabled: () => !!group.scoped",
  );
  source = replace(
    source,
    "    const visibleRows = createMemo(() => {",
    "    const [localLimit, setLocalLimit] = createSignal(30)\n    const matchesSearch = (row: Session) => row.title.toLowerCase().includes(groupSearch().trim().toLowerCase())\n    const nativeRows = createMemo(() => localSessions().filter((row) => row.metadata?.provider === group.provider && matchesSearch(row)))\n    const visibleRows = createMemo(() => {",
  );
  source = replace(
    source,
    "      const rows = dedupeSessions([...group.rows, ...lane.sessions()]).filter(",
    "      const rows = dedupeSessions([...group.rows, ...lane.sessions(), ...nativeRows().slice(0, localLimit())]).filter(",
  );
  source = replace(
    source,
    "enabled: () => !!group.scoped && !isCollapsed(),",
    'enabled: () => !!group.scoped && !isCollapsed() && group.provider !== "imessage",',
  );
  source = replace(
    source,
    "      return sortRows(rows)\n    })",
    "      return sortRows(rows.filter(matchesSearch))\n    })",
  );
  source = replace(
    source,
    "    const displayTitle = () => row.displayTitle || title(row.session())",
    `    if (isLocalSessionID(row.session().id)) return <LocalChatRow session={row.session()} onNavigate={props.onNavigate}/>
    const displayTitle = () => row.displayTitle || title(row.session())`,
  );
  source = replace(
    source,
    "            <Show\n              when={group.scoped && lane.isPending()",
    `            <LocalChatRows provider={group.provider} showConversations={false} onNavigate={props.onNavigate}/>
            <Show
              when={group.scoped && lane.isPending()`,
  );
  source = replace(
    source,
    "          <div id={contentId()} hidden={isCollapsed()}>",
    `          <div id={contentId()} hidden={isCollapsed()}>
            <Show when={group.provider}>
              <input class="ditto-chat-search" type="search" placeholder={\`Search \${group.label} chats\`} aria-label={\`Search \${group.label} chats\`}
                value={groupSearch()} onInput={(event) => { setGroupSearch(event.currentTarget.value); setLocalLimit(30) }}/>
            </Show>`,
  );
  source = replace(
    source,
    "            <Show when={group.scoped}>\n              <InfiniteListSentinel",
    `            <Show when={nativeRows().length > localLimit()}>
              <button type="button" class="v2-studio-sidebar-retry" onClick={() => setLocalLimit((value) => value + 30)}>Show more local chats</button>
            </Show>
            <Show when={group.scoped}>
              <InfiniteListSentinel`,
  );
  source = replace(
    source,
    "      rows().filter((session) => !session.pinned && !inCustomSection(session))",
    "      [...rows(), ...localSessions()].filter((session) => !session.pinned && !inCustomSection(session))",
  );
  return source;
}
function feedOverlay(source) {
  source = localImport("localSelection, LocalChatSurface") + source;
  source = replace(
    source,
    "  const showComposer = () =>",
    "  const showComposer = () => !localSelection() &&",
  );
  source = replace(
    source,
    "<Switch>\n          {/*",
    `<Switch>
          <Match when={localSelection() && (mainSurface() === "chat" || mainSurface() === "new-chat")}>
            <Suspense fallback={<V2ConnectorChatSkeleton/>}><LocalChatSurface/></Suspense>
          </Match>
          {/*`,
  );
  source = replace(
    source,
    '"has-inline-connector": !!connectorChatSession()',
    '"has-inline-connector": !!connectorChatSession() || !!localSelection()',
  );
  return source;
}
function surfaceOverlay(source) {
  source = localImport("isLocalSessionID, localConnection, useLocalConnectorMessages") + source;
  source = replace(
    source,
    "  const t = useT()\n  const { user, accountScopedStateVersion }",
    "  const local = () => isLocalSessionID(props.session.id)\n  const t = useT()\n  const { user, accountScopedStateVersion }",
  );
  source = replace(
    source,
    "  const thread = useConnectorMessages(() => props.session.id, {",
    "  const thread = (local() ? useLocalConnectorMessages : useConnectorMessages)(() => props.session.id, {",
  );
  source = replace(
    source,
    "  const connections = useConnectorConnections()",
    "  const connections = useConnectorConnections(() => !local())",
  );
  source = replace(
    source,
    "  useConnectorAutoSync(() => props.session)",
    "  useConnectorAutoSync(() => local() ? null : props.session)",
  );
  source = replace(
    source,
    "  const connection = createMemo(() => {",
    "  const connection = createMemo(() => {\n    if (local()) return localConnection(props.session)",
  );
  source = replace(
    source,
    "connectorsEnabled: connectorsEnabled(),",
    "connectorsEnabled: local() || connectorsEnabled(),",
  );
  source = replace(
    source,
    "sendEnabled: sendFlagEnabled(),",
    "sendEnabled: local() || sendFlagEnabled(),",
  );
  source = replace(
    source,
    "    if (!composer().enabled) return\n    const now = Date.now()",
    "    if (local() || !composer().enabled) return\n    const now = Date.now()",
  );
  source = replace(
    source,
    "    () => props.session.id,\n    mentionsRequested",
    "    () => local() ? null : props.session.id,\n    mentionsRequested",
  );
  source = replace(
    source,
    "  const attachDisabledReason = (): string => {",
    '  const attachDisabledReason = (): string => {\n    if (local()) return "Local chats currently send text only"',
  );
  source = replace(
    source,
    "  const attachFiles = (incoming: readonly File[]): void => {",
    '  const attachFiles = (incoming: readonly File[]): void => {\n    if (local()) { toast.error("Local chats currently send text only"); return }',
  );
  source = replace(
    source,
    "<Show when={!props.privateMode && !props.externalDestinationToggle}>",
    "<Show when={!local() && !props.privateMode && !props.externalDestinationToggle}>",
  );
  return source;
}
function coordinatorOverlay(source) {
  source = localImport("clearLocalSelection, isLocalSessionID, openLocalSession") + source;
  source = replace(
    source,
    "  const openThread = (threadId: string): void => {",
    `  const openThread = (threadId: string): void => {
    if (isLocalSessionID(threadId)) { openChatDirectory(); openLocalSession(threadId); return }`,
  );
  return replace(
    source,
    "runAfterSurfaceLeave(() => batch(() => action(...args)))",
    "runAfterSurfaceLeave(() => batch(() => { clearLocalSelection(); action(...args) }))",
  );
}
function connectorHelpersOverlay(source) {
  return replace(
    source,
    'const exists = (message.messageId ?? "").trim().length > 0',
    'const exists = (message.messageId ?? "").trim().length > 0 && !(message.messageId ?? "").startsWith("desktop-local:")',
  );
}
function contactsOverlay(source) {
  source = localImport("localServices, localServiceName, LocalChatRows") + source;
  source = replace(
    source,
    "    const projections = [",
    `    for (const provider of localServices) {
      if (!original.some((contact) => contact.provider === provider)) original.push({
        id: "app:" + provider, kind: "app", provider, logoKey: provider, name: localServiceName(provider), subtitle: "",
        conversations: [], threads: [], threadCount: 1, status: "active", updatedAt: "",
      })
    }
    const projections = [`,
  );
  source = replace(
    source,
    "  const groupSize = (contact: V2ChatContact, loaded: number): number => {",
    "  const groupSize = (contact: V2ChatContact, loaded: number): number => {\n    if (localServices.some((provider) => provider === contact.provider)) loaded = Math.max(loaded, 1)",
  );
  source = replace(
    source,
    '<div class={props.compact ? undefined : "v2-chat-contact-scoped"}>',
    '<div class={props.compact ? undefined : "v2-chat-contact-scoped"}>\n      <LocalChatRows provider={props.contact.provider} search={search()}/>',
  );
  source = replace(
    source,
    "    search,\n  })",
    '    search,\n    enabled: () => props.contact.provider !== "imessage",\n  })',
  );
  source = replace(
    source,
    "              <Show when={!grouped()}>\n                <ConversationList",
    "              <Show when={!grouped()}>\n                <For each={localServices}>{(provider) => <LocalChatRows provider={provider} search={normalizedSearchQuery()} showSetup={false} onNavigate={props.onNavigate}/>}</For>\n                <ConversationList",
  );
  return source;
}
module.exports = {
  sidebarOverlay,
  feedOverlay,
  surfaceOverlay,
  coordinatorOverlay,
  connectorHelpersOverlay,
  contactsOverlay,
};
