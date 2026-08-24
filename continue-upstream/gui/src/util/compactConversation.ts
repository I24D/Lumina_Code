import { useContext } from "react";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../redux/hooks";
import {
  setCompactionLoading,
  deleteCompaction,
} from "../redux/slices/sessionSlice";
import { loadSession, saveCurrentSession } from "../redux/thunks/session";

export const useCompactConversation = () => {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const currentSessionId = useAppSelector((state) => state.session.id);

  return async (index: number) => {
    if (!currentSessionId) {
      ideMessenger.post("showToast", [
        "error",
        "No hay una sesión activa para compactar.",
      ]);
      return false;
    }

    try {
      // Set loading state
      dispatch(setCompactionLoading({ index, loading: true }));

      const response = await ideMessenger.request("conversation/compact", {
        index,
        sessionId: currentSessionId,
      });
      if (response.status === "error") {
        throw new Error(response.error);
      }

      // Reload the current session to refresh the conversation state
      await dispatch(
        loadSession({
          sessionId: currentSessionId,
          saveCurrentSession: false,
        }),
      ).unwrap();
      ideMessenger.post("showToast", [
        "info",
        "Conversación compactada correctamente.",
      ]);
      return true;
    } catch (error) {
      console.error("Error compacting conversation:", error);
      ideMessenger.post("showToast", [
        "error",
        `No se pudo compactar la conversación: ${error instanceof Error ? error.message : String(error)}`,
      ]);
      return false;
    } finally {
      // Clear loading state
      dispatch(setCompactionLoading({ index, loading: false }));
    }
  };
};

export const useDeleteCompaction = () => {
  const dispatch = useAppDispatch();

  return (index: number) => {
    // Update local state and save to persistence
    dispatch(deleteCompaction(index));
    dispatch(
      saveCurrentSession({
        openNewSession: false,
        generateTitle: false,
      }),
    );
  };
};
