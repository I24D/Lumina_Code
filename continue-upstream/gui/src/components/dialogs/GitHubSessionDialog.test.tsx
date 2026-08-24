import { configureStore } from "@reduxjs/toolkit";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";
import { setShowDialog, uiSlice } from "../../redux/slices/uiSlice";
import { GitHubSessionDialog } from "./GitHubSessionDialog";

function renderDialog(onSubmit = vi.fn().mockResolvedValue(undefined)) {
  const store = configureStore({ reducer: { uiState: uiSlice.reducer } });
  store.dispatch(setShowDialog(true));
  render(
    <Provider store={store}>
      <GitHubSessionDialog onSubmit={onSubmit} />
    </Provider>,
  );
  return { store, onSubmit };
}

describe("GitHubSessionDialog", () => {
  it("does not accept an empty reference", async () => {
    const { onSubmit } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Preparar sesión" }));
    expect(await screen.findByText(/pega el enlace/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("loads the reference and closes only after success", async () => {
    const { store, onSubmit } = renderDialog();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "  https://github.com/acme/app/issues/12  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preparar sesión" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        "https://github.com/acme/app/issues/12",
      ),
    );
    expect(store.getState().uiState.showDialog).toBe(false);
  });

  it("keeps the reference visible when the backend rejects it", async () => {
    const { store } = renderDialog(
      vi.fn().mockRejectedValue(new Error("GitHub respondió 404")),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "acme/private#9" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preparar sesión" }));

    expect(await screen.findByText("GitHub respondió 404")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("acme/private#9");
    expect(store.getState().uiState.showDialog).toBe(true);
  });
});
