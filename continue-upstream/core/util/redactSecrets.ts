/**
 * Masks credentials in text before it leaves the machine.
 *
 * Ported from Hermes's redaction module. The case that matters: a command
 * prints an environment dump, a `git remote -v` with a token in the URL, or a
 * failing curl with an Authorization header — and that output is appended to
 * the transcript and posted to a model provider. Once it is in the transcript
 * it is also in the saved session, and in whatever the provider retains.
 *
 * Two rules shaped what got ported:
 *
 *   A false negative leaks a credential. A false positive corrupts output the
 *   user needs to read. So every pattern here is anchored on something
 *   structural — a vendor prefix, a header name, an assignment to a key whose
 *   name says "secret" — and never on entropy or length alone.
 *
 *   Hermes also redacts phone numbers and form bodies, which matter for a
 *   messaging agent. They are left out here: Lumina's exposure is terminal
 *   output and file contents, and masking every `+34...` in a diff would be
 *   noise with no security gain.
 */

/** Below this length a masked value shows nothing; above it, a recognisable stub. */
const SHORT_TOKEN_CHARS = 18;

function maskValue(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length < SHORT_TOKEN_CHARS) {
    return "***";
  }
  // Keeping the ends makes a leaked-key incident diagnosable ("which key was
  // it?") without making the value usable.
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

/**
 * Key names that make the value beside them a credential.
 */
const SECRET_KEY_WORDS =
  "api[_-]?key|apikey|secret|token|password|passwd|pwd|credential|auth|access[_-]?key|private[_-]?key|client[_-]?secret";

/**
 * Boundaries around a key word. `\b` is wrong here: underscore is a word
 * character, so `\b` refuses to fire inside `OPENAI_API_KEY` or `db_password`
 * — exactly the shapes that matter — while still allowing `secretary`. These
 * treat any letter or digit as "inside a word" and everything else (quote,
 * underscore, hyphen, dot, start of line) as a separator, which blocks
 * `secretary`, `tokenizer` and `authored` and admits the underscore forms.
 */
const KEY_START = "(?<![A-Za-z0-9])";
const KEY_END = "(?![A-Za-z0-9])";

/**
 * Reading a variable is not disclosing it. `process.env.OPENAI_API_KEY` and
 * `os.getenv("TOKEN")` are code, and masking them mangles source the user is
 * trying to work on.
 */
const ENV_LOOKUP = /(?:process\s*\.\s*env|os\s*\.\s*(?:getenv|environ)|System\.getenv|ENV\[)/u;

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replace: (match: RegExpMatchArray) => string;
}

const RULES: Rule[] = [
  {
    // Whole PEM blocks. Nothing inside is worth preserving.
    name: "private-key-block",
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
    replace: () => "[REDACTED PRIVATE KEY]",
  },
  {
    // Vendor-prefixed keys. The prefix is what makes this safe to match.
    name: "vendor-token",
    pattern:
      /\b(sk-[A-Za-z0-9_-]{10,}|sk_(?:live|test)_[A-Za-z0-9]{10,}|rk_live_[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|gho_[A-Za-z0-9]{10,}|ghu_[A-Za-z0-9]{10,}|ghs_[A-Za-z0-9]{10,}|ghr_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|glpat-[A-Za-z0-9_-]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16}|hf_[A-Za-z0-9]{10,}|pplx-[A-Za-z0-9]{10,})/gu,
    replace: (match) => maskValue(match[1]),
  },
  {
    // JWTs: the `eyJ` prefix is base64 for `{"`, which is structural enough.
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+){0,2}/gu,
    replace: (match) => maskValue(match[0]),
  },
  {
    // Authorization: Bearer <token>. The scheme survives so the line still
    // tells you what kind of auth failed.
    name: "authorization-header",
    pattern:
      /^([ \t]*(?:Proxy-)?Authorization[ \t]*:[ \t]*)([A-Za-z]+[ \t]+)?([^\s"'][^\r\n"']*)/gimu,
    replace: (match) => `${match[1]}${match[2] ?? ""}${maskValue(match[3])}`,
  },
  {
    // x-api-key: <value> and friends — one opaque value, no scheme.
    name: "api-key-header",
    pattern:
      /^([ \t]*(?:x-)?(?:api[-_]?key|api[-_]?token|auth[-_]?token|access[-_]?token)[ \t]*:[ \t]*)([^\s"'][^\r\n"']*)/gimu,
    replace: (match) => `${match[1]}${maskValue(match[2])}`,
  },
  {
    // Passwords inside connection strings. Only the password segment goes.
    name: "connection-string",
    pattern:
      /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/@]+:)([^\s@/]+)(@)/giu,
    replace: (match) => `${match[1]}${maskValue(match[2])}${match[3]}`,
  },
  {
    // https://<token>@host — the shape `git remote set-url` leaves behind.
    name: "url-userinfo-token",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]{8,})(@)/giu,
    replace: (match) => `${match[1]}${maskValue(match[2])}${match[3]}`,
  },
  {
    // KEY=value / "key": "value" / key: value, where the key names a secret.
    name: "secret-assignment",
    pattern: new RegExp(
      String.raw`(["']?[A-Za-z0-9_.\-]*${KEY_START}(?:${SECRET_KEY_WORDS})${KEY_END}[A-Za-z0-9_.\-]*["']?[ \t]*[:=][ \t]*)(["']?)([^\s"',;]+)\2`,
      "giu",
    ),
    replace: (match) =>
      ENV_LOOKUP.test(match[3])
        ? match[0]
        : `${match[1]}${match[2]}${maskValue(match[3])}${match[2]}`,
  },
];

export interface RedactionResult {
  text: string;
  /** Names of the rules that fired, for telling the user what was masked. */
  rules: string[];
}

/**
 * Masks credentials in `text`.
 *
 * Rule order matters: whole-block and prefix rules run before the generic
 * key=value rule, so a vendor token assigned to a variable is masked as a
 * token rather than being partly consumed by the assignment pattern.
 */
export function redactSecrets(text: string): RedactionResult {
  if (text === "") {
    return { text, rules: [] };
  }

  let output = text;
  const rules: string[] = [];

  for (const rule of RULES) {
    let fired = false;
    output = output.replace(rule.pattern, (...args) => {
      // String.replace hands us (match, ...groups, offset, whole); rebuilding
      // the match array keeps each rule's replace() readable.
      const groups = args.slice(0, -2) as string[];
      const asMatch = groups as unknown as RegExpMatchArray;
      const replacement = rule.replace(asMatch);
      if (replacement !== groups[0]) {
        fired = true;
      }
      return replacement;
    });
    if (fired) {
      rules.push(rule.name);
    }
  }

  return { text: output, rules };
}

/** True when `text` contains something this module would mask. */
export function containsSecret(text: string): boolean {
  return redactSecrets(text).rules.length > 0;
}
