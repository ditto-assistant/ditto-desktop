# Discord Accessibility reply transport

The macOS Discord reply transport is an explicit-user-action companion to the
read-only Discrawl cache adapter. It deliberately has no Discord credential,
token, cookie, DOM injection, or private API access.

## Trust boundary

The renderer sends a typed `DiscordAccessibilityReplyInput` through the
sandboxed preload bridge. The desktop main process validates the target as an
exact Discord channel deep link, deduplicates completed action IDs, owns timeout
and cancellation, and invokes the bundled native helper over one JSON stdin /
stdout exchange. The helper independently validates the deep link.

The helper uses Accessibility only to:

1. locate a single Discord text composer;
2. compare its placeholder/description with the expected conversation title;
3. set the draft value; and
4. invoke `AXConfirm`, or post a Return key through the verified focused AX
   composer when that semantic action is absent, then verify that Discord
   cleared the composer afterward.

It does not traverse or return message contents. A deep link plus one uniquely
matching composer is the minimum target proof. Ambiguous or missing matches
fail closed before text insertion. When `AXConfirm` is absent or cannot be
verified, the result is `draft_prepared`, never an assumed send.

### Why names are not resolved through Accessibility

Server and channel names belong to the Discrawl/local transport metadata path.
This helper reads only the candidate composer's descriptor needed to verify the
already-selected exact target. It does not enumerate Discord's server list,
channel tree, or direct-message list—even after an explicit action. Doing so
would turn a narrowly scoped send capability into an unstable Accessibility
scraper and broaden the permission boundary substantially.

Discrawl placeholder guild or channel names therefore need to be corrected in
the archive metadata resolver, outside this transport. A missing display name
must not be inferred from Discord's Accessibility tree.

Every result is an audit receipt containing the action ID, origin, requested
mode, timestamps, permission state, outcome, and whether a draft or confirmed
send occurred. Receipts are deduplicated for the lifetime of the desktop
process. Durable cross-restart idempotency belongs in the authenticated
companion command queue before remote replies are enabled.

## Remote-ready contract

`origin: remote_user_action` reserves the phone/web path. A future signed-in
companion endpoint must accept only a concrete authenticated user command,
assign or preserve a stable action ID, and deliver it to this same executor on
the user's Mac. It must not turn cloud mirroring, an agent turn, a scheduled
job, or a retry worker into authority to send. Delivery retries may repeat the
same action ID only.

## Packaging and limitations

The helper is compiled for the target macOS architecture during desktop
artifact staging and copied to `Resources/discord-accessibility`. Development
builds compile a host helper under `apps/desktop/.native`. Signed release QA
must verify that the nested helper is signed and that macOS attributes the
Accessibility permission prompt to the expected Ditto installation.

Discord's Accessibility tree is not a stable public API. Labels or confirm
actions can change between Discord releases, in which case the transport
degrades to no-op or prepared-draft behavior. Opening a `discord://` deep link
may briefly activate Discord before focus returns to Ditto. MIT licensing of
Ditto does not grant rights under Discord's terms or make UI automation an
official Discord integration; product/legal review remains separate.
