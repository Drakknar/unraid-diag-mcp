// Applications print secrets into logs and notifications. This hides the usual shapes; it can't catch everything.
const MASK = "[hidden]";

const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]+)?/g, MASK],
  [/\b(sk|gh[pousr]|xox[abprs]|glpat)[-_][A-Za-z0-9_-]{10,}/g, MASK],
  [/(:\/\/[^\s/:@"']*:)[^\s/@"']+@/g, `$1${MASK}@`],
  // key=value, key: value and "key": "value", when the key names a secret. The key may have a prefix or suffix.
  [/([\w.-]*(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|auth[_-]?key|private[_-]?key|credential|cookie|session[_-]?id)[\w.-]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, `$1${MASK}`],
  // Query parameters and header-like values with long random-looking content.
  [/\b[a-f0-9]{32,}\b/gi, MASK],
  [/\b(?=[A-Za-z0-9+/_-]*[0-9])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])[A-Za-z0-9+/_-]{40,}={0,2}/g, MASK],
];

function redact(text) {
  return RULES.reduce((out, [pattern, to]) => out.replace(pattern, to), String(text ?? ""));
}

module.exports = { redact };
