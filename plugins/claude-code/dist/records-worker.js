import { createRequire as __potsherdCreateRequire } from 'node:module';
const require = __potsherdCreateRequire(import.meta.url);

// packages/core/src/records/worker.ts
import { Worker, parentPort } from "node:worker_threads";

// packages/core/src/sources/sessions.ts
import path2 from "node:path";

// packages/core/src/sources/lines.ts
import fs2 from "node:fs";

// packages/core/src/analytics/extract.ts
import fs from "node:fs";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import path from "node:path";

// packages/core/src/theme.ts
var ANSI_RE = new RegExp("\\u001b\\[[0-9;]*m", "g");

// packages/core/src/redact-rules.ts
function shannonEntropy(s) {
  const n = s.length;
  if (n === 0) return 0;
  const counts = /* @__PURE__ */ new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}
var ENTROPY_MIN_LENGTH = 20;
var ENTROPY_THRESHOLD = 4.5;
var UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
var HEX_RE = /^[0-9a-fA-F]+$/;
var NUMERIC_RE = /^[0-9_+-]+$/;
var MINTED_ID_RE = /^(?:toolu|srvtoolu|msg|req|resp|call|fc|run|step|thread|asst|evt|sess|session|exec|job|task|turn|conv|agent|snapshot|chatcmpl)[-_]/i;
var ULID_RE = /^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/;
var SAMECASE_RUN_MIN = 7;
var SAMECASE_RUNS_NEEDED = 2;
var SAMECASE_RUN_ALONE = 12;
function looksLikeProse(token) {
  let long = 0;
  for (const run of token.match(/[a-z]+|[A-Z]+/g) ?? []) {
    if (run.length >= SAMECASE_RUN_ALONE) return true;
    if (run.length >= SAMECASE_RUN_MIN) long += 1;
  }
  return long >= SAMECASE_RUNS_NEEDED;
}
function looksLikeAlphabetConstant(token) {
  return token.length >= 24 && new Set(token).size === token.length;
}
var PLACEHOLDER_RE = /(?:^|[^a-z0-9])(?:x{3,}|your|my[-_]?(?:key|token|secret|pass)|example|sample|dummy|fake|mock|placeholder|change[-_]?(?:me|it|this)|replace[-_]?me|insert|todo|fixme|redacted|hidden|omitted|elided|not[-_]?real|no[-_]?such|hunter2|password|passwd|secret|token|apikey|api[-_]key|abcdef|123456|s3cret|letmein|foobar|lorem|ipsum)(?:$|[^a-z0-9])/i;
var INTERPOLATION_RE = /\$\{|\{\{|%\(|<%|^\$[A-Za-z_(]|^<|^\{|\}$|^%[A-Za-z(]/;
var REFERENCE_RE = /^(?:process\.env|import\.meta\.env|os\.environ|System\.getenv|Deno\.env|env|ENV|config|conf|cfg|settings|opts|options|args|argv|params|props|state|data|input|payload|body|req|res|ctx|context|self|this|that|obj|row|item|user|account|creds|credentials|secrets|vault|store|keychain)\b\s*[.[(]/;
var WORDY_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z_$]*$/;
var DOTTED_CHAIN_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;
var PATHISH_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|\.{0,2}\/|~\/|[A-Za-z]:\\)/;
var CODEY_RE = /[<>{}[\]()|\\;,&?!*"'`]/;
var MASK_FRAGMENT_RE = /‹redacted:/;
var NAME_STOPWORDS = /* @__PURE__ */ new Set([
  "monkey",
  "donkey",
  "turkey",
  "whiskey",
  "jockey",
  "hockey",
  "lackey",
  "mickey",
  "malarkey",
  "hotkey",
  "sortkey",
  "oauth"
]);
function nameLooksLikeSecret(name) {
  const segments = name.split(/[^A-Za-z0-9]+/).flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/)).filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return false;
  const lower = last.toLowerCase();
  if (NAME_STOPWORDS.has(lower)) return false;
  return /(?:key|token|secret|password|passwd|pwd|credential|auth)s?$/.test(lower);
}
function valueLooksLikeSecret(value) {
  const v = value.trim();
  if (v.length < 10 || v.length > 200) return false;
  if (/\s/.test(v)) return false;
  if (MASK_FRAGMENT_RE.test(v)) return false;
  if (CODEY_RE.test(v)) return false;
  if (INTERPOLATION_RE.test(v)) return false;
  if (REFERENCE_RE.test(v)) return false;
  if (DOTTED_CHAIN_RE.test(v)) return false;
  if (PATHISH_RE.test(v)) return false;
  if (NUMERIC_RE.test(v)) return false;
  if (PLACEHOLDER_RE.test(v)) return false;
  if (WORDY_IDENTIFIER_RE.test(v) && shannonEntropy(v) < 4) return false;
  if (new Set(v).size <= 2) return false;
  if (shannonEntropy(v) < 3.2) return false;
  return true;
}
function entropyCandidateAllowed(token) {
  if (token.length < ENTROPY_MIN_LENGTH) return false;
  if (UUID_RE.test(token)) return false;
  if (UUID_RE.test(token.replace(/^[A-Za-z][A-Za-z0-9]{0,15}[-_]/, ""))) return false;
  if (HEX_RE.test(token)) return false;
  if (/^(?:sha1|sha256|sha384|sha512|md5|blake3|crc32|xxh64)[-_:]/i.test(token)) return false;
  if (NUMERIC_RE.test(token)) return false;
  if (MASK_FRAGMENT_RE.test(token)) return false;
  if (PLACEHOLDER_RE.test(token)) return false;
  if (MINTED_ID_RE.test(token)) return false;
  if (ULID_RE.test(token)) return false;
  if (looksLikeProse(token)) return false;
  if (looksLikeAlphabetConstant(token)) return false;
  return true;
}
function regexRule(id, type, source, re, opts = {}) {
  const group = opts.group ?? 0;
  return {
    id,
    type,
    source,
    scan(text) {
      const out = [];
      const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      let m;
      while ((m = rx.exec(text)) !== null) {
        if (m[0].length === 0) {
          rx.lastIndex++;
          continue;
        }
        const value = group === 0 ? m[0] : m[group];
        if (value === void 0 || value.length === 0) continue;
        if (opts.validate && !opts.validate(value, m)) continue;
        const offset = group === 0 ? 0 : m[0].indexOf(value);
        if (offset < 0) continue;
        out.push({ start: m.index + offset, end: m.index + offset + value.length, value });
      }
      return out;
    }
  };
}
var GENERIC_ANCHOR = /(?:key|token|secret|password|passwd|pwd|credential|auth)s?["']?[ \t]*(?::=|=>|[:=])/gi;
var GENERIC_VALUE = (
  // The bare alternative stops at a backslash on purpose: transcripts carry
  // json-escaped text, where `TOKEN=abc\nNEXT=…` is one line and the `\n` is
  // two literal characters. Without this the capture swallows the rest of the
  // record and the value is thrown out as code.
  /[ \t]*(?:"([^"\r\n]{10,200})"|'([^'\r\n]{10,200})'|`([^`\r\n]{10,200})`|([^\s"'`,;)\](}>\\]{10,200}))/y
);
var NAME_CHAR_RE = /[A-Za-z0-9_$.-]/;
var genericAssignmentRule = {
  id: "generic-assignment",
  type: "generic",
  source: "03 \xA75, given the shape of gitleaks generic-api-key (MIT)",
  scan(text) {
    const out = [];
    const anchor = new RegExp(GENERIC_ANCHOR.source, GENERIC_ANCHOR.flags);
    let m;
    while ((m = anchor.exec(text)) !== null) {
      const opEnd = m.index + m[0].length;
      const opLen = /(?::=|=>)$/.test(m[0]) ? 2 : 1;
      const before = text[opEnd - opLen - 1] ?? "";
      if (text[opEnd] === "=" || opLen === 1 && /[!<>+\-*/%&|^=]/.test(before)) continue;
      const keywordEnd = m.index + m[0].replace(/["']?[ \t]*(?::=|=>|[:=])$/, "").length;
      let nameStart = m.index;
      while (nameStart > 0 && NAME_CHAR_RE.test(text[nameStart - 1] ?? "")) nameStart--;
      const name = text.slice(nameStart, keywordEnd);
      if (!nameLooksLikeSecret(name)) continue;
      GENERIC_VALUE.lastIndex = opEnd;
      const v = GENERIC_VALUE.exec(text);
      if (!v) continue;
      const value = v[1] ?? v[2] ?? v[3] ?? v[4];
      if (value === void 0 || !valueLooksLikeSecret(value)) continue;
      const start = v.index + v[0].lastIndexOf(value);
      out.push({ start, end: start + value.length, value });
      anchor.lastIndex = start + value.length;
    }
    return out;
  }
};
var socketAuthRule = {
  id: "socket-auth-argument",
  type: "generic",
  source: "03 \xA75 credential context",
  scan(text) {
    const out = [];
    const anchor = /(?:^|[\s"'`])--socket-auth["']?(?:[ \t]*=[ \t]*|[ \t]+)/gi;
    let match;
    while ((match = anchor.exec(text)) !== null) {
      GENERIC_VALUE.lastIndex = anchor.lastIndex;
      const found = GENERIC_VALUE.exec(text);
      if (!found) continue;
      const value = found[1] ?? found[2] ?? found[3] ?? found[4];
      if (value === void 0 || !valueLooksLikeSecret(value)) continue;
      const start = found.index + found[0].lastIndexOf(value);
      out.push({ start, end: start + value.length, value });
      anchor.lastIndex = start + value.length;
    }
    return out;
  }
};
var BEARER_RE = /(?:^|[^A-Za-z0-9_-])(?:Bearer|Token|ApiKey|Api-Key|Basic|DPoP)[ \t]+([A-Za-z0-9+/._~-]{16,512}={0,2})/g;
var bearerRule = regexRule(
  "authorization-bearer",
  "generic",
  "03 \xA75 (credential context), given the shape of gitleaks generic-api-key (MIT)",
  BEARER_RE,
  {
    group: 1,
    // Same value screen as the `KEY=` rule: `Bearer ${token}`, `Bearer <TOKEN>`
    // and `Bearer your-token-here` are documentation, not credentials.
    validate: (value) => valueLooksLikeSecret(value)
  }
);
var ENTROPY_TOKEN = /[A-Za-z0-9+_-]{20,}={0,2}/g;
var ESCAPE_LETTERS = "ntrbfv";
var highEntropyRule = {
  id: "high-entropy-token",
  type: "entropy",
  source: "03 \xA75 (4.5 bits / 20 chars) + gitleaks entropy allowlists (MIT)",
  scan(text) {
    const out = [];
    const rx = new RegExp(ENTROPY_TOKEN.source, ENTROPY_TOKEN.flags);
    let m;
    while ((m = rx.exec(text)) !== null) {
      let start = m.index;
      let value = m[0];
      if (start > 0 && text[start - 1] === "\\" && ESCAPE_LETTERS.includes(value[0] ?? "")) {
        start += 1;
        value = value.slice(1);
      }
      if (start > 0 && text[start - 1] === "%" && /^[0-9A-Fa-f]{2}/.test(value)) {
        start += 2;
        value = value.slice(2);
      }
      const lead = value.length - value.replace(/^[-_+]+/, "").length;
      start += lead;
      value = value.slice(lead).replace(/[-_+]+$/, "");
      if (value.length < ENTROPY_MIN_LENGTH) continue;
      if (!entropyCandidateAllowed(value)) continue;
      if (shannonEntropy(value) < ENTROPY_THRESHOLD) continue;
      out.push({ start, end: start + value.length, value });
    }
    return out;
  }
};
var RULES = [
  // ---- key material ------------------------------------------------------
  regexRule(
    // gitleaks `private-key`; secretlint `@secretlint/secretlint-rule-privatekey`.
    // The whole block is masked, header to footer: the base64 body alone would
    // otherwise be shredded into a dozen separate entropy hits.
    "private-key-block",
    "private-key",
    "gitleaks private-key / secretlint-rule-privatekey (MIT)",
    /-----BEGIN[ A-Z0-9]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,200000}?-----END[ A-Z0-9]{0,40}PRIVATE KEY(?: BLOCK)?-----/g
  ),
  regexRule(
    // gitleaks `private-key`, unterminated variant: a transcript often quotes
    // the header and the first body lines and then elides the rest.
    //
    // The body is taken line by line and only where a line is ≥ 20 characters
    // of pure base64, so an unterminated header followed by prose masks the
    // header alone instead of swallowing the sentence after it. The separator
    // class carries the backslash so json-escaped `\n` works, and it is
    // disjoint from the base64 class, which is what keeps this linear.
    "private-key-header",
    "private-key",
    "gitleaks private-key (MIT)",
    /-----BEGIN[ A-Z0-9]{0,40}PRIVATE KEY(?: BLOCK)?-----(?:[\r\n \t\\]+[A-Za-z0-9+/=]{20,})*/g
  ),
  regexRule(
    // gitleaks `jwt`: three base64url segments, the first two starting `ey`
    // (the base64 of `{"`). Session transcripts are full of these.
    "jwt",
    "jwt",
    "gitleaks jwt (MIT)",
    /\bey[A-Za-z0-9_-]{17,}\.ey[A-Za-z0-9_-]{17,}\.[A-Za-z0-9_-]{10,}={0,2}/g
  ),
  // ---- vendor tokens -----------------------------------------------------
  regexRule(
    // gitleaks `aws-access-token`; secretlint-rule-aws `AWSAccessKeyID`.
    "aws-access-key-id",
    "aws",
    "gitleaks aws-access-token / secretlint-rule-aws (MIT)",
    /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g
  ),
  regexRule(
    // secretlint-rule-aws `AWSSecretAccessKey`: a 40-character base64 value
    // bound to an AWS-flavoured name. Typed `aws` and placed before the generic
    // rule so `doctor` reports it as what it is.
    "aws-secret-access-key",
    "aws",
    "secretlint-rule-aws AWSSecretAccessKey (MIT)",
    /aws[_.-]?(?:secret|access)[_.-]?(?:access[_.-]?)?key(?:[_.-]?id)?["'\s]{0,4}[:=]["'\s]{0,4}([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
    { group: 1 }
  ),
  regexRule(
    // gitleaks `gcp-api-key`; secretlint-rule-gcp `GCPApiKey`.
    "gcp-api-key",
    "gcp",
    "gitleaks gcp-api-key / secretlint-rule-gcp (MIT)",
    /\bAIza[0-9A-Za-z_-]{35}\b/g
  ),
  regexRule(
    // gitleaks `gcp-oauth-client-secret`.
    "gcp-oauth-client-secret",
    "gcp",
    "gitleaks gcp-oauth-client-secret (MIT)",
    /\bGOCSPX-[a-zA-Z0-9_-]{28}\b/g
  ),
  regexRule(
    // gitleaks `github-pat` / `-oauth` / `-app-token` / `-refresh-token`;
    // secretlint-rule-github. ghp_ user, gho_ oauth, ghu_/ghs_ app, ghr_ refresh.
    "github-token",
    "github",
    "gitleaks github-pat / secretlint-rule-github (MIT)",
    /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g
  ),
  regexRule(
    // gitleaks `github-fine-grained-pat`.
    "github-fine-grained-pat",
    "github",
    "gitleaks github-fine-grained-pat (MIT)",
    /\bgithub_pat_[0-9a-zA-Z_]{82}\b/g
  ),
  regexRule(
    // gitleaks `slack-bot-token` / `-user-token` / `-app-token`;
    // secretlint-rule-slack.
    "slack-token",
    "slack",
    "gitleaks slack-bot-token / secretlint-rule-slack (MIT)",
    /\bxox[abprs]-[0-9a-zA-Z-]{10,72}\b/g
  ),
  regexRule(
    // gitleaks `slack-webhook-url`; secretlint-rule-slack `SlackWebhook`.
    "slack-webhook",
    "slack",
    "gitleaks slack-webhook-url (MIT)",
    /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{6,}\/[A-Za-z0-9+/]{6,}\/[A-Za-z0-9+/]{6,}/g
  ),
  regexRule(
    // gitleaks `stripe-access-token`. `pk_` publishable keys are public by
    // design and are deliberately not matched.
    "stripe-key",
    "stripe",
    "gitleaks stripe-access-token (MIT)",
    /\b(?:sk|rk)_(?:test|live|prod)_[A-Za-z0-9]{10,99}\b/g
  ),
  regexRule(
    // gitleaks `anthropic-api-key`. Must precede the openai rules: both start
    // `sk-`, and whichever rule claims the span first wins.
    "anthropic-api-key",
    "anthropic",
    "gitleaks anthropic-api-key (MIT)",
    /\bsk-ant-(?:api|admin)[0-9]{2}-[A-Za-z0-9_-]{80,120}\b/g
  ),
  regexRule(
    // gitleaks `openai-api-key`: the `T3BlbkFJ` infix is the base64 of
    // "OpenAI" and is what makes this rule safe to run over prose.
    "openai-api-key-project",
    "openai",
    "gitleaks openai-api-key (MIT)",
    /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b/g
  ),
  regexRule(
    // gitleaks `openai-api-key`, legacy 48-character form with no infix.
    "openai-api-key-legacy",
    "openai",
    "gitleaks openai-api-key (MIT)",
    /\bsk-[A-Za-z0-9]{48}\b/g
  ),
  regexRule(
    // gitleaks `npm-access-token`; secretlint-rule-npm.
    "npm-access-token",
    "npm",
    "gitleaks npm-access-token / secretlint-rule-npm (MIT)",
    /\bnpm_[A-Za-z0-9]{36}\b/g
  ),
  // ---- credentials in urls -----------------------------------------------
  regexRule(
    // gitleaks `authenticated-url`; secretlint `-rule-basicauth`. Only the
    // password is masked: `postgres://app:‹redacted:basic-auth:…›@db:5432/x`
    // still says which host and which user, which is the point of an index that
    // stays searchable by shape.
    "basic-auth-url",
    "basic-auth",
    "gitleaks authenticated-url / secretlint-rule-basicauth (MIT)",
    // The user half is `{0,64}`: `redis://:hunter2@host` has an empty user and
    // is exactly as leaked as the two-part form.
    /\b[a-zA-Z][a-zA-Z0-9+.-]{1,20}:\/\/[^\s:@/]{0,64}:([^\s:@/]{1,128})@/g,
    {
      group: 1,
      validate: (value) => {
        if (INTERPOLATION_RE.test(value)) return false;
        if (PLACEHOLDER_RE.test(value)) return false;
        if (MASK_FRAGMENT_RE.test(value)) return false;
        if (/^(?:pass|pw|user|admin|root|test|guest|\*+|x+|\d{1,4})$/i.test(value)) return false;
        return true;
      }
    }
  ),
  // ---- credential context (03 §5) ----------------------------------------
  bearerRule,
  genericAssignmentRule,
  socketAuthRule,
  // ---- entropy (03 §5) ---------------------------------------------------
  // Last, so that anything a named rule understands is reported under its real
  // type and a bare token is the fallback rather than the default.
  highEntropyRule
];

// packages/core/src/redact-elide.ts
var BASE64_MAGIC = [
  ["iVBORw0KGgo", "image/png", "89 50 4E 47 0D 0A 1A 0A"],
  ["/9j/", "image/jpeg", "FF D8 FF (JFIF/Exif SOI)"],
  ["R0lGODdh", "image/gif", "GIF87a"],
  ["R0lGODlh", "image/gif", "GIF89a"],
  ["Qk0", "image/bmp", '42 4D ("BM")'],
  ["SUkqAA", "image/tiff", "49 49 2A 00 (little-endian TIFF)"],
  ["TU0AK", "image/tiff", "4D 4D 00 2A (big-endian TIFF)"],
  ["AAABAA", "image/x-icon", "00 00 01 00 (ICO)"],
  ["UklGR", "application/octet-stream", '52 49 46 46 ("RIFF" \u2014 webp/wav/avi)'],
  ["JVBERi0", "application/pdf", '25 50 44 46 2D ("%PDF-")'],
  ["UEsDB", "application/zip", '50 4B 03 04 ("PK\\x03\\x04" \u2014 zip/docx/xlsx)'],
  ["H4sI", "application/gzip", "1F 8B 08"],
  ["SUQz", "audio/mpeg", '49 44 33 ("ID3")'],
  ["T2dnU", "application/ogg", '4F 67 67 53 ("OggS")'],
  ["d09GRg", "font/woff", '77 4F 46 46 ("wOFF")'],
  ["d09GMg", "font/woff2", '77 4F 46 32 ("wOF2")'],
  ["AAEAAA", "font/ttf", "00 01 00 00 (TrueType)"],
  ["T1RUTw", "font/otf", '4F 54 54 4F ("OTTO")']
];
var B64_RUN = `(?:[A-Za-z0-9+/=]|\\\\/)`;
var B64_BODY = `${B64_RUN}{40,}(?:[\\r\\n \\t]+${B64_RUN}{40,})*`;
var DATA_URI = new RegExp(
  `data:([a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+)?(?:;[a-zA-Z0-9.+=-]+)*;base64,${B64_BODY}`,
  "g"
);
var CONTENT_BLOCK = new RegExp(
  `"(?:data|image_data|b64_json|base64)"\\s*:\\s*"(${B64_BODY})"`,
  "g"
);
var MAGIC_PREFIXES = BASE64_MAGIC.map(([p]) => p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|");
var BARE_RUN = new RegExp(
  `(?<![A-Za-z0-9+/=])(?:${MAGIC_PREFIXES})${B64_BODY}`,
  "g"
);

// packages/core/src/redact.ts
var OPEN = "\u2039";
var CLOSE = "\u203A";
var MASK_RE = new RegExp(`${OPEN}redacted:[a-z-]+:[0-9a-f]{8}${CLOSE}`, "g");

// packages/core/src/analytics/profanity.ts
var ENGLISH_EXPLICIT_LEXICON = Object.freeze(["fuck", "fucked", "fucking", "shit", "shitty", "bullshit", "asshole", "bastard"]);
var words = new Set(ENGLISH_EXPLICIT_LEXICON);

// packages/core/src/analytics/findings.ts
var EXACT_REPEAT_LIMITS = Object.freeze({ rows: 20, supports: 8, maxRowBytes: 8192 });

// packages/core/src/analytics/story-lexicon.ts
var SWEAR_STEMS = [
  "fuck",
  "shit",
  "bullshit",
  "wtf",
  "damn",
  "goddamn",
  "crap",
  "bitch",
  "asshole",
  "dumbass",
  "stfu",
  "ffs",
  "piss",
  "bastard",
  "motherf",
  "bloody",
  "bsdk",
  "chutiya",
  "chutiye",
  "madarchod",
  "bhenchod",
  "behenchod",
  "gandu"
];
var SWEAR_EXACT = /* @__PURE__ */ new Set(["ffs", "wtf", "stfu"]);
var SWEAR_PREFIX = SWEAR_STEMS.filter((s) => !SWEAR_EXACT.has(s));
var TICS = [
  "one more thing",
  "each and every",
  "do one thing",
  "every single thing",
  "kind of a thing",
  "and all",
  "and stuff",
  "or something",
  "at the end of the day",
  "to be honest",
  "basically",
  "you know what",
  "let me know",
  "best possible",
  "world class",
  "insanely",
  "make it pop",
  "help me out",
  "what do you think",
  "i don't know",
  "just do it",
  "ship it",
  "go ahead",
  "lfg",
  "let's go",
  "no worries",
  "makes sense",
  "figure it out",
  "deep research",
  "ultra think",
  "ultrathink",
  "step by step",
  "one shot",
  "whatever it takes",
  "end to end",
  "from scratch",
  "like a pro",
  "production ready",
  "properly",
  "exactly",
  "and everything",
  "all of that",
  "the whole thing",
  "you know",
  "i mean",
  "sort of",
  "kind of",
  "so yeah",
  "okay so"
];
var CLAUSE_FINAL = /* @__PURE__ */ new Set(["and all", "and stuff", "or something", "and everything", "all of that", "and all that"]);
var esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var TIC_BY_FIRST = /* @__PURE__ */ new Map();
TICS.forEach((phrase, index) => {
  const first = phrase.split(" ")[0];
  const list = TIC_BY_FIRST.get(first) ?? [];
  list.push({ phrase, index, final: CLAUSE_FINAL.has(phrase) });
  TIC_BY_FIRST.set(first, list);
});
var ADDRESS = ["dude", "bro", "buddy", "babe", "baby", "my friend", "man", "mate", "boss", "sir", "brother", "bhai", "yaar", "chief", "champ", "my guy", "darling", "love"];
var ADDRESS_GATE = new RegExp("\\b(" + ADDRESS.map(esc).join("|") + ")\\b", "g");
var ADDRESS_INDEX = new Map(ADDRESS.map((a, i) => [a, i]));
var TOPIC_STOP = new Set("the a an and or of to in on for is it that this i you we be are was with as at by from so if but not do can me my your our just what how all also now like then there they them these those one some any more much very really thing things something everything get got make made want need see know think going go let lets let's okay ok yes no up out into about will would should could have has had been being he she his her him its it's i'm don't can't isn't doesn't which who when where why here same other only even still well right good way time new use using done try give take put come look".split(" "));

// packages/core/src/analytics/copy-prune.ts
var SNIFF = 64 * 1024;
var CLASSIFY_MAX_BYTES = 512 * 1024 * 1024;

// packages/core/src/analytics/extract.ts
var SUBAGENT_DIR = `${path.sep}subagents${path.sep}`;
var CHUNK = 4 * 1024 * 1024;
var MAX_LINE = 256 * 1024 * 1024;
var RESUME_RECENT_MS = 48 * 36e5;
var ZSTD_MAGIC = 4247762216;
function headBytes(fd, max) {
  const buffer = Buffer.alloc(max);
  const n = fs.readSync(fd, buffer, 0, max, 0);
  return buffer.subarray(0, n);
}
function isZstd(fd) {
  const head = headBytes(fd, 4);
  return head.length === 4 && head.readUInt32LE(0) === ZSTD_MAGIC;
}
var ZSTD_INPUT = 1024 * 1024;
var ZSTD_OUTPUT = 1024 * 1024;
function chunkedZstd() {
  const Engine = zlib.ZstdDecompress;
  if (zstdMode !== "node" || !Engine) return null;
  let engine;
  try {
    engine = new Engine();
  } catch {
    return null;
  }
  const handle = engine._handle, state = engine._writeState;
  if (!handle || typeof handle.writeSync !== "function" || !(state instanceof Uint32Array)) {
    engine.close();
    return null;
  }
  engine.on("error", () => {
  });
  const flush = zlib.constants.ZSTD_e_continue;
  return {
    step(input) {
      const outs = [];
      let inOff = 0, availIn = input.length;
      for (; ; ) {
        const out = Buffer.allocUnsafe(ZSTD_OUTPUT);
        handle.writeSync(flush, input, inOff, availIn, out, 0, out.length);
        if (engine.destroyed) throw new Error("zstd_corrupt");
        const availOut = state[0], availInAfter = state[1];
        if (out.length - availOut > 0) outs.push(out.subarray(0, out.length - availOut));
        inOff += availIn - availInAfter;
        availIn = availInAfter;
        if (availOut !== 0) break;
      }
      return outs;
    },
    close: () => engine.close()
  };
}
function zstdStream(fd, file, hashes) {
  zstdMode ??= zstdSupport();
  const engine = chunkedZstd();
  let pending = [], inPos = 0, done = false;
  const input = engine ? Buffer.allocUnsafe(ZSTD_INPUT) : null;
  const emit = (out) => {
    if (out.length) {
      pending.push(out);
      hashes?.push(out);
    }
  };
  const fill = () => {
    if (!engine) {
      emit(decompressZstd(file));
      done = true;
      return;
    }
    const n = fs.readSync(fd, input, 0, ZSTD_INPUT, inPos);
    inPos += n;
    if (!n) {
      done = true;
      engine.close();
      return;
    }
    try {
      for (const out of engine.step(input.subarray(0, n))) emit(out);
    } catch (error) {
      done = true;
      engine.close();
      throw error;
    }
  };
  return {
    read(target, offset, length) {
      while (!pending.length && !done) fill();
      let written = 0;
      while (written < length && pending.length) {
        const head = pending[0], n = Math.min(head.length, length - written);
        head.copy(target, offset + written, 0, n);
        written += n;
        if (n === head.length) pending.shift();
        else pending[0] = head.subarray(n);
      }
      return written;
    },
    peek(max) {
      while (pending.reduce((x, p) => x + p.length, 0) < max && !done) fill();
      const all = Buffer.concat(pending);
      pending = all.length ? [all] : [];
      return all.subarray(0, max);
    }
  };
}
function zstdSupport() {
  if (typeof zlib.zstdDecompressSync === "function") return "node";
  try {
    execFileSync("zstd", ["--version"], { stdio: "ignore", timeout: 5e3 });
    return "cli";
  } catch {
    return null;
  }
}
var zstdMode;
function decompressZstd(file) {
  zstdMode ??= zstdSupport();
  if (zstdMode === "node") {
    try {
      return zlib.zstdDecompressSync(fs.readFileSync(file));
    } catch {
      throw new Error("zstd_corrupt");
    }
  }
  if (zstdMode === "cli") {
    try {
      return execFileSync("zstd", ["-dcq", "--", file], { maxBuffer: 2 ** 32, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      throw new Error("zstd_corrupt");
    }
  }
  throw new Error("zstd_unsupported");
}

// packages/core/src/sources/lines.ts
var CHUNK2 = 4 * 1024 * 1024;
var MAX_LINE2 = 512 * 1024 * 1024;
function forEachLine(file, onLine) {
  const fd = fs2.openSync(file, "r");
  try {
    const zst = isZstd(fd) ? zstdStream(fd, file, null) : null;
    let buffer = Buffer.allocUnsafe(CHUNK2);
    let filled = 0, position = 0, lineNo = 0, skipping = false;
    for (; ; ) {
      if (filled === buffer.length) {
        if (buffer.length >= MAX_LINE2) {
          skipping = true;
          filled = 0;
        } else {
          const bigger = Buffer.allocUnsafe(buffer.length * 2);
          buffer.copy(bigger, 0, 0, filled);
          buffer = bigger;
        }
      }
      const n = zst ? zst.read(buffer, filled, buffer.length - filled) : fs2.readSync(fd, buffer, filled, buffer.length - filled, position);
      position += n;
      const end = filled + n;
      let start = 0;
      for (; ; ) {
        const nl = buffer.indexOf(10, start);
        if (nl < 0 || nl >= end) break;
        lineNo++;
        if (skipping) skipping = false;
        else onLine(buffer.subarray(start, nl), lineNo);
        start = nl + 1;
      }
      if (n === 0) {
        if (start < end) {
          lineNo++;
          if (!skipping) onLine(buffer.subarray(start, end), lineNo);
        }
        break;
      }
      buffer.copyWithin(0, start, end);
      filled = end - start;
    }
  } finally {
    fs2.closeSync(fd);
  }
}
function forEachRecord(file, onRecord) {
  forEachLine(file, (line, lineNo) => {
    let i = 0;
    while (i < line.length && (line[i] === 32 || line[i] === 9 || line[i] === 13)) i++;
    if (i >= line.length) return;
    let value;
    try {
      value = JSON.parse(line.toString("utf8"));
    } catch {
      return;
    }
    onRecord(value, lineNo);
  });
}

// packages/core/src/sources/text.ts
var WS = "\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
var STRIP = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");
var RUNS = new RegExp(`[${WS}]+`, "g");
var BREAK = new RegExp("\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]");
function pyStrip(s) {
  return s.replace(STRIP, "");
}
function pyDumps(v) {
  if (v === null || v === void 0) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity";
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(", ")}]`;
  if (typeof v === "object") {
    return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyDumps(x)}`).join(", ")}}`;
  }
  return JSON.stringify(String(v));
}
function pyStr(v) {
  if (v === null || v === void 0) return "None";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  return pyRepr(v);
}
function pyRepr(v) {
  if (v === null || v === void 0) return "None";
  if (typeof v === "string") return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  return `{${Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ")}}`;
}
var SURROGATE = /[\uD800-\uDFFF]/;
function cpLen(s) {
  if (!SURROGATE.test(s)) return s.length;
  let n = 0;
  for (const _ of s) n++;
  return n;
}
function cpSlice(s, a, b) {
  if (!SURROGATE.test(s)) return s.slice(a, b);
  return Array.from(s).slice(a, b).join("");
}

// packages/core/src/sources/sessions.ts
var TEXT_LIM = 4e4;
var OUT_LIM = 6e3;
var isRec = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
var str = (v) => typeof v === "string" ? v : null;
function put(t, key, v, lim) {
  const s = v ?? "";
  const n = cpLen(s);
  if (key === "text") t.textLen = n;
  else t.outputLen = n;
  const capped = n <= lim ? s : cpSlice(s, 0, Math.floor(lim * 2 / 3)) + "\n[...]\n" + cpSlice(s, -Math.ceil(lim / 3));
  if (key === "text") t.text = capped;
  else t.output = capped;
  return t;
}
function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}
function isoTs(v) {
  if (v === null || v === void 0) return null;
  if (typeof v === "number") {
    let x = v;
    if (x > 1e12) x = x / 1e3;
    const d = new Date(Math.floor(x * 1e3));
    if (Number.isNaN(d.getTime())) return null;
    return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
  }
  if (typeof v === "boolean") return isoTs(v ? 1 : 0);
  const s = String(v);
  return s.length >= 19 ? s.slice(0, 19) + "Z" : s;
}
function epoch(ts) {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t / 1e3 : null;
}
var INJECT_RE = /^\s*<(task-notification|command-name|command-message|local-command-stdout|local-command-caveat|system-reminder|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr|command-args)/;
function toolInputSummary(name, inp) {
  if (!isRec(inp)) return pyStr(inp);
  if ((name === "Bash" || name === "bash") && "command" in inp) return pyStr(inp["command"]);
  if ((name === "Read" || name === "Write" || name === "NotebookEdit") && "file_path" in inp) {
    const extra = name === "Write" ? "\n" + pyStr(inp["content"] ?? "") : "";
    return pyStr(inp["file_path"]) + extra;
  }
  if ((name === "Edit" || name === "MultiEdit") && "file_path" in inp) {
    if (name === "Edit") return `${pyStr(inp["file_path"])}
--- old
${pyStr(inp["old_string"] ?? "")}
+++ new
${pyStr(inp["new_string"] ?? "")}`;
    return pyStr(inp["file_path"]) + "\n" + pyDumps(inp["edits"] ?? []);
  }
  return pyDumps(inp);
}
function blockText(c) {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const out = [];
  for (const b of c) {
    if (isRec(b)) {
      const t = b["type"];
      if (t === "text") out.push(str(b["text"]) ?? "");
      else if (t === "image") out.push("[image]");
      else if (t === "tool_reference") out.push(`[tool_reference ${pyStr(b["tool_name"] ?? "")}]`);
    } else if (typeof b === "string") out.push(b);
  }
  return out.join("\n");
}
function parseClaude(file, subParent = null, lim = {}) {
  const TL = lim.text ?? TEXT_LIM, OL = lim.output ?? OUT_LIM;
  const s = { harness: "claude", id: "", project: null, title: null, start: null, end: null, parent: null, parentKind: null, sources: [file], turns: [] };
  let aiTitle = null;
  let sub = subParent;
  if (sub) {
    s.parent = sub;
    s.parentKind = "subagent";
    s.id = path2.basename(file, ".jsonl");
  }
  const turns = s.turns;
  const pending = /* @__PURE__ */ new Map();
  const seen = /* @__PURE__ */ new Set();
  forEachRecord(file, (o, n) => {
    if (!isRec(o)) return;
    const typ = o["type"];
    if (typ === "custom-title" && o["customTitle"] !== null && o["customTitle"] !== void 0) {
      s.title = str(o["customTitle"]) || null;
      return;
    }
    if (typ === "ai-title" && o["aiTitle"]) {
      aiTitle = pyStr(o["aiTitle"]);
      return;
    }
    if (typ === "summary" && o["summary"] && !aiTitle) aiTitle = pyStr(o["summary"]);
    if (typ !== "user" && typ !== "assistant") return;
    const u = str(o["uuid"]);
    if (u) {
      if (seen.has(u)) return;
      seen.add(u);
    }
    if (!sub && !s.id && o["isSidechain"] && o["agentId"] && o["sessionId"]) {
      sub = pyStr(o["sessionId"]);
      s.parent = sub;
      s.parentKind = "subagent";
      s.id = "agent-" + pyStr(o["agentId"]);
    }
    if (!sub && o["sessionId"] && !s.id) s.id = pyStr(o["sessionId"]);
    if (o["cwd"] && !s.project) s.project = pyStr(o["cwd"]);
    const ts = isoTs(o["timestamp"]);
    if (ts) {
      s.start = s.start || ts;
      s.end = ts;
    }
    const ref = `${file}:${n}`;
    const msg = isRec(o["message"]) ? o["message"] : {};
    const content = msg["content"];
    if (typ === "user") {
      if (Array.isArray(content) && content.some((b) => isRec(b) && b["type"] === "tool_result")) {
        for (const b of content) {
          if (!isRec(b) || b["type"] !== "tool_result") continue;
          let out = blockText(b["content"]);
          if (b["is_error"]) out = "[error] " + out;
          const key = str(b["tool_use_id"]) ?? "";
          const i = pending.get(key);
          if (i !== void 0) {
            pending.delete(key);
            put(turns[i], "output", out, OL);
            turns[i].outRef = ref;
          } else {
            turns.push(put({ role: "TOOL", ts, tool: "result", text: "", ref }, "output", out, OL));
          }
        }
        return;
      }
      let text = blockText(content);
      if (!pyStrip(text)) return;
      let role = "USER";
      const origin = o["origin"];
      const originKind = isRec(origin) ? origin["kind"] : origin === void 0 || origin === null ? void 0 : null;
      if (o["isMeta"] || o["isCompactSummary"] || INJECT_RE.test(text) || text.startsWith("[Request interrupted") || originKind !== void 0 && originKind !== null && originKind !== "human") role = "SYSTEM";
      if (o["isCompactSummary"]) text = "[compaction summary] " + text;
      turns.push(put({ role, ts, text: "", ref }, "text", text, TL));
    } else {
      if (msg["model"] === "<synthetic>" && !content) return;
      const mid = str(msg["id"]);
      const blocks = Array.isArray(content) ? content : [{ type: "text", text: content || "" }];
      for (const b of blocks) {
        if (!isRec(b)) continue;
        const t = b["type"];
        const bt = typeof b["text"] === "string" ? b["text"] : "";
        if (t === "text" && pyStrip(bt)) {
          const last = turns[turns.length - 1];
          if (last && last.role === "ASSISTANT" && mid && last.mid === mid) {
            const n0 = last.textLen ?? cpLen(last.text);
            put(last, "text", last.text + "\n" + bt, TL);
            last.textLen = n0 + 1 + cpLen(bt);
          } else {
            turns.push(put({ role: "ASSISTANT", ts, ref, mid, text: "" }, "text", bt, TL));
          }
        } else if (t === "tool_use" || t === "server_tool_use") {
          const name = str(b["name"]) ?? "tool";
          turns.push(put({ role: "TOOL", ts, tool: name, output: null, ref, text: "" }, "text", toolInputSummary(name, b["input"]), TL));
          if (b["id"]) pending.set(pyStr(b["id"]), turns.length - 1);
        }
      }
    }
  });
  if (!s.id) s.id = path2.basename(file, ".jsonl");
  s.title = s.title || aiTitle;
  for (const t of turns) delete t.mid;
  return s;
}
var CODEX_INJECT = /^\s*(<(recommended_plugins|environment_context|user_instructions|INSTRUCTIONS|in-app-browser-context|turn_aborted|user_shell_command|skill|subagent_notification|permissions)|# AGENTS\.md instructions|## My request for Codex:)/;
var DATA_URL = /data:image\/[a-z]+;base64,[A-Za-z0-9+/=]{100,}/g;
function codexContentText(c) {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const out = [];
  for (const b of c) {
    if (!isRec(b)) continue;
    const t = b["type"];
    if (t === "input_text" || t === "output_text" || t === "text") out.push(str(b["text"]) ?? "");
    else if (t === "input_image" || t === "image") out.push("[image]");
  }
  return out.join("\n");
}
function outText(o) {
  if (typeof o === "string") {
    try {
      const j = JSON.parse(o);
      if (isRec(j) && "output" in j) return pyStr(j["output"]);
      if (Array.isArray(j)) return codexContentText(j);
    } catch {
    }
    return o;
  }
  if (Array.isArray(o)) return codexContentText(o);
  if (isRec(o)) return pyStr(o["output"] ?? o["content"] ?? pyDumps(o).slice(0, 4e3));
  return pyStr(o);
}
function parseCodex(file, lim = {}) {
  const TL = lim.text ?? TEXT_LIM, OL = lim.output ?? OUT_LIM;
  const s = { harness: "codex", id: "", project: null, title: null, start: null, end: null, parent: null, parentKind: null, sources: [file], turns: [] };
  let hasRespUser = false;
  let ri = 0, prev = null, startI = 0, burstDone = false;
  forEachRecord(file, (o) => {
    if (!isRec(o)) return;
    const typ = o["type"];
    const p = isRec(o["payload"]) ? o["payload"] : {};
    if (typ === "session_meta") {
      if (!s.id) {
        s.id = str(p["id"]) || str(p["session_id"]) || "";
        s.project = str(p["cwd"]);
        const src = p["source"];
        if (p["forked_from_id"]) {
          s.parent = pyStr(p["forked_from_id"]);
          s.parentKind = "fork";
        } else if (isRec(src) && isRec(src["subagent"])) {
          const sp = src["subagent"]["thread_spawn"];
          if (isRec(sp) && sp["parent_thread_id"]) {
            s.parent = pyStr(sp["parent_thread_id"]);
            s.parentKind = "subagent";
          } else s.parentKind = "subagent:" + Object.entries(src["subagent"]).map(([k, v]) => `${k}=${pyStr(v)}`).join(",");
        }
        if (p["parent_thread_id"] && !s.parent) {
          s.parent = pyStr(p["parent_thread_id"]);
          s.parentKind = "subagent";
        }
        if (isRec(p["history_base"]) && !s.parent) {
          const tid = p["history_base"]["thread_id"];
          s.parent = tid === void 0 || tid === null ? null : pyStr(tid);
          s.parentKind = "rewind";
        }
      }
      return;
    }
    if (typ === "response_item" && p["type"] === "message" && p["role"] === "user") hasRespUser = true;
    if (!burstDone) {
      const e = epoch(isoTs(o["timestamp"]) || "");
      if (prev !== null && e !== null && e - prev > 1) {
        startI = ri > 3 ? ri : 0;
        burstDone = true;
      }
      if (e !== null) prev = e;
    }
    ri++;
  });
  if (!s.id) return null;
  if (!(s.parent && (s.parentKind === "fork" || s.parentKind === "subagent"))) startI = 0;
  const turns = s.turns;
  const pending = /* @__PURE__ */ new Map();
  ri = -1;
  forEachRecord(file, (o, n) => {
    if (!isRec(o) || o["type"] === "session_meta") return;
    ri++;
    if (ri < startI) return;
    const typ = o["type"];
    const p = isRec(o["payload"]) ? o["payload"] : {};
    const ts = isoTs(o["timestamp"]);
    const ref = `${file}:${n}`;
    if (ts && (typ === "response_item" || typ === "event_msg")) {
      s.start = s.start || ts;
      s.end = ts;
    }
    if (typ === "response_item") {
      const pt = p["type"];
      if (pt === "message") {
        const role = p["role"];
        const text = codexContentText(p["content"]).replace(DATA_URL, "[image]");
        if (!pyStrip(text)) return;
        if (role === "assistant") turns.push(put({ role: "ASSISTANT", ts, ref, text: "" }, "text", text, TL));
        else if (role === "user") {
          let meta = p["internal_chat_message_metadata_passthrough"] ?? {};
          if (typeof meta === "string") {
            try {
              meta = JSON.parse(meta);
            } catch {
              meta = {};
            }
          }
          const kinds = isRec(meta) ? meta["content_item_kinds"] : void 0;
          const known = kinds !== void 0 && kinds !== null;
          const injected = known && !(Array.isArray(kinds) ? kinds.includes("user.text") : typeof kinds === "string" ? kinds.includes("user.text") : isRec(kinds) && "user.text" in kinds) || !known && CODEX_INJECT.test(text);
          turns.push(put({ role: injected ? "SYSTEM" : "USER", ts, ref, text: "" }, "text", text, TL));
        }
      } else if (pt === "function_call" || pt === "custom_tool_call" || pt === "local_shell_call" || pt === "web_search_call" || pt === "tool_search_call") {
        const name = str(p["name"]) || pyStr(pt);
        let arg = pt === "function_call" ? p["arguments"] : p["input"] || p["action"];
        if (typeof arg === "string") {
          try {
            const j = JSON.parse(arg);
            if (isRec(j)) arg = j["cmd"] || j["command"] || j;
          } catch {
          }
        }
        if (Array.isArray(arg)) arg = arg.map(pyStr).join(" ");
        if (typeof arg !== "string") arg = pyDumps(arg);
        turns.push(put({ role: "TOOL", ts, tool: name, output: null, ref, text: "" }, "text", arg.replace(DATA_URL, "[image]"), TL));
        if (p["call_id"]) pending.set(pyStr(p["call_id"]), turns.length - 1);
      } else if (pt === "function_call_output" || pt === "custom_tool_call_output" || pt === "tool_search_output") {
        const key = pyStr(p["call_id"]);
        const i = pending.get(key);
        if (i !== void 0) {
          pending.delete(key);
          put(turns[i], "output", outText(p["output"]).replace(DATA_URL, "[image]"), OL);
          turns[i].outRef = ref;
        }
      }
    } else if (typ === "event_msg" && !hasRespUser) {
      const pt = p["type"];
      if (pt === "user_message" && p["message"]) turns.push(put({ role: "USER", ts, ref, text: "" }, "text", pyStr(p["message"]), TL));
      else if (pt === "agent_message" && p["message"]) turns.push(put({ role: "ASSISTANT", ts, ref, text: "" }, "text", pyStr(p["message"]), TL));
    }
  });
  return s;
}
function parsePi(file) {
  const s = { harness: "pi", id: "", project: null, title: null, start: null, end: null, parent: null, parentKind: null, sources: [file], turns: [] };
  const entries = [];
  const byId = /* @__PURE__ */ new Map();
  forEachRecord(file, (o, n) => {
    if (!isRec(o)) return;
    if (o["type"] === "session") {
      s.id = str(o["id"]) ?? "";
      s.project = str(o["cwd"]);
      if (o["parentSession"]) {
        s.parent = pyStr(o["parentSession"]);
        s.parentKind = "fork";
      }
      return;
    }
    if (o["type"] === "session_info" && "name" in o) s.title = str(o["name"]) || null;
    o["_n"] = n;
    entries.push(o);
    if (o["id"]) byId.set(pyStr(o["id"]), o);
  });
  if (!s.id) {
    const parts = path2.basename(file, ".jsonl").split("_");
    s.id = parts[parts.length - 1] ?? "";
  }
  let chain = entries;
  if (entries.length && entries.some((e) => "parentId" in e)) {
    chain = [];
    let cur = entries[entries.length - 1];
    let guard = 0;
    while (cur !== void 0 && guard < 1e6) {
      chain.push(cur);
      const pid = cur["parentId"];
      cur = pid === void 0 || pid === null ? void 0 : byId.get(pyStr(pid));
      guard++;
    }
    chain.reverse();
  }
  const pending = /* @__PURE__ */ new Map();
  for (const e of chain) {
    if (e["type"] !== "message") continue;
    const m = isRec(e["message"]) ? e["message"] : {};
    const ts = isoTs(e["timestamp"] ?? m["timestamp"]);
    if (ts) {
      s.start = s.start || ts;
      s.end = ts;
    }
    const ref = `${file}:${String(e["_n"])}`;
    const role = m["role"];
    const content = m["content"];
    if (role === "user") {
      const t = typeof content === "string" ? content : blockText(content);
      if (pyStrip(t)) s.turns.push({ role: INJECT_RE.test(t) ? "SYSTEM" : "USER", ts, text: t, ref });
    } else if (role === "assistant") {
      const blocks = Array.isArray(content) ? content : [{ type: "text", text: content || "" }];
      for (const b of blocks) {
        if (!isRec(b)) continue;
        const bt = typeof b["text"] === "string" ? b["text"] : "";
        if (b["type"] === "text" && pyStrip(bt)) s.turns.push({ role: "ASSISTANT", ts, text: bt, ref });
        else if (b["type"] === "toolCall" || b["type"] === "tool_use") {
          const name = str(b["name"]) ?? "tool";
          s.turns.push({ role: "TOOL", ts, tool: name, text: toolInputSummary(name, b["arguments"] || b["input"]), output: null, ref });
          pending.set(pyStr(b["id"]), s.turns.length - 1);
        }
      }
    } else if (role === "toolResult" || role === "tool") {
      const out = typeof content === "string" ? content : blockText(content);
      const key = pyStr(m["toolCallId"]);
      const i = pending.get(key);
      if (i !== void 0) {
        pending.delete(key);
        s.turns[i].output = out;
        s.turns[i].outRef = ref;
      }
    }
  }
  return s;
}
function shrink(s, lim) {
  for (const t of s.turns) {
    for (const [k, l] of [["text", lim.text ?? TEXT_LIM], ["output", lim.output ?? OUT_LIM]]) {
      const v = k === "text" ? t.text : t.output;
      if (typeof v !== "string") continue;
      const n = cpLen(v);
      if (k === "text") t.textLen ??= n;
      else t.outputLen ??= n;
      if (n > l + 16) {
        const capped = cpSlice(v, 0, Math.floor(l * 2 / 3)) + "\n[...]\n" + cpSlice(v, -Math.ceil(l / 3));
        if (k === "text") t.text = capped;
        else t.output = capped;
      }
    }
  }
  return s;
}
function readSession(file, harness, subParent, lim = {}) {
  if (harness === "claude") return parseClaude(file, subParent, lim);
  if (harness === "codex") return parseCodex(file, lim);
  return shrink(parsePi(file), lim);
}

// packages/core/src/records/format.ts
var CAP = { USER: 6e3, ASSISTANT: 8e3, SYSTEM: 300, TOOL_IN: 600, TOOL_OUT_WHOLE: 4e3, TOOL_OUT_HEAD: 2e3, TOOL_OUT_TAIL: 1e3 };
var SIDECAR_CAP = 2e4;
var capOf = (role) => role === "USER" ? CAP.USER : role === "ASSISTANT" ? CAP.ASSISTANT : role === "SYSTEM" ? CAP.SYSTEM : 6e3;
function recTurn(t, sidecar = false) {
  if (t.role === "TOOL") {
    let inp = pyStrip(t.text || "");
    const inLen = cpLen(inp);
    if (inLen > CAP.TOOL_IN) inp = cpSlice(inp, 0, CAP.TOOL_IN) + ` \u2026[+${inLen - CAP.TOOL_IN} chars]`;
    const r = { role: "TOOL", ts: t.ts, tool: t.tool ?? "", text: inp, out: null };
    if (t.output) {
      let o = pyStrip(t.output);
      const total = t.outputLen ?? cpLen(o);
      if (total > CAP.TOOL_OUT_WHOLE) {
        if (sidecar) {
          const n2 = cpLen(o);
          r.full = n2 > SIDECAR_CAP ? cpSlice(o, 0, SIDECAR_CAP) + ` \u2026[+${n2 - SIDECAR_CAP} chars]` : o;
        }
        o = cpSlice(o, 0, CAP.TOOL_OUT_HEAD) + `
\u2026[${total - CAP.TOOL_OUT_HEAD - CAP.TOOL_OUT_TAIL} chars cut; full output: ${t.outRef ?? t.ref}]\u2026
` + cpSlice(o, -CAP.TOOL_OUT_TAIL);
      }
      r.out = o;
    }
    return r;
  }
  let text = pyStrip(t.text || "");
  const cap = capOf(t.role);
  const n = cpLen(text);
  if (n > cap) text = cpSlice(text, 0, cap) + ` \u2026[+${(t.textLen ?? n) - cap} chars; raw: ${t.ref}]`;
  return { role: t.role, ts: t.ts, text };
}
function recSession(s, sidecar = false) {
  return {
    harness: s.harness,
    id: s.id,
    project: s.project,
    title: s.title,
    start: s.start,
    end: s.end,
    parent: s.parent,
    parentKind: s.parentKind,
    turns: s.turns.map((t) => recTurn(t, sidecar))
  };
}

// packages/core/src/records/deleg.ts
import { createHash } from "node:crypto";
var PREFIX = /^\s*Act as the [\w -]{1,40}? sub-agent for this task\.\s*/i;
var FIRST_USERS = 3;
function delegKey(task) {
  return createHash("sha1").update(task.replace(/\s+/g, " ").trim().slice(0, 400)).digest("hex").slice(0, 16);
}
function taskOf(input) {
  try {
    const j = JSON.parse(input);
    if (j && typeof j === "object" && typeof j["task"] === "string") return j["task"];
  } catch {
  }
  const m = /"task"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(input);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return null;
  }
}
function delegOf(s) {
  const d = {};
  let users = 0;
  for (const t of s.turns) {
    if (t.role === "USER" && users < FIRST_USERS) {
      users++;
      if (!d.task && PREFIX.test(t.text)) d.task = delegKey(t.text.replace(PREFIX, ""));
    } else if (t.role === "TOOL" && /delegate_task$/.test(t.tool ?? "")) {
      const task = taskOf(t.text);
      if (task) (d.calls ??= []).push([delegKey(task), t.ts]);
    }
  }
  return d.task || d.calls ? d : void 0;
}

// packages/core/src/records/refs.ts
var ID = /(?<![0-9a-f])([0-9a-f]{8})(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?(?![0-9a-f])/gi;
var MAX_REFS = 300;
function refsOf(s) {
  const out = /* @__PURE__ */ new Set();
  for (const t of s.turns) {
    if (t.role !== "USER" && t.role !== "ASSISTANT") continue;
    for (const m of t.text.matchAll(ID)) {
      out.add(m[1].toLowerCase());
      if (out.size >= MAX_REFS) return [...out];
    }
  }
  return out.size ? [...out] : void 0;
}

// packages/core/src/records/worker.ts
function parseJob(job) {
  try {
    const harness = job.harness === "auto" ? "codex" : job.harness;
    const lim = job.sidecar ? { output: 3e4 } : {};
    const s = readSession(job.file, harness, job.sub, lim);
    if (!s || !s.id) return { file: job.file, status: "none" };
    return { file: job.file, status: "ok", session: recSession(s, job.sidecar), deleg: delegOf(s), refs: refsOf(s) };
  } catch (e) {
    return { file: job.file, status: "err", err: `${job.file}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500) };
  }
}
function runRecordsWorker() {
  if (!parentPort) return;
  const port = parentPort;
  port.on("message", (job) => port.postMessage(parseJob(job)));
}

// packages/cli/src/records-worker.ts
runRecordsWorker();
//# sourceMappingURL=records-worker.js.map
