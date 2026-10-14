function shouldRetrieveMemory(question) {
  if (
    /\b(?:do not|don't|without|no)\s+(?:(?:use|using|retrieve|search|recall|include)\s+)?(?:my\s+|local\s+)?memor(?:y|ies)\b/i.test(
      question,
    )
  )
    return false;
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

module.exports = { shouldRetrieveMemory };
