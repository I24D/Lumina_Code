import { describe, expect, it, vi } from "vitest";

import {
  buildBuiltInSlashCommands,
  groupSlashCommands,
  SLASH_CATEGORY,
} from "./builtInSlashCommands";
import type { ComboBoxItem } from "./types";

function makeContext(overrides = {}) {
  return {
    newSession: vi.fn(),
    openConfigTab: vi.fn(),
    setMode: vi.fn(),
    currentMode: "agent",
    stopStreaming: vi.fn(),
    isStreaming: false,
    currentModel: "glm-5.2",
    ...overrides,
  };
}

describe("buildBuiltInSlashCommands", () => {
  it("todos son acciones ejecutables, no plantillas de texto", () => {
    // Si alguno cayera a `slashCommand`, el desplegable lo insertaría como
    // prompt en el editor en vez de ejecutarlo.
    for (const command of buildBuiltInSlashCommands(makeContext())) {
      expect(command.type).toBe("action");
      expect(typeof command.action).toBe("function");
    }
  });

  it("todos empiezan por barra y no se repiten", () => {
    const commands = buildBuiltInSlashCommands(makeContext());
    const titles = commands.map((c) => c.title);

    for (const title of titles) {
      expect(title.startsWith("/")).toBe(true);
    }
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("/new abre una sesión nueva", () => {
    const context = makeContext();
    const command = buildBuiltInSlashCommands(context).find(
      (c) => c.title === "/new",
    )!;
    command.action!();

    expect(context.newSession).toHaveBeenCalledTimes(1);
  });

  it("/privacy abre justo la pestaña de privacidad", () => {
    const context = makeContext();
    const command = buildBuiltInSlashCommands(context).find(
      (c) => c.title === "/privacy",
    )!;
    command.action!();

    expect(context.openConfigTab).toHaveBeenCalledWith("privacy");
  });

  it("/mode rota entre los tres modos", () => {
    const context = makeContext({ currentMode: "chat" });
    buildBuiltInSlashCommands(context)
      .find((c) => c.title === "/mode")!
      .action!();
    expect(context.setMode).toHaveBeenCalledWith("agent");

    const fromAgent = makeContext({ currentMode: "agent" });
    buildBuiltInSlashCommands(fromAgent)
      .find((c) => c.title === "/mode")!
      .action!();
    expect(fromAgent.setMode).toHaveBeenCalledWith("plan");

    // Y vuelve al principio en vez de quedarse atascado en el último.
    const fromPlan = makeContext({ currentMode: "plan" });
    buildBuiltInSlashCommands(fromPlan)
      .find((c) => c.title === "/mode")!
      .action!();
    expect(fromPlan.setMode).toHaveBeenCalledWith("chat");
  });

  it("/stop dice que no hay nada que detener cuando no se genera", () => {
    const idle = buildBuiltInSlashCommands(
      makeContext({ isStreaming: false }),
    ).find((c) => c.title === "/stop")!;
    expect(idle.description).toMatch(/nada que detener/i);

    const busy = buildBuiltInSlashCommands(
      makeContext({ isStreaming: true }),
    ).find((c) => c.title === "/stop")!;
    expect(busy.description).toMatch(/detener/i);
  });

  it("muestra el modelo activo en /model", () => {
    const command = buildBuiltInSlashCommands(
      makeContext({ currentModel: "glm-5.2" }),
    ).find((c) => c.title === "/model")!;

    expect(command.description).toContain("glm-5.2");
  });
});

describe("groupSlashCommands", () => {
  const prompt: ComboBoxItem = {
    title: "/explicar",
    description: "Prompt del usuario",
    type: "slashCommand",
  };

  it("pone los comandos integrados antes que los prompts", () => {
    const grouped = groupSlashCommands([
      prompt,
      ...buildBuiltInSlashCommands(makeContext()),
    ]);

    expect(grouped[grouped.length - 1].title).toBe("/explicar");
  });

  it("agrupa por categoría en el orden esperado", () => {
    const grouped = groupSlashCommands(
      buildBuiltInSlashCommands(makeContext()),
    );
    const categories = grouped
      .map((c) => c.category)
      .filter((c, i, all) => c !== all[i - 1]);

    expect(categories).toEqual([
      SLASH_CATEGORY.session,
      SLASH_CATEGORY.model,
      SLASH_CATEGORY.tools,
    ]);
  });

  it("no pierde ni duplica elementos", () => {
    const input = [prompt, ...buildBuiltInSlashCommands(makeContext())];
    const grouped = groupSlashCommands(input);

    expect(grouped).toHaveLength(input.length);
    expect(new Set(grouped.map((c) => c.title)).size).toBe(input.length);
  });
});
