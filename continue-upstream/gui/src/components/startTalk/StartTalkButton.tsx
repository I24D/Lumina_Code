import { MicrophoneIcon } from "@heroicons/react/24/outline";
import { useContext } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { ToolTip } from "../gui/Tooltip";
import { Button } from "../ui";

export function StartTalkButton() {
  const ideMessenger = useContext(IdeMessengerContext);

  return (
    <>
      <ToolTip place="top" content="Start talk">
        <Button
          variant="ghost"
          size="sm"
          className="text-description flex items-center gap-1 !rounded-full px-1.5"
          onClick={(event) => {
            event.stopPropagation();
            // Abre Start Talk en una pestaña del navegador (fuera de VS Code),
            // no como overlay dentro del panel. El comando arranca el puente y
            // sirve la MISMA UI. Ver extension/startTalkOrb.ts.
            ideMessenger.post("startTalk/launchOrb", undefined);
          }}
          aria-label="Start talk"
        >
          <MicrophoneIcon className="h-3 w-3" />
          <span className="hidden lg:inline">Start talk</span>
        </Button>
      </ToolTip>
    </>
  );
}
