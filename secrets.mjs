const SECRET_PATTERNS = [
  { name: 'openai-like', re: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}\b/g },
  { name: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'github', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'slack', re: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g },
  { name: 'aws', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'google', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: 'bearer', re: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/g, capture: true },
  { name: 'labeled-key', re: /(?:api[_ -]?key|apikey|secret|token|密钥|秘钥|api\s*key)\s*[:：=]\s*([A-Za-z0-9._~+/=-]{16,})/gi, capture: true },
  { name: 'long-hex', re: /\b[0-9a-f]{40,}\b/gi }
];

/**
 * Extract secrets from a chat message. The returned `redacted` text is safe to
 * send to a model; `found` contains the raw values so the caller can encrypt
 * and store them before the message leaves the process.
 */
export function extractSecrets(text) {
  const input = String(text ?? '');
  const found = [];
  let redacted = input;

  for (const { name, re, capture: useCapture } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    redacted = redacted.replace(re, (match, ...args) => {
      const capture = useCapture ? args[0] : '';
      const value = String(capture || match);
      // For bearer / labeled patterns the capture is the credential only;
      // keep the label out of the stored secret.
      if (!found.some((item) => item.value === value)) {
        found.push({ value, kind: name, raw: match });
      }
      if (capture) return match.replace(capture, `[SECRET:${name}]`);
      return `[SECRET:${name}]`;
    });
  }

  return { redacted, found };
}

export function looksLikeSecret(value) {
  const text = String(value ?? '');
  if (!text || text.length < 12) return false;
  return SECRET_PATTERNS.some(({ re }) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

export function redactSecrets(text) {
  return extractSecrets(text).redacted;
}

/** Mask a plaintext value for display. Never pass an encrypted value here. */
export function maskValue(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.length <= 6) return '****';
  const prefix = text.startsWith('sk-') ? 'sk-' : text.slice(0, 2);
  return `${prefix}****${text.slice(-4)}`;
}

export function hasMaskMarker(value) {
  return typeof value === 'string' && value.includes('****');
}
