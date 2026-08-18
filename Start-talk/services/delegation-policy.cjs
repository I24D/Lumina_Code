"use strict";

const AUTHORIZATION_WINDOW_MS = 30_000;

const ACTION_PATTERN =
  /\b(haz|hacer|crea|crear|escribe|escribir|edita|editar|modifica|modificar|corrige|corregir|arregla|arreglar|ejecuta|ejecutar|corre|correr|inicia|iniciar|arranca|arrancar|levanta|levantar|abre|abrir|cierra|cerrar|instala|instalar|elimina|eliminar|borra|borrar|mueve|mover|copia|copiar|descarga|descargar|sube|subir|publica|publicar|envia|enviar|manda|mandar|responde|responder|revisa|revisar|investiga|investigar|analiza|analizar|inspecciona|inspeccionar|controla|controlar|presiona|presionar|pulsa|pulsar|ve|dirigete|clic|captura|create|write|edit|modify|fix|run|execute|start|launch|open|close|install|delete|remove|move|copy|download|upload|post|publish|send|reply|review|research|analyze|inspect|control|press|click|screenshot)\b/;

const DOMAIN_PATTERNS = {
  code: /\b(code|codigo|script|python|javascript|typescript|node|npm|powershell|terminal|consola|programa|program|proyecto|project|repo|repositorio|repository|archivo|file|carpeta|folder|directorio|directory|build|compila|compilar|test|prueba|vsix|git)\b/,
  pc: /\b(windows|pc|computadora|computer|desktop|escritorio|aplicacion|application|app|ventana|window|mouse|raton|teclado|keyboard|clipboard|portapapeles|captura|screenshot|chrome|edge|navegador|browser|whatsapp|outlook|teams|abre|abrir|cierra|cerrar|instala|instalar|elimina|eliminar|borra|borrar|clic|click|presiona|press|pulsa)\b/,
};

const TOKEN_ALIASES = new Map([
  ["codigo", "code"],
  ["archivo", "file"],
  ["carpeta", "folder"],
  ["directorio", "directory"],
  ["proyecto", "project"],
  ["repositorio", "repository"],
  ["consola", "terminal"],
  ["computadora", "computer"],
  ["escritorio", "desktop"],
  ["aplicacion", "application"],
  ["ventana", "window"],
  ["raton", "mouse"],
  ["teclado", "keyboard"],
  ["portapapeles", "clipboard"],
  ["captura", "screenshot"],
  ["navegador", "browser"],
  ["prueba", "test"],
  ["compila", "build"],
  ["compilar", "build"],
]);

const IGNORED_TOKENS = new Set([
  "a", "al", "and", "con", "de", "del", "el", "en", "for", "la", "las",
  "lo", "los", "me", "mi", "of", "para", "por", "que", "the", "this", "to",
  "un", "una", "y",
]);

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_+#.-]+/g, " ")
    .trim();
}

function canonicalTokens(value) {
  return new Set(
    normalizeText(value)
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !IGNORED_TOKENS.has(token))
      .map((token) => TOKEN_ALIASES.get(token) ?? token),
  );
}

function domainsFor(value) {
  const normalized = normalizeText(value);
  return Object.entries(DOMAIN_PATTERNS)
    .filter(([, pattern]) => pattern.test(normalized))
    .map(([domain]) => domain);
}

function mergeTranscriptText(previous, next) {
  const current = String(previous ?? "").trim();
  const incoming = String(next ?? "").trim();
  if (!current) return incoming;
  if (!incoming) return current;
  if (incoming.startsWith(current)) return incoming;
  if (current.endsWith(incoming)) return current;
  return `${current} ${incoming}`;
}

function authorizeDelegation({
  task,
  userText,
  userTextAt,
  externalTextTurnActive,
  now = Date.now(),
}) {
  const normalizedTask = normalizeText(task);
  const normalizedUserText = normalizeText(userText);

  if (externalTextTurnActive) {
    return { authorized: false, reason: "external_text_turn" };
  }
  if (!normalizedTask) {
    return { authorized: false, reason: "empty_task" };
  }
  if (!normalizedUserText || !Number.isFinite(userTextAt)) {
    return { authorized: false, reason: "no_spoken_request" };
  }
  if (now - userTextAt > AUTHORIZATION_WINDOW_MS) {
    return { authorized: false, reason: "stale_spoken_request" };
  }
  if (!ACTION_PATTERN.test(normalizedUserText)) {
    return { authorized: false, reason: "no_explicit_action" };
  }

  const userDomains = domainsFor(normalizedUserText);
  const taskDomains = domainsFor(normalizedTask);
  if (userDomains.length === 0 || taskDomains.length === 0) {
    return { authorized: false, reason: "not_local_code_or_pc_action" };
  }
  if (!userDomains.some((domain) => taskDomains.includes(domain))) {
    return { authorized: false, reason: "action_domain_mismatch" };
  }

  const userTokens = canonicalTokens(normalizedUserText);
  const taskTokens = canonicalTokens(normalizedTask);
  const sharedTokens = [...userTokens].filter((token) => taskTokens.has(token));
  if (sharedTokens.length === 0) {
    return { authorized: false, reason: "task_does_not_match_request" };
  }

  return { authorized: true, reason: "explicit_matching_spoken_request" };
}

module.exports = {
  AUTHORIZATION_WINDOW_MS,
  authorizeDelegation,
  mergeTranscriptText,
  normalizeText,
};
