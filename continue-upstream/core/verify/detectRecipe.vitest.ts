import { describe, expect, it } from "vitest";

import { detectRecipe, formatRecipe } from "./detectRecipe";
import { ProjectFiles } from "./types";

/** A workspace as a literal file map, which is all detection actually needs. */
function project(files: Record<string, string>): ProjectFiles {
  return {
    async exists(path) {
      return path in files;
    },
    async read(path) {
      return files[path];
    },
  };
}

function packageJson(value: unknown): string {
  return JSON.stringify(value);
}

describe("detectRecipe", () => {
  it("returns nothing for a workspace with no recognised manifest", async () => {
    expect(await detectRecipe(project({ "README.md": "# hi" }))).toBeUndefined();
  });

  describe("Node.js", () => {
    it("reads the commands off package.json scripts", async () => {
      const recipe = await detectRecipe(
        project({
          "package.json": packageJson({
            scripts: { build: "tsc", test: "vitest run" },
          }),
        }),
      );

      expect(recipe?.kind).toBe("node");
      expect(recipe?.build).toEqual(["npm run build"]);
      // `npm test` is the canonical spelling; `npm run test` also works but is
      // not what a Node developer writes.
      expect(recipe?.test).toEqual(["npm test"]);
    });

    it("offers no test command when the project declares no test script", async () => {
      const recipe = await detectRecipe(
        project({ "package.json": packageJson({ scripts: { build: "tsc" } }) }),
      );

      // Suggesting `npm test` here would produce a confident failure.
      expect(recipe?.test).toEqual([]);
    });

    it.each([
      ["pnpm-lock.yaml", "pnpm install"],
      ["yarn.lock", "yarn install"],
      ["bun.lockb", "bun install"],
      ["package-lock.json", "npm ci"],
    ])("uses the package manager that %s implies", async (lockfile, command) => {
      const recipe = await detectRecipe(
        project({ "package.json": packageJson({}), [lockfile]: "" }),
      );
      expect(recipe?.bootstrap).toEqual([command]);
    });

    it("falls back to npm install with no lockfile", async () => {
      const recipe = await detectRecipe(
        project({ "package.json": packageJson({}) }),
      );
      expect(recipe?.bootstrap).toEqual(["npm install"]);
    });

    it.each([
      ["next", "Node.js (Next.js)", 3000],
      ["vite", "Node.js (Vite)", 5173],
      ["astro", "Node.js (Astro)", 4321],
      ["@nestjs/core", "Node.js (NestJS)", 3000],
    ])("recognises %s and its port", async (dependency, name, port) => {
      const recipe = await detectRecipe(
        project({
          "package.json": packageJson({
            dependencies: { [dependency]: "1.0.0" },
            scripts: { dev: "x" },
          }),
        }),
      );

      expect(recipe?.name).toBe(name);
      expect(recipe?.port).toBe(port);
      expect(recipe?.start).toBe("npm run dev");
    });

    it("finds a framework declared as a dev dependency", async () => {
      const recipe = await detectRecipe(
        project({
          "package.json": packageJson({ devDependencies: { vite: "5.0.0" } }),
        }),
      );
      expect(recipe?.kind).toBe("node-vite");
    });

    it("survives a malformed package.json instead of throwing", async () => {
      // A half-written manifest is a normal state mid-edit.
      const recipe = await detectRecipe(
        project({ "package.json": "{ not json", "go.mod": "module x" }),
      );
      expect(recipe?.kind).toBe("go");
    });
  });

  describe("Python", () => {
    it("recognises Django by its manage.py", async () => {
      const recipe = await detectRecipe(
        project({ "manage.py": "", "requirements.txt": "django" }),
      );

      expect(recipe?.kind).toBe("python-django");
      // Django's suite is not pytest, which is exactly the kind of wrong guess
      // this tool exists to prevent.
      expect(recipe?.test).toEqual(["python manage.py test"]);
    });

    it("uses poetry when pyproject declares it", async () => {
      const recipe = await detectRecipe(
        project({ "pyproject.toml": "[tool.poetry]\nname = 'x'" }),
      );
      expect(recipe?.bootstrap).toEqual(["poetry install"]);
    });

    it("installs the package itself when pyproject is not poetry", async () => {
      const recipe = await detectRecipe(
        project({ "pyproject.toml": "[project]\nname = 'x'" }),
      );
      expect(recipe?.bootstrap).toEqual(["pip install -e ."]);
    });

    it.each([
      ["fastapi", "python-fastapi", "/docs"],
      ["flask", "python-flask", "/"],
    ])("recognises %s", async (dependency, kind, readiness) => {
      const recipe = await detectRecipe(
        project({ "pyproject.toml": `dependencies = ["${dependency}"]` }),
      );
      expect(recipe?.kind).toBe(kind);
      expect(recipe?.readinessPath).toBe(readiness);
    });

    it("falls back to plain pytest", async () => {
      const recipe = await detectRecipe(
        project({ "requirements.txt": "requests" }),
      );
      expect(recipe?.kind).toBe("python");
      expect(recipe?.test).toEqual(["pytest"]);
    });
  });

  it.each([
    ["go.mod", "module x", "go", "go test ./..."],
    ["Cargo.toml", "[package]", "rust", "cargo test"],
    ["pom.xml", "<project/>", "java-maven", "mvn test"],
  ])("recognises %s", async (file, contents, kind, test) => {
    const recipe = await detectRecipe(project({ [file]: contents }));
    expect(recipe?.kind).toBe(kind);
    expect(recipe?.test).toEqual([test]);
  });

  describe("Gradle", () => {
    it("prefers the wrapper when the repo ships one", async () => {
      const recipe = await detectRecipe(
        project({ "build.gradle": "", gradlew: "" }),
      );
      // The wrapper pins the Gradle version; the system one may not match.
      expect(recipe?.test).toEqual(["./gradlew test"]);
    });

    it("falls back to the system gradle without a wrapper", async () => {
      const recipe = await detectRecipe(project({ "build.gradle": "" }));
      expect(recipe?.test).toEqual(["gradle test"]);
    });
  });

  describe("Makefile", () => {
    it("maps its targets onto the recipe", async () => {
      const recipe = await detectRecipe(
        project({
          Makefile: "install:\n\tpip install\n\nbuild:\n\tcc x\n\ntest:\n\t./run",
        }),
      );

      expect(recipe?.bootstrap).toEqual(["make install"]);
      expect(recipe?.build).toEqual(["make build"]);
      expect(recipe?.test).toEqual(["make test"]);
    });

    it("ignores variable assignments that look like targets", async () => {
      const recipe = await detectRecipe(
        project({ Makefile: "CC := gcc\nFLAGS ?= -O2\ntest:\n\t./run" }),
      );
      expect(recipe?.test).toEqual(["make test"]);
      expect(recipe?.build).toEqual([]);
    });

    it("is skipped when it has no useful targets", async () => {
      const recipe = await detectRecipe(
        project({ Makefile: "clean:\n\trm -rf out", "go.mod": "module x" }),
      );
      expect(recipe?.kind).toBe("go");
    });
  });

  it("falls back to docker compose", async () => {
    const recipe = await detectRecipe(
      project({ "docker-compose.yml": "services: {}" }),
    );
    expect(recipe?.kind).toBe("compose");
    expect(recipe?.start).toBe("docker compose up");
  });

  describe("priority", () => {
    it("prefers package.json over a Makefile and compose", async () => {
      const recipe = await detectRecipe(
        project({
          "package.json": packageJson({ scripts: { test: "vitest" } }),
          Makefile: "test:\n\t./run",
          "docker-compose.yml": "services: {}",
        }),
      );
      // The real toolchain underneath is faster and more precise than either.
      expect(recipe?.kind).toBe("node");
    });

    it("prefers a language toolchain over compose", async () => {
      const recipe = await detectRecipe(
        project({ "Cargo.toml": "[package]", "compose.yaml": "services: {}" }),
      );
      expect(recipe?.kind).toBe("rust");
    });
  });

  it("always reports what it detected from", async () => {
    const recipe = await detectRecipe(
      project({ "package.json": packageJson({}), "pnpm-lock.yaml": "" }),
    );

    // Without evidence a wrong detection is indistinguishable from a right one.
    expect(recipe?.evidence).toContain("package.json");
    expect(recipe?.evidence).toContain("pnpm-lock.yaml");
  });
});

describe("formatRecipe", () => {
  it("omits sections the project does not have", async () => {
    const recipe = (await detectRecipe(
      project({ "requirements.txt": "requests" }),
    ))!;
    const rendered = formatRecipe(recipe);

    expect(rendered).toContain("Test: pytest");
    expect(rendered).not.toContain("Build:");
    expect(rendered).toContain("Detected from:");
  });

  it("states where a started app should answer", async () => {
    const recipe = (await detectRecipe(
      project({
        "package.json": packageJson({
          dependencies: { vite: "5" },
          scripts: { dev: "vite" },
        }),
      }),
    ))!;

    expect(formatRecipe(recipe)).toContain("http://localhost:5173/");
  });
});
