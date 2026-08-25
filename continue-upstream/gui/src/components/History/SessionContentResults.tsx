import type { SessionSearchHit } from "core/learning/SessionSearchIndex";
import { useContext, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch } from "../../redux/hooks";
import { exitEdit } from "../../redux/thunks/edit";
import { loadSession } from "../../redux/thunks/session";

/** Long enough that typing a word does not fire a query per keystroke. */
const DEBOUNCE_MS = 300;

function formatDate(value: string): string {
  const asNumber = Number(value);
  const date =
    Number.isFinite(asNumber) && asNumber > 0
      ? new Date(asNumber)
      : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

/**
 * Full-text results from inside past conversations.
 *
 * The sibling title search runs in the browser over metadata already in the
 * store; this one has to cross into core because message bodies live on disk
 * and are indexed there. That difference is why this component owns debouncing
 * and its own loading state — the title search is instant and needs neither.
 */
export function SessionContentResults({ query }: { query: string }) {
  const ideMessenger = useContext(IdeMessengerContext);
  const dispatch = useAppDispatch();
  const navigate = useNavigate();

  const [hits, setHits] = useState<SessionSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      setHits([]);
      setError(undefined);
      setLoading(false);
      return;
    }

    // Guards against a slow early query overwriting a fast later one.
    let cancelled = false;
    setLoading(true);

    const timer = setTimeout(() => {
      void ideMessenger
        .request("sessions/search", { query: trimmed, limit: 25 })
        .then((result) => {
          if (cancelled) {
            return;
          }
          if (result.status === "success") {
            setHits(result.content.hits);
            setError(undefined);
          } else {
            setHits([]);
            setError(result.error ?? "Search failed.");
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, ideMessenger]);

  const openHit = async (hit: SessionSearchHit) => {
    await dispatch(exitEdit({}));
    await dispatch(
      loadSession({ sessionId: hit.sessionId, saveCurrentSession: true }),
    );
    navigate("/");
  };

  if (loading && hits.length === 0) {
    return (
      <div className="m-3 text-center text-xs opacity-75">
        Searching conversations…
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="m-3 text-center text-xs opacity-75"
        data-testid="session-search-error"
      >
        {error}
      </div>
    );
  }

  if (hits.length === 0) {
    return (
      <div
        className="m-3 text-center text-xs opacity-75"
        data-testid="session-search-empty"
      >
        No messages matched. Every word must appear — try fewer words, or{" "}
        <code>OR</code> between them.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 px-1" data-testid="session-search-hits">
      {hits.map((hit) => (
        <div
          key={`${hit.sessionId}:${hit.messageIndex}`}
          className="hover:bg-input box-border flex w-full cursor-pointer flex-col gap-1 rounded-lg p-3"
          onClick={() => void openHit(hit)}
        >
          <div className="flex items-center gap-2">
            <span className="line-clamp-1 break-all text-sm font-semibold">
              {hit.title || "untitled"}
            </span>
            <span className="text-description-muted ml-auto whitespace-nowrap text-xs">
              {formatDate(hit.dateCreated)}
            </span>
          </div>
          <div className="text-description-muted line-clamp-3 text-xs">
            <span className="opacity-75">{hit.role}: </span>
            {hit.snippet}
          </div>
        </div>
      ))}
    </div>
  );
}
