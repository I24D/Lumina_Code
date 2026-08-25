import { ProjectFiles, VerificationRecipe } from "./types.js";

/**
 * Detects how to bootstrap, build, test and run a project.
 *
 * Ported from Hermes's recipe detectors, in its priority order: the first
 * match wins, and package.json wins over everything else. That order is not
 * arbitrary — a Node project with a Makefile is still a Node project, and a
 * repo with a docker-compose.yml usually has a real toolchain underneath it
 * that is faster to run directly.
 *
 * Every rule reports its evidence. A detector that quietly guesses wrong is
 * worse than no detector, because the agent then runs the wrong command
 * confidently.
 */

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * Picks the package manager from the lockfile that is actually present.
 * Running `npm install` in a pnpm workspace half-works and then fails in
 * confusing ways, so this is worth getting right rather than defaulting.
 */
async function detectNodeInstall(
  files: ProjectFiles,
): Promise<{ command: string; evidence: string }> {
  if (await files.exists("pnpm-lock.yaml")) {
    return { command: "pnpm install", evidence: "pnpm-lock.yaml" };
  }
  if (await files.exists("yarn.lock")) {
    return { command: "yarn install", evidence: "yarn.lock" };
  }
  if (await files.exists("bun.lockb")) {
    return { command: "bun install", evidence: "bun.lockb" };
  }
  if (await files.exists("package-lock.json")) {
    return { command: "npm ci", evidence: "package-lock.json" };
  }
  return { command: "npm install", evidence: "no lockfile" };
}

/** Framework, in dependency-precedence order, with the port it conventionally uses. */
const NODE_FRAMEWORKS: Array<{
  dependency: string;
  label: string;
  kind: string;
  port: number;
}> = [
  { dependency: "next", label: "Next.js", kind: "node-next", port: 3000 },
  { dependency: "nuxt", label: "Nuxt", kind: "node-nuxt", port: 3000 },
  { dependency: "@remix-run/react", label: "Remix", kind: "node-remix", port: 3000 },
  { dependency: "astro", label: "Astro", kind: "node-astro", port: 4321 },
  { dependency: "@nestjs/core", label: "NestJS", kind: "node-nest", port: 3000 },
  { dependency: "vite", label: "Vite", kind: "node-vite", port: 5173 },
  { dependency: "express", label: "Express", kind: "node-express", port: 3000 },
];

async function detectNode(
  files: ProjectFiles,
): Promise<VerificationRecipe | undefined> {
  const pkg = parseJson<PackageJson>(await files.read("package.json"));
  if (!pkg) {
    return undefined;
  }

  const evidence = ["package.json"];
  const scripts = pkg.scripts ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  const framework = NODE_FRAMEWORKS.find((entry) => entry.dependency in deps);
  if (framework) {
    evidence.push(`dependency: ${framework.dependency}`);
  }

  const install = await detectNodeInstall(files);
  evidence.push(install.evidence);

  // Only offer a script the project actually declares. Suggesting `npm test`
  // for a package with no test script produces a confident failure.
  const script = (name: string): string[] =>
    name in scripts ? [`npm run ${name}`] : [];

  const test =
    "test" in scripts
      ? // `npm test` is the canonical spelling and works without `run`.
        ["npm test"]
      : [];

  const startScript = ["dev", "start", "serve"].find((name) => name in scripts);

  return {
    name: framework ? `Node.js (${framework.label})` : "Node.js",
    kind: framework?.kind ?? "node",
    bootstrap: [install.command],
    build: script("build"),
    test,
    start: startScript ? `npm run ${startScript}` : undefined,
    port: framework?.port,
    readinessPath: "/",
    evidence,
  };
}

async function detectPython(
  files: ProjectFiles,
): Promise<VerificationRecipe | undefined> {
  const hasManage = await files.exists("manage.py");
  const pyproject = await files.read("pyproject.toml");
  const requirements = await files.exists("requirements.txt");

  if (!hasManage && !pyproject && !requirements) {
    return undefined;
  }

  const evidence: string[] = [];
  const bootstrap: string[] = [];

  if (pyproject) {
    evidence.push("pyproject.toml");
    bootstrap.push(
      pyproject.includes("[tool.poetry]")
        ? "poetry install"
        : "pip install -e .",
    );
  }
  if (requirements) {
    evidence.push("requirements.txt");
    bootstrap.push("pip install -r requirements.txt");
  }

  if (hasManage) {
    evidence.push("manage.py");
    return {
      name: "Python (Django)",
      kind: "python-django",
      bootstrap,
      build: [],
      test: ["python manage.py test"],
      start: "python manage.py runserver",
      port: 8000,
      readinessPath: "/",
      evidence,
    };
  }

  const haystack = `${pyproject ?? ""}`.toLowerCase();
  if (haystack.includes("fastapi")) {
    evidence.push("dependency: fastapi");
    return {
      name: "Python (FastAPI)",
      kind: "python-fastapi",
      bootstrap,
      build: [],
      test: ["pytest"],
      start: "uvicorn main:app --reload",
      port: 8000,
      readinessPath: "/docs",
      evidence,
    };
  }
  if (haystack.includes("flask")) {
    evidence.push("dependency: flask");
    return {
      name: "Python (Flask)",
      kind: "python-flask",
      bootstrap,
      build: [],
      test: ["pytest"],
      start: "flask run",
      port: 5000,
      readinessPath: "/",
      evidence,
    };
  }

  return {
    name: "Python",
    kind: "python",
    bootstrap,
    build: [],
    test: ["pytest"],
    evidence,
  };
}

async function detectGo(
  files: ProjectFiles,
): Promise<VerificationRecipe | undefined> {
  if (!(await files.exists("go.mod"))) {
    return undefined;
  }
  return {
    name: "Go",
    kind: "go",
    bootstrap: ["go mod download"],
    build: ["go build ./..."],
    test: ["go test ./..."],
    start: "go run .",
    evidence: ["go.mod"],
  };
}

async function detectRust(
  files: ProjectFiles,
): Promise<VerificationRecipe | undefined> {
  if (!(await files.exists("Cargo.toml"))) {
    return undefined;
  }
  return {
    name: "Rust",
    kind: "rust",
    bootstrap: ["cargo fetch"],
    build: ["cargo build"],
    test: ["cargo test"],
    start: "cargo run",
    evidence: ["Cargo.toml"],
  };
}

async function detectJava(
  files: ProjectFiles,
): Promise<VerificationRecipe | undefined> {
  if (await files.exists("pom.xml")) {
    return {
      name: "Java (Maven)",
      kind: "java-maven",
      bootstrap: ["mvn -q dependency:go-offline"],
      build: ["mvn -q -DskipTests package"],
      test: ["mvn test"],
      start: "mvn spring-boot:run",
      port: 8080,
      readinessPath: "/",
      evidence: ["pom.xml"],
    };
  }
  const gradle =
    (await files.exists("build.gradle")) ||
    (await files.exists("build.gradle.kts"));
  if (!gradle) {
    return undefined;
  }
  const wrapper = await files.exists("gradlew");
  const gradleCmd = wrapper ? "./gradlew" : "gradle";
  return {
    name: "Java (Gradle)",
    kind: "java-gradle",
    bootstrap: [],
    build: [`${gradleCmd} build -x test`],
    test: [`${gradleCmd} test`],
    start: `${gradleCmd} bootRun`,
    port: 8080,
    readinessPath: "/",
    evidence: wrapper ? ["build.gradle", "gradlew"] : ["build.gradle"],
  };
}

/** Targets in a Makefile, ignoring pattern rules and variables. */
function parseMakefileTargets(contents: string): string[] {
  const targets: string[] = [];
  for (const line of contents.split("\n")) {
    const match = /^([A-Za-z0-9_.-]+)\s*:(?!=)/u.exec(line);
    if (match) {
      targets.push(match[1]);
    }
  }
  return targets;
}

async function detectMakefile(
  files: ProjectFiles,
): Promise<VerificationRecipe | undefined> {
  const contents = await files.read("Makefile");
  if (contents === undefined) {
    return undefined;
  }
  const targets = new Set(parseMakefileTargets(contents));
  const pick = (...names: string[]) => names.find((name) => targets.has(name));

  const build = pick("build", "all", "compile");
  const test = pick("test", "check", "tests");
  const start = pick("run", "start", "dev", "serve");
  const bootstrap = pick("install", "deps", "setup", "bootstrap");

  if (!build && !test && !start) {
    return undefined;
  }

  return {
    name: "Makefile",
    kind: "make",
    bootstrap: bootstrap ? [`make ${bootstrap}`] : [],
    build: build ? [`make ${build}`] : [],
    test: test ? [`make ${test}`] : [],
    start: start ? `make ${start}` : undefined,
    evidence: [`Makefile targets: ${[...targets].join(", ")}`],
  };
}

async function detectCompose(
  files: ProjectFiles,
): Promise<VerificationRecipe | undefined> {
  for (const candidate of [
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
  ]) {
    if (await files.exists(candidate)) {
      return {
        name: "Docker Compose",
        kind: "compose",
        bootstrap: [],
        build: ["docker compose build"],
        test: [],
        start: "docker compose up",
        evidence: [candidate],
      };
    }
  }
  return undefined;
}

/**
 * Detectors in priority order. First match wins: a repo usually has several of
 * these signals, and the earlier ones describe the project more precisely than
 * the later ones.
 */
const DETECTORS = [
  detectNode,
  detectPython,
  detectGo,
  detectRust,
  detectJava,
  detectMakefile,
  detectCompose,
];

export async function detectRecipe(
  files: ProjectFiles,
): Promise<VerificationRecipe | undefined> {
  for (const detect of DETECTORS) {
    const recipe = await detect(files);
    if (recipe) {
      return recipe;
    }
  }
  return undefined;
}

/** Renders a recipe for a tool result. */
export function formatRecipe(recipe: VerificationRecipe): string {
  const lines = [`Project: ${recipe.name}`];
  const section = (label: string, commands: string[]) => {
    if (commands.length > 0) {
      lines.push(`${label}: ${commands.join(" && ")}`);
    }
  };
  section("Bootstrap", recipe.bootstrap);
  section("Build", recipe.build);
  section("Test", recipe.test);
  if (recipe.start) {
    const where = recipe.port
      ? ` (expects http://localhost:${recipe.port}${recipe.readinessPath ?? "/"})`
      : "";
    lines.push(`Start: ${recipe.start}${where}`);
  }
  lines.push(`Detected from: ${recipe.evidence.join(", ")}`);
  return lines.join("\n");
}
