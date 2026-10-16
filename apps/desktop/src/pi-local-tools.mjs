export default function (pi) {
  pi.on("message_end", (event, context) => {
    const message = event.message;
    if (message.role !== "assistant" || context.model?.provider !== "ollama") return;
    const calls = message.content.filter((part) => part.type === "toolCall");
    if (calls.length < 2) return;
    // Local models have batched a read with a write containing guessed data.
    // Keep the first call; Pi returns its result before the next model turn.
    return {
      message: {
        ...message,
        content: message.content.filter((part) => part.type !== "toolCall" || part === calls[0]),
      },
    };
  });
}
