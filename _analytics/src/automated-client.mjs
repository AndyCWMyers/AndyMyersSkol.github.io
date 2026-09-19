// Self-identification only, never a conclusion based on geography or missing JS.
const CLIENTS = [
  [/\bMistralFrozenResearch\b/i, "MistralFrozenResearch"],
  [/\bClaude-User\b/i, "Claude-User"],
  [/\bgrok-search-verify\b/i, "grok-search-verify"],
  [/\bDocoloc\b/i, "Docoloc"],
  [/\bChatGPT-User\b/i, "ChatGPT-User"],
  [/\b(?:GPTBot|OAI-SearchBot|PetalBot|bingbot|PerplexityBot|Slackbot|Reflectionbot|ShapBot)\b/i, null],
  [/\b(?:meta-externalagent|meta-webindexer|facebookexternalhit)\b/i, null],
];

export function automatedClient(userAgent = "") {
  for (const [pattern, label] of CLIENTS) {
    const match = userAgent.match(pattern);
    if (match) return label || match[0];
  }
  return "";
}
