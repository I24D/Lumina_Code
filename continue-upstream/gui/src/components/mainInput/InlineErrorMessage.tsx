import {
  describeLlmError,
  type LlmErrorCategory,
} from "core/llm/classifyLlmError";
import { useContext } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { setInlineErrorMessage } from "../../redux/slices/sessionSlice";

export type InlineErrorMessageType = LlmErrorCategory;

/**
 * Categories where opening the config is the actual next step. For a rate
 * limit or a provider outage it is not, and offering it there sends the user
 * to edit settings that are already correct.
 */
const CONFIG_FIXES: ReadonlySet<LlmErrorCategory> = new Set([
  "out-of-context",
  "auth",
  "billing",
  "model-not-found",
]);

/**
 * The stored value is a category, not the provider's text, so the wording is
 * looked up rather than re-derived: running detection on the category name
 * would fail, since "rate-limit" does not contain "rate limit".
 */
export default function InlineErrorMessage() {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const inlineErrorMessage = useAppSelector(
    (state) => state.session.inlineErrorMessage,
  );

  if (!inlineErrorMessage) {
    return null;
  }

  const { title, guidance } = describeLlmError(inlineErrorMessage);

  return (
    <div
      className="border-border relative m-2 flex flex-col rounded-md border border-solid bg-transparent p-4"
      data-testid={`inline-error-${inlineErrorMessage}`}
    >
      <p className="thread-message text-error text-center">{title}</p>
      <p className="text-description mb-2 text-center text-xs">{guidance}</p>
      <div className="text-description flex flex-row items-center justify-center gap-1.5 px-3">
        {CONFIG_FIXES.has(inlineErrorMessage) && (
          <>
            <div
              className="cursor-pointer text-xs hover:underline"
              onClick={() => {
                ideMessenger.post("config/openProfile", {
                  profileId: undefined,
                });
              }}
            >
              <span className="xs:flex hidden">Open config</span>
              <span className="xs:hidden">Config</span>
            </div>
            |
          </>
        )}
        <span
          className="cursor-pointer text-xs hover:underline"
          onClick={() => {
            dispatch(setInlineErrorMessage(undefined));
          }}
        >
          Hide
        </span>
      </div>
    </div>
  );
}
