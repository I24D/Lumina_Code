/**
 * Rellena los `embedding` que faltan en las tablas de memoria de Supabase.
 *
 * La búsqueda semántica (`match_knowledge`, `match_memory_wiki`) descarta las
 * filas con `embedding IS NULL`, así que sin este relleno la memoria de Start
 * Talk no encuentra nada aunque los datos ya estén ahí. El script vectoriza con
 * el mismo modelo que usa la voz (`text-embedding-3-small`, 1536 dimensiones) y
 * solo toca las filas sin vector: es idempotente y no destructivo.
 *
 * Uso (desde continue-upstream/core):
 *   node scripts/backfillMemoryEmbeddings.mjs           # rellena
 *   node scripts/backfillMemoryEmbeddings.mjs --dry-run # solo cuenta
 *
 * Requiere en el .env de la raíz: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY y
 * OPENAI_API_KEY. La service_role solo viaja hacia Supabase.
 */
import * as dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dryRun = process.argv.includes("--dry-run");

function loadRootEnv() {
  let current = here;
  while (true) {
    const candidate = resolve(current, ".env");
    if (existsSync(candidate)) {
      return dotenv.parse(readFileSync(candidate));
    }
    const parent = dirname(current);
    if (parent === current) return {};
    current = parent;
  }
}

const env = { ...loadRootEnv(), ...process.env };
const SUPABASE_URL = (
  env.SUPABASE_URL ||
  env.LUMINA_SUPABASE_URL ||
  ""
).replace(/\/$/, "");
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY || "";
const OPENAI_KEY = env.START_TALK_OPENAI_API_KEY || env.OPENAI_API_KEY || "";
const EMBEDDING_MODEL = env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";

if (!SUPABASE_URL || !SERVICE_ROLE || !OPENAI_KEY) {
  console.error(
    "Faltan credenciales: define SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY y OPENAI_API_KEY en el .env de la raíz.",
  );
  process.exit(1);
}

const headers = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  Accept: "application/json",
};

function clip(value, max) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Las respuestas se guardaron como JSON {"answer": ...} o como texto plano. */
function knowledgeAnswer(raw) {
  const text = clip(raw, 8000);
  if (text.startsWith("{")) {
    try {
      return clip(JSON.parse(text).answer, 6000);
    } catch {
      /* texto tal cual */
    }
  }
  return text;
}

async function embed(text) {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text.slice(0, 8000),
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI embeddings HTTP ${response.status}`);
  }
  const data = await response.json();
  const vector = data.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length !== 1536) {
    throw new Error("Vector inesperado de OpenAI.");
  }
  return `[${vector.join(",")}]`;
}

async function selectMissing(table, columns) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?embedding=is.null&select=${columns}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`No pude leer ${table}: HTTP ${response.status}`);
  }
  return response.json();
}

async function patchEmbedding(table, idColumn, idValue, embedding) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${idColumn}=eq.${encodeURIComponent(idValue)}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ embedding }),
  });
  if (!response.ok) {
    throw new Error(
      `No pude actualizar ${table} ${idValue}: HTTP ${response.status} ${await response.text()}`,
    );
  }
}

async function backfill(table, idColumn, columns, textOf) {
  const rows = await selectMissing(table, columns);
  console.log(`${table}: ${rows.length} fila(s) sin embedding.`);
  if (dryRun || rows.length === 0) {
    return rows.length;
  }
  let done = 0;
  for (const row of rows) {
    const text = clip(textOf(row), 8000);
    if (!text) {
      continue;
    }
    const vector = await embed(text);
    await patchEmbedding(table, idColumn, row[idColumn], vector);
    done += 1;
    process.stdout.write(`  ${table}: ${done}/${rows.length}\r`);
  }
  console.log(`\n${table}: ${done} fila(s) vectorizada(s).`);
  return done;
}

async function main() {
  console.log(
    dryRun ? "Modo simulación (no escribe)." : "Rellenando embeddings…",
  );
  const knowledge = await backfill(
    "knowledge_entries",
    "id",
    "id,question,answer",
    (row) => `${row.question}\n${knowledgeAnswer(row.answer)}`,
  );
  const wiki = await backfill(
    "memory_wiki",
    "id",
    "id,title,summary,content",
    (row) => `${row.title}\n${row.summary}\n${clip(row.content, 6000)}`,
  );
  console.log(`Listo. knowledge_entries: ${knowledge}, memory_wiki: ${wiki}.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
