import { configureStore } from "@reduxjs/toolkit";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";
import { setShowDialog, uiSlice } from "../../redux/slices/uiSlice";
import { SessionGoalDialog } from "./SessionGoalDialog";

function renderDialog(onSubmit = vi.fn().mockResolvedValue(undefined)) {
  const store = configureStore({ reducer: { uiState: uiSlice.reducer } });
  store.dispatch(setShowDialog(true));
  const result = render(
    <Provider store={store}>
      <SessionGoalDialog onSubmit={onSubmit} />
    </Provider>,
  );
  return { ...result, store, onSubmit };
}

describe("SessionGoalDialog", () => {
  it("requires a non-empty goal", async () => {
    const { onSubmit } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Iniciar meta" }));

    expect(
      await screen.findByText(/describe el resultado/i),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits a trimmed goal and closes on success", async () => {
    const { store, onSubmit } = renderDialog();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "  arregla el build  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar meta" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith("arregla el build"),
    );
    expect(store.getState().uiState.showDialog).toBe(false);
  });

  it("keeps the dialog open and exposes backend errors", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("Core no disponible"));
    const { store } = renderDialog(onSubmit);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "termina la tarea" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar meta" }));

    expect(await screen.findByText("Core no disponible")).toBeInTheDocument();
    expect(store.getState().uiState.showDialog).not.toBe(false);
  });
});
