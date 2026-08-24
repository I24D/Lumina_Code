import { describe, expect, it, vi } from "vitest";

import {
  buildBuiltInSlashCommands,
  groupSlashCommands,
  SLASH_CATEGORY,
} from "./builtInSlashCommands";
import type { ComboBoxItem } from "./types";

function makeContext(overrides = {}) {
  return {
    saveAndStartNewSession: vi.fn(),
    clearCurrentSession: vi.fn(),
    compactConversation: vi.fn(),
    historyLength: 4,
    toggleSessionGoal: vi.fn(),
    openGitHubSession: vi.fn(),
    goalSummary: undefined as string | undefined,
    openConfigTab: vi.fn(),
    navigateTo: vi.fn(),
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

  it("/new archiva la conversación y /clear la descarta", () => {
    // La diferencia importa: son los dos gestos distintos que ofrece OpenClaw,
    // y confundirlos haría perder historial sin avisar.
    const context = makeContext();
    const commands = buildBuiltInSlashCommands(context);

    commands.find((c) => c.title === "/new")!.action!();
    expect(context.saveAndStartNewSession).toHaveBeenCalledTimes(1);
    expect(context.clearCurrentSession).not.toHaveBeenCalled();

    commands.find((c) => c.title === "/clear")!.action!();
    expect(context.clearCurrentSession).toHaveBeenCalledTimes(1);
    expect(context.saveAndStartNewSession).toHaveBeenCalledTimes(1);
  });

  it("/compact avisa cuando no hay nada que compactar", () => {
    const empty = buildBuiltInSlashCommands(
      makeContext({ historyLength: 0 }),
    ).find((c) => c.title === "/compact")!;
    expect(empty.description).toMatch(/nada que compactar/i);

    const full = buildBuiltInSlashCommands(
      makeContext({ historyLength: 12 }),
    ).find((c) => c.title === "/compact")!;
    expect(full.description).toContain("12");
  });

  it("/goal muestra la meta activa cuando la hay", () => {
    const sin = buildBuiltInSlashCommands(makeContext()).find(
      (c) => c.title === "/goal",
    )!;
    expect(sin.description).toMatch(/fijar una meta/i);

    const con = buildBuiltInSlashCommands(
      makeContext({ goalSummary: "que pasen los tests" }),
    ).find((c) => c.title === "/goal")!;
    expect(con.description).toContain("que pasen los tests");
  });

  it("/github abre el flujo de sesión desde issue o PR", () => {
    const context = makeContext();
    buildBuiltInSlashCommands(context).find(
      (command) => command.title === "/github",
    )!.action!();

    expect(context.openGitHubSession).toHaveBeenCalledOnce();
  });

  it("/usage navega a las estadísticas", () => {
    const context = makeContext();
    buildBuiltInSlashCommands(context).find((c) => c.title === "/usage")!
      .action!();

    expect(context.navigateTo).toHaveBeenCalledWith("/stats");
  });

  it("/changes abre el recorrido guiado de diffs", () => {
    const context = makeContext();
    buildBuiltInSlashCommands(context).find(
      (command) => command.title === "/changes",
    )!.action!();

    expect(context.navigateTo).toHaveBeenCalledWith("/changes");
  });

  it("/work abre el panel de observabilidad", () => {
    const context = makeContext();
    buildBuiltInSlashCommands(context).find(
      (command) => command.title === "/work",
    )!.action!();

    expect(context.navigateTo).toHaveBeenCalledWith("/work");
  });

  it("/schedule abre el programador persistente", () => {
    const context = makeContext();
    buildBuiltInSlashCommands(context).find(
      (command) => command.title === "/schedule",
    )!.action!();

    expect(context.navigateTo).toHaveBeenCalledWith("/schedule");
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
    buildBuiltInSlashCommands(context).find((c) => c.title === "/mode")!
      .action!();
    expect(context.setMode).toHaveBeenCalledWith("agent");

    const fromAgent = makeContext({ currentMode: "agent" });
    buildBuiltInSlashCommands(fromAgent).find((c) => c.title === "/mode")!
      .action!();
    expect(fromAgent.setMode).toHaveBeenCalledWith("plan");

    // Y vuelve al principio en vez de quedarse atascado en el último.
    const fromPlan = makeContext({ currentMode: "plan" });
    buildBuiltInSlashCommands(fromPlan).find((c) => c.title === "/mode")!
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
