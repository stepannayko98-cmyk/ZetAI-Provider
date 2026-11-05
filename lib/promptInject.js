'use strict';
/** Returns a new messages array with custom system prompt injected (never mutates input). */
function injectSystemPrompt(messages, customPrompt) {
  if (!Array.isArray(messages)) return messages;
  if (!customPrompt || !String(customPrompt).trim()) return messages;
  const out = messages.map((m) => ({ ...m }));
  const first = out[0];
  if (first && first.role === 'system') {
    if (Array.isArray(first.content)) {
      first.content = [{ type: 'text', text: customPrompt + '\n\n' }, ...first.content];
    } else {
      first.content = customPrompt + '\n\n' + (first.content ?? '');
    }
  } else {
    out.unshift({ role: 'system', content: customPrompt });
  }
  return out;
}
/** For legacy /v1/completions: prepend to prompt. */
function injectIntoPrompt(prompt, customPrompt) {
  if (!customPrompt || !String(customPrompt).trim()) return prompt;
  if (typeof prompt === 'string') return customPrompt + '\n\n' + prompt;
  if (Array.isArray(prompt) && prompt.every((p) => typeof p === 'string')) return prompt.map((p) => customPrompt + '\n\n' + p);
  return prompt;
}
module.exports = { injectSystemPrompt, injectIntoPrompt };
