// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the Node filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ChannelAccountId, ChannelConversationId, ChannelMessageId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  type KnowledgePacketSource,
  materializeKnowledgePacket,
  resolveKnowledgePacketWorktreePath,
} from "./KnowledgePacketWriter.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

function minimalSource(text: string): KnowledgePacketSource {
  return {
    requestedMessageLimit: 10,
    conversation: {
      accountId: ChannelAccountId.make("discord:local"),
      conversationId: ChannelConversationId.make("liam-dm"),
      service: "discord",
      title: "Liam",
      kind: "direct",
      participants: [],
      completeness: "provider_scoped",
    },
    messages: [
      {
        accountId: ChannelAccountId.make("discord:local"),
        conversationId: ChannelConversationId.make("liam-dm"),
        messageId: ChannelMessageId.make("message-1"),
        service: "discord",
        sender: { id: "liam", displayName: "Liam" },
        text,
        sentAt: "2026-08-29T12:00:00.000Z",
        attachments: [],
      },
    ],
  };
}

function sourceWithRemoteAttachment(remoteUrl: string): KnowledgePacketSource {
  return {
    requestedMessageLimit: 10,
    conversation: {
      accountId: ChannelAccountId.make("discord:local"),
      conversationId: ChannelConversationId.make("liam-dm"),
      service: "discord",
      title: "Liam",
      kind: "direct",
      participants: [],
      completeness: "provider_scoped",
    },
    messages: [
      {
        accountId: ChannelAccountId.make("discord:local"),
        conversationId: ChannelConversationId.make("liam-dm"),
        messageId: ChannelMessageId.make("message-1"),
        service: "discord",
        sender: { id: "liam", displayName: "Liam" },
        text: "Here is the log.",
        sentAt: "2026-08-29T12:00:00.000Z",
        attachments: [
          {
            id: "attachment-1",
            filename: "message.txt",
            mediaType: "text/plain; charset=utf-8",
            remoteUrl,
          },
        ],
      },
    ],
  };
}

async function gitWorktree(prefix: string): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  roots.push(root);
  await NodeFSP.mkdir(NodePath.join(root, ".git", "info"), { recursive: true });
  return root;
}

describe("materializeKnowledgePacket", () => {
  it("uses a new worktree when prepared and otherwise writes into the current checkout", () => {
    expect(
      resolveKnowledgePacketWorktreePath({
        preparedWorktreePath: "/worktrees/new-task",
        currentCheckoutPath: "/repos/current-checkout",
      }),
    ).toBe("/worktrees/new-task");
    expect(
      resolveKnowledgePacketWorktreePath({
        preparedWorktreePath: null,
        currentCheckoutPath: "/repos/current-checkout",
      }),
    ).toBe("/repos/current-checkout");
  });

  it("writes a bounded, git-ignored packet with transcript provenance and localized attachments", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-packet-"));
    roots.push(root);
    await NodeFSP.mkdir(NodePath.join(root, ".git", "info"), {
      recursive: true,
    });
    await NodeFSP.writeFile(NodePath.join(root, ".git", "info", "exclude"), "# local excludes\n");
    const cache = NodePath.join(root, "cache");
    await NodeFSP.mkdir(cache);
    const bytes = Buffer.from("actual private attachment bytes");
    await NodeFSP.writeFile(NodePath.join(cache, "discord-cached.png"), bytes);

    const result = await materializeKnowledgePacket({
      worktreePath: root,
      attachmentsDir: cache,
      taskId: "thread-1-turn-1",
      source: {
        requestedMessageLimit: 2,
        conversation: {
          accountId: ChannelAccountId.make("discord:local"),
          conversationId: ChannelConversationId.make("liam-dm"),
          service: "discord",
          title: "@Liam",
          kind: "direct",
          participants: [
            { id: "self", displayName: "Peyton", isSelf: true },
            { id: "liam", displayName: "Liam", handle: "@Liam" },
          ],
          completeness: "device_cache_partial",
        },
        messages: [
          {
            accountId: ChannelAccountId.make("discord:local"),
            conversationId: ChannelConversationId.make("liam-dm"),
            messageId: ChannelMessageId.make("old-omitted"),
            service: "discord",
            sender: { id: "self", displayName: "Peyton", isSelf: true },
            text: "omit me",
            sentAt: "2026-08-29T10:00:00.000Z",
            attachments: [],
          },
          {
            accountId: ChannelAccountId.make("discord:local"),
            conversationId: ChannelConversationId.make("liam-dm"),
            messageId: ChannelMessageId.make("one"),
            service: "discord",
            sender: { id: "liam", displayName: "Liam" },
            text: "Please inspect the worker.",
            sentAt: "2026-08-29T11:00:00.000Z",
            attachments: [
              {
                id: "cached",
                filename: "trace image.png",
                mediaType: "image/png",
                cachedAttachmentId: "discord-cached",
                remoteUrl: "https://cdn.discordapp.com/attachments/channel/cached/trace.png",
              },
              {
                id: "unavailable",
                filename: "gone.txt",
                mediaType: "text/plain",
              },
            ],
            rawPermalink: "https://discord.com/channels/@me/liam-dm/one",
          },
          {
            accountId: ChannelAccountId.make("discord:local"),
            conversationId: ChannelConversationId.make("liam-dm"),
            messageId: ChannelMessageId.make("two"),
            service: "discord",
            sender: { id: "self", displayName: "Peyton", isSelf: true },
            text: "I will send a coding agent.",
            sentAt: "2026-08-29T12:00:00.000Z",
            attachments: [],
          },
        ],
      },
    });

    expect(result.messageCount).toBe(2);
    expect(result.attachmentCount).toBe(1);
    const transcript = await NodeFSP.readFile(
      NodePath.join(result.absolutePath, "transcript.md"),
      "utf8",
    );
    expect(transcript).toContain("Please inspect the worker.");
    expect(transcript).toContain("I will send a coding agent.");
    expect(transcript).not.toContain("omit me");
    expect(transcript).toContain("[source](https://discord.com/channels/@me/liam-dm/one)");
    expect(transcript).toContain(NodeCrypto.createHash("sha256").update(bytes).digest("hex"));
    const manifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(result.absolutePath, "manifest.json"), "utf8"),
    );
    expect(manifest.scope).toMatchObject({
      messageCount: 2,
      requestedMessageLimit: 2,
      truncated: true,
    });
    expect(manifest.attachments[0]).toMatchObject({
      status: "localized",
      sizeBytes: bytes.length,
      sourceMessageAt: "2026-08-29T11:00:00.000Z",
      originalUrl: "https://cdn.discordapp.com/attachments/channel/cached/trace.png",
    });
    expect(manifest.source.participants).toEqual([
      { id: "self", displayName: "Peyton", isSelf: true },
      { id: "liam", displayName: "Liam", handle: "@Liam" },
    ]);
    expect(manifest.errors).toEqual([
      {
        messageId: "one",
        attachmentId: "unavailable",
        detail: "No accessible local file or supported Discord media URL.",
      },
    ]);
    expect(
      await NodeFSP.readFile(NodePath.join(root, ".git", "info", "exclude"), "utf8"),
    ).toContain("/.t3/knowledge-packets/");
    expect(
      await NodeFSP.readFile(NodePath.join(root, ".t3", "knowledge-packets", ".gitignore"), "utf8"),
    ).toContain("Knowledge packets are private local task context");
  });

  it("retries on the Discord CDN when the media proxy refuses a non-image attachment", async () => {
    const root = await gitWorktree("t3-packet-cdn-");
    const bytes = Buffer.from("the real attachment text");
    const requestedHosts: string[] = [];

    const result = await materializeKnowledgePacket({
      worktreePath: root,
      attachmentsDir: NodePath.join(root, "cache"),
      taskId: "thread-1-turn-1",
      fetch: (input) => {
        const url = new URL(String(input));
        requestedHosts.push(url.hostname);
        return Promise.resolve(
          url.hostname === "media.discordapp.net"
            ? new Response(null, { status: 415, statusText: "Unsupported Media Type" })
            : new Response(bytes, { status: 200 }),
        );
      },
      source: sourceWithRemoteAttachment(
        "https://media.discordapp.net/attachments/1/2/message.txt?ex=a&is=b&hm=c",
      ),
    });

    expect(requestedHosts).toEqual(["media.discordapp.net", "cdn.discordapp.com"]);
    expect(result.attachmentCount).toBe(1);
    const manifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(result.absolutePath, "manifest.json"), "utf8"),
    );
    expect(manifest.attachments[0]).toMatchObject({
      status: "localized",
      sizeBytes: bytes.length,
    });
    expect(manifest.errors).toEqual([]);
  });

  it("records the HTTP status when an attachment cannot be downloaded", async () => {
    const root = await gitWorktree("t3-packet-http-error-");

    const result = await materializeKnowledgePacket({
      worktreePath: root,
      attachmentsDir: NodePath.join(root, "cache"),
      taskId: "thread-1-turn-1",
      fetch: () => Promise.resolve(new Response(null, { status: 404, statusText: "Not Found" })),
      source: sourceWithRemoteAttachment(
        "https://cdn.discordapp.com/attachments/1/2/message.txt?ex=a&is=b&hm=c",
      ),
    });

    expect(result.attachmentCount).toBe(0);
    const manifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(result.absolutePath, "manifest.json"), "utf8"),
    );
    expect(manifest.errors[0]?.detail).toBe("cdn.discordapp.com returned HTTP 404 Not Found.");
  });

  it("reports the size limit only when the attachment actually exceeds it", async () => {
    const root = await gitWorktree("t3-packet-too-large-");

    const result = await materializeKnowledgePacket({
      worktreePath: root,
      attachmentsDir: NodePath.join(root, "cache"),
      taskId: "thread-1-turn-1",
      fetch: () =>
        Promise.resolve(
          new Response(Buffer.from("body"), {
            status: 200,
            headers: { "content-length": String(26 * 1024 * 1024) },
          }),
        ),
      source: sourceWithRemoteAttachment(
        "https://cdn.discordapp.com/attachments/1/2/message.txt?ex=a&is=b&hm=c",
      ),
    });

    expect(result.attachmentCount).toBe(0);
    const manifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(result.absolutePath, "manifest.json"), "utf8"),
    );
    expect(manifest.errors[0]?.detail).toBe("The attachment exceeded the 25 MB file limit.");
  });

  it("fails closed outside a Git worktree so private packets cannot become visible files", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-packet-no-git-"));
    roots.push(root);
    await expect(
      materializeKnowledgePacket({
        worktreePath: root,
        attachmentsDir: NodePath.join(root, "cache"),
        taskId: "thread-1-turn-1",
        source: {
          requestedMessageLimit: 10,
          conversation: {
            accountId: ChannelAccountId.make("discord:local"),
            conversationId: ChannelConversationId.make("liam-dm"),
            service: "discord",
            title: "Liam",
            kind: "direct",
            participants: [],
            completeness: "device_cache_partial",
          },
          messages: [],
        },
      }),
    ).rejects.toThrow();
  });

  it("isolates concurrent task packets and changes identity when message content changes", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-packet-isolation-"));
    roots.push(root);
    await NodeFSP.mkdir(NodePath.join(root, ".git", "info"), { recursive: true });

    const first = await materializeKnowledgePacket({
      worktreePath: root,
      attachmentsDir: NodePath.join(root, "cache"),
      taskId: "thread-a-turn-a",
      source: minimalSource("First version"),
    });
    const otherTask = await materializeKnowledgePacket({
      worktreePath: root,
      attachmentsDir: NodePath.join(root, "cache"),
      taskId: "thread-b-turn-a",
      source: minimalSource("First version"),
    });
    const edited = await materializeKnowledgePacket({
      worktreePath: root,
      attachmentsDir: NodePath.join(root, "cache"),
      taskId: "thread-a-turn-a",
      source: minimalSource("Edited version"),
    });

    expect(first.relativePath).not.toBe(otherTask.relativePath);
    expect(first.packetId).not.toBe(edited.packetId);
    expect(
      await NodeFSP.readFile(NodePath.join(first.absolutePath, "transcript.md"), "utf8"),
    ).toContain("First version");
    expect(
      await NodeFSP.readFile(NodePath.join(edited.absolutePath, "transcript.md"), "utf8"),
    ).toContain("Edited version");
  });

  it("refuses a repository-controlled symlink for the private packet directory", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-packet-symlink-"));
    roots.push(root);
    await NodeFSP.mkdir(NodePath.join(root, ".git", "info"), { recursive: true });
    const outside = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-packet-outside-"));
    roots.push(outside);
    await NodeFSP.symlink(outside, NodePath.join(root, ".t3"));

    await expect(
      materializeKnowledgePacket({
        worktreePath: root,
        attachmentsDir: NodePath.join(root, "cache"),
        taskId: "thread-1-turn-1",
        source: {
          requestedMessageLimit: 10,
          conversation: {
            accountId: ChannelAccountId.make("discord:local"),
            conversationId: ChannelConversationId.make("liam-dm"),
            service: "discord",
            title: "Liam",
            kind: "direct",
            participants: [],
            completeness: "device_cache_partial",
          },
          messages: [],
        },
      }),
    ).rejects.toThrow("Private packet path is not a regular directory");
    expect(await NodeFSP.readdir(outside)).toEqual([]);
  });

  it("writes the exclude rule to the common Git directory for linked worktrees", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-packet-linked-"));
    roots.push(root);
    const common = NodePath.join(root, "common.git");
    const worktreeGit = NodePath.join(common, "worktrees", "task");
    const worktree = NodePath.join(root, "task");
    await NodeFSP.mkdir(worktreeGit, { recursive: true });
    await NodeFSP.mkdir(worktree, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(worktree, ".git"), `gitdir: ${worktreeGit}\n`);
    await NodeFSP.writeFile(NodePath.join(worktreeGit, "commondir"), "../..\n");

    await materializeKnowledgePacket({
      worktreePath: worktree,
      attachmentsDir: NodePath.join(root, "cache"),
      taskId: "thread-1-turn-1",
      source: {
        requestedMessageLimit: 10,
        conversation: {
          accountId: ChannelAccountId.make("discord:local"),
          conversationId: ChannelConversationId.make("liam-dm"),
          service: "discord",
          title: "Liam",
          kind: "direct",
          participants: [],
          completeness: "device_cache_partial",
        },
        messages: [],
      },
    });

    expect(await NodeFSP.readFile(NodePath.join(common, "info", "exclude"), "utf8")).toContain(
      "/.t3/knowledge-packets/",
    );
  });
});
