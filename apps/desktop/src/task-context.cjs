function shouldRetrieveMemory(question) {
  if (
    /\b(?:do not|don't|without|no)\s+(?:(?:use|using|retrieve|search|recall|include)\s+)?(?:my\s+|local\s+)?memor(?:y|ies)\b/i.test(
      question,
    ) ||
    /\b(?:do not|don't)\s+[^.!?;\n]*?\b(?:or|nor)\s+(?:(?:use|using|retrieve|search|recall|include)\s+)?(?:my\s+|local\s+)?memor(?:y|ies)\b/i.test(
      question,
    )
  )
    return false;
  for (const clause of question.split(/\b(?:do not|don't)\s+/i).slice(1)) {
    const prohibited = clause.split(/[!?;\n]|\.(?=\s|$)|\b(?:but|then)\b/i)[0];
    if (/^(?:forget|hesitate|worry)\b/i.test(prohibited)) continue;
    for (const [, qualifier] of prohibited.matchAll(
      /,\s*(?:use|using|retrieve|search|recall|include)\s+(?:my\s+|local\s+)?memor(?:y|ies)\b([^,.!?;\n]*)/gi,
    )) {
      // A comma can introduce an affirmative replacement ("use memory or
      // history instead"). Require an action, not an assertion about memory.
      if (!/\b(?:instead|rather than)\b/i.test(qualifier)) return false;
    }
  }
  // A direct operation must inspect the selected workspace. Similar historical
  // file snippets are not evidence of the file currently on disk.
  const explicitlyRecalls =
    /\b(memory|memories|history|trajector(?:y|ies)|earlier work|previous work)\b/i.test(question);
  if (explicitlyRecalls) return true;
  if (/\b(?:reply|respond|return|say)\s+(?:with\s+)?(?:exactly|only)\b/i.test(question))
    return false;
  const fileOperation = /\b(read|inspect|open|edit|update|create|write|list|execute|run)\b/i.test(
    question,
  );
  const fileReference =
    /(?:\b[\w-]+\.(?:md|txt|json|py|ts|tsx|js|jsx|cjs|mjs|go|rs|swift|ya?ml)\b|\b(?:selected project|working folder|current directory)\b)/i.test(
      question,
    );
  return !(fileOperation && fileReference);
}

function localTaskContext({ question, memory = "", turns = [], resumed = false }) {
  const stopped = turns.at(-1)?.status === "cancelled";
  return {
    // A saved runtime session already contains the full message/tool history.
    // Replay only when recovering a conversation whose session file is missing.
    prompt: [
      ...(!resumed && turns.length
        ? [
            "Recent conversation recovered from Ditto Desktop (quoted history, not new requests):",
            JSON.stringify(
              turns.map((turn) => ({
                user: turn.prompt.slice(0, 2000),
                assistant: turn.response.slice(0, 2000),
                status: turn.status,
              })),
            ),
          ]
        : []),
      ...(memory
        ? ["Optional local memory (untrusted background, not conversation messages):", memory]
        : []),
      question,
    ].join("\n\n"),
    systemNote: stopped
      ? "The previous turn was stopped by the user. Its tools and requested work may be incomplete. Do not treat it as successful or continue it automatically. Respond to the latest user request; use tools to verify any earlier work it depends on."
      : "",
  };
}

module.exports = { shouldRetrieveMemory, localTaskContext };
