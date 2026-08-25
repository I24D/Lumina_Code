import {
  ArrowsPointingInIcon,
  BarsArrowDownIcon,
  Square2StackIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { ChatHistoryItem } from "core";
import { renderChatMessage } from "core/util/messageContent";
import { useContext, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { forkSession } from "../../redux/thunks/session";
import { useCompactConversation } from "../../util/compactConversation";
import { FeedbackButtons } from "../FeedbackButtons";
import { CopyIconButton } from "../gui/CopyIconButton";
import HeaderButtonWithToolTip from "../gui/HeaderButtonWithToolTip";

export interface ResponseActionsProps {
  isTruncated: boolean;
  onContinueGeneration: () => void;
  index: number;
  onDelete: () => void;
  item: ChatHistoryItem;
  isLast: boolean;
}

export default function ResponseActions({
  onContinueGeneration,
  index,
  item,
  isTruncated,
  onDelete,
  isLast,
}: ResponseActionsProps) {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const currentSessionId = useAppSelector((state) => state.session.id);
  const [forking, setForking] = useState(false);
  const contextPercentage = useAppSelector(
    (state) => state.session.contextPercentage,
  );
  const isPruned = useAppSelector((state) => state.session.isPruned);

  const percent = Math.round((contextPercentage ?? 0) * 100);
  const buttonColorClass =
    isLast && (isPruned || percent > 80)
      ? "text-warning"
      : "text-description-muted";

  const showLabel = isLast && (isPruned || percent >= 60);

  const compactConversation = useCompactConversation();

  const forkFromHere = async () => {
    if (forking) return;
    setForking(true);
    try {
      await dispatch(
        forkSession({
          sessionId: currentSessionId,
          historyIndex: index,
          saveCurrentSession: true,
        }),
      ).unwrap();
      ideMessenger.post("showToast", [
        "info",
        "Se creó una bifurcación desde este punto.",
      ]);
    } catch (error) {
      ideMessenger.post("showToast", [
        "error",
        `No se pudo bifurcar la sesión: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    } finally {
      setForking(false);
    }
  };

  return (
    <div className="text-description-muted mx-2 flex cursor-default items-center justify-end space-x-1 bg-transparent pb-0 text-xs">
      <HeaderButtonWithToolTip
        testId={`compact-button-${index}`}
        text={
          showLabel
            ? "Summarize conversation to reduce context length"
            : "Compact conversation"
        }
        tabIndex={-1}
        onClick={() => compactConversation(index)}
      >
        <div className="flex items-center space-x-1">
          <ArrowsPointingInIcon
            className={`h-3.5 w-3.5 ${buttonColorClass || "text-description-muted"}`}
          />
          {showLabel && (
            <span
              className={`text-xs ${buttonColorClass || "text-description-muted"}`}
            >
              Compact conversation
            </span>
          )}
        </div>
      </HeaderButtonWithToolTip>

      {isTruncated && (
        <HeaderButtonWithToolTip
          tabIndex={-1}
          text="Continue generation"
          onClick={onContinueGeneration}
        >
          <BarsArrowDownIcon className="text-description-muted h-3.5 w-3.5" />
        </HeaderButtonWithToolTip>
      )}

      <HeaderButtonWithToolTip
        testId={`fork-button-${index}`}
        text="Fork conversation from here"
        tabIndex={-1}
        disabled={forking}
        onClick={forkFromHere}
      >
        <Square2StackIcon className="text-description-muted h-3.5 w-3.5" />
      </HeaderButtonWithToolTip>

      <HeaderButtonWithToolTip
        testId={`delete-button-${index}`}
        text="Delete"
        tabIndex={-1}
        onClick={onDelete}
      >
        <TrashIcon className="text-description-muted h-3.5 w-3.5" />
      </HeaderButtonWithToolTip>

      <CopyIconButton
        tabIndex={-1}
        text={renderChatMessage(item.message)}
        clipboardIconClassName="h-3.5 w-3.5 text-description-muted"
        checkIconClassName="h-3.5 w-3.5 text-success"
      />

      <FeedbackButtons item={item} />
    </div>
  );
}
