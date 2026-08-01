import { LockOpenIcon } from "@heroicons/react/24/outline";
import { useAppDispatch, useAppSelector } from "../../../../redux/hooks";
import { selectPendingToolCalls } from "../../../../redux/selectors/selectToolCalls";
import { setFullAccess } from "../../../../redux/slices/uiSlice";
import { callToolById } from "../../../../redux/thunks/callToolById";
import { cancelToolCallThunk } from "../../../../redux/thunks/cancelToolCall";
import { getAltKeyLabel, getMetaKeyLabel, isJetBrains } from "../../../../util";
import { Button } from "../../../ui";
import { useMainEditor } from "../../TipTapEditor";

export const generateToolCallButtonTestId = (
  action: "accept" | "reject",
  toolCallId: string,
) => {
  return `${action}-tool-call-button-${toolCallId}`;
};

export function PendingToolCallToolbar() {
  const dispatch = useAppDispatch();
  const jetbrains = isJetBrains();
  const pendingToolCalls = useAppSelector(selectPendingToolCalls);
  const fullAccess = useAppSelector((state) => state.ui.fullAccess);
  const editor = useMainEditor();

  if (pendingToolCalls.length === 0) {
    return null;
  }

  const handleAccept = (toolCallId: string) => {
    void dispatch(callToolById({ toolCallId }));
  };

  const handleReject = (toolCallId: string) => {
    // put cursor in editor after last rejection
    if (pendingToolCalls.length === 1) {
      editor.mainEditor?.commands.focus();
    }
    void dispatch(cancelToolCallThunk({ toolCallId }));
  };

  const handleFullAccessToggle = () => {
    const nextFullAccess = !fullAccess;
    dispatch(setFullAccess(nextFullAccess));

    if (nextFullAccess) {
      for (const toolCall of pendingToolCalls) {
        void dispatch(
          callToolById({
            toolCallId: toolCall.toolCallId,
            isAutoApproved: true,
          }),
        );
      }
    }
  };

  return (
    <div className="flex w-full flex-col pb-0.5">
      {pendingToolCalls.map((toolCall, index) => (
        <div
          key={toolCall.toolCallId}
          className="border-input bg-input flex items-center gap-2 rounded border"
        >
          <span className="text-description flex-1 truncate text-xs italic">
            {toolCall.tool?.displayTitle ?? toolCall.toolCall.function.name}
          </span>

          <div className="flex items-center gap-1">
            <Button
              variant={fullAccess ? "primary" : "ghost"}
              size="sm"
              className="my-1 flex items-center gap-1 font-medium"
              aria-pressed={fullAccess}
              onClick={handleFullAccessToggle}
            >
              <LockOpenIcon className="h-3 w-3" />
              <span>{fullAccess ? "Full access on" : "Full access"}</span>
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className="text-description-muted my-1 font-medium"
              onClick={() => handleReject(toolCall.toolCallId)}
              data-testid={generateToolCallButtonTestId(
                "reject",
                toolCall.toolCallId,
              )}
            >
              {/* JetBrains overrides cmd+backspace, so we have to use another shortcut */}
              {index === 0 && (
                <span className="text-2xs mr-1">
                  {jetbrains ? getAltKeyLabel() : getMetaKeyLabel()}Backspace
                </span>
              )}
              <span>Reject</span>
            </Button>

            <Button
              variant="primary"
              size="sm"
              className="my-1 font-medium"
              onClick={() => handleAccept(toolCall.toolCallId)}
              data-testid={generateToolCallButtonTestId(
                "accept",
                toolCall.toolCallId,
              )}
            >
              {index === 0 && (
                <span className="text-2xs mr-1">{getMetaKeyLabel()}Enter</span>
              )}
              <span>Accept</span>
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
