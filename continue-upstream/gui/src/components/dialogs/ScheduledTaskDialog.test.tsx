import { configureStore } from "@reduxjs/toolkit";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";
import { setShowDialog, uiSlice } from "../../redux/slices/uiSlice";
import { ScheduledTaskDialog } from "./ScheduledTaskDialog";

function renderDialog(onSubmit = vi.fn().mockResolvedValue(undefined)) {
  const store = configureStore({ reducer: { uiState: uiSlice.reducer } });
  store.dispatch(setShowDialog(true));
  render(
    <Provider store={store}>
      <ScheduledTaskDialog onSubmit={onSubmit} />
    </Provider>,
  );
  return { store, onSubmit };
}

describe("ScheduledTaskDialog", () => {
  it("requires a name and prompt", async () => {
    const { onSubmit } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(
      await screen.findByText(/completa el nombre y el prompt/i),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("creates a daily task with explicit authorization settings", async () => {
    const { store, onSubmit } = renderDialog();
    fireEvent.change(screen.getByPlaceholderText(/revisar tests/i), {
      target: { value: "Pruebas diarias" },
    });
    fireEvent.change(screen.getByPlaceholderText(/ejecuta los tests/i), {
      target: { value: "Ejecuta npm test" },
    });
    fireEvent.change(screen.getByLabelText("Hora"), {
      target: { value: "08:30" },
    });
    fireEvent.click(screen.getByText(/ejecutar como meta/i));
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Pruebas diarias",
          prompt: "Ejecuta npm test",
          enabled: true,
          schedule: { kind: "daily", time: "08:30" },
          runAsGoal: true,
          maxTurns: 12,
        }),
      ),
    );
    expect(store.getState().uiState.showDialog).toBe(false);
  });
});
