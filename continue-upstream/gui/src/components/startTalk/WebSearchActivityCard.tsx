import {
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  MagnifyingGlassIcon,
} from "@heroicons/react/24/outline";
import styled from "styled-components";

import type { StartTalkToolActivity } from "./types";

export function safeSearchSourceUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return undefined;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

const Card = styled.details<{ $roomy: boolean }>`
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--live-border);
  border-radius: ${({ $roomy }) => ($roomy ? "10px" : "7px")};
  background: var(--live-control);
  color: var(--live-text);
  font-size: ${({ $roomy }) => ($roomy ? "12px" : "10px")};

  &[open] {
    border-color: var(--live-border-strong);
  }
`;

const Summary = styled.summary`
  display: grid;
  min-height: 30px;
  box-sizing: border-box;
  grid-template-columns: 17px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  cursor: pointer;
  list-style: none;
  padding: 6px 8px;

  &::-webkit-details-marker {
    display: none;
  }

  svg {
    width: 15px;
    height: 15px;
    color: var(--live-accent);
  }
`;

const SummaryCopy = styled.span`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Count = styled.span`
  color: var(--live-muted);
  font-size: 9px;
  white-space: nowrap;
`;

const Body = styled.div`
  display: grid;
  gap: 8px;
  border-top: 1px solid var(--live-border);
  padding: 8px;
`;

const SectionLabel = styled.div`
  color: var(--live-muted);
  font-size: 9px;
  font-weight: 760;
  letter-spacing: 0.06em;
  text-transform: uppercase;
`;

const Text = styled.div`
  color: var(--live-text);
  line-height: 1.45;
  overflow-wrap: anywhere;
  white-space: normal;
`;

const Disclosure = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 6px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--live-accent) 9%, transparent);
  color: var(--live-muted);
  line-height: 1.35;
  padding: 6px;

  svg {
    width: 13px;
    height: 13px;
    flex: 0 0 auto;
    margin-top: 1px;
  }
`;

const SourceList = styled.div`
  display: grid;
  gap: 5px;
`;

const Source = styled.button`
  display: grid;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  grid-template-columns: minmax(0, 1fr) 14px;
  gap: 6px;
  border: 1px solid var(--live-border);
  border-radius: 6px;
  background: var(--live-surface-elevated);
  color: var(--live-text);
  cursor: pointer;
  padding: 7px;
  text-align: left;

  &:hover {
    border-color: var(--live-accent);
  }

  svg {
    width: 13px;
    height: 13px;
    color: var(--live-muted);
  }
`;

const SourceTitle = styled.strong`
  display: block;
  overflow: hidden;
  font-size: 10px;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const SourceHost = styled.span`
  display: block;
  overflow: hidden;
  color: var(--live-accent);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Snippet = styled.span`
  display: block;
  margin-top: 3px;
  color: var(--live-muted);
  font-size: 10px;
  line-height: 1.4;
  overflow-wrap: anywhere;
  white-space: normal;
`;

export function WebSearchActivityCard({
  activity,
  roomy,
  onOpenUrl,
}: {
  activity: StartTalkToolActivity;
  roomy: boolean;
  onOpenUrl: (url: string) => void;
}) {
  const search = activity.webSearch;
  if (!search) return null;
  const successful = activity.status === "done";

  return (
    <Card $roomy={roomy} open={successful}>
      <Summary>
        {activity.status === "error" ? (
          <ExclamationCircleIcon />
        ) : activity.status === "done" ? (
          <CheckCircleIcon />
        ) : (
          <MagnifyingGlassIcon />
        )}
        <SummaryCopy>
          <strong>Búsqueda web</strong> · {search.query || "sin consulta"}
        </SummaryCopy>
        <Count>
          {activity.status === "running"
            ? "buscando…"
            : `${search.sources.length} fuentes`}
        </Count>
      </Summary>
      <Body>
        <div>
          <SectionLabel>Consulta enviada</SectionLabel>
          <Text>{search.query || "Sin consulta"}</Text>
        </div>
        {search.answer ? (
          <div>
            <SectionLabel>Resumen entregado a Lumina</SectionLabel>
            <Text>{search.answer}</Text>
          </div>
        ) : null}
        <Disclosure>
          {search.visibility === "payload" ? (
            <CheckCircleIcon />
          ) : (
            <ExclamationCircleIcon />
          )}
          <span>
            {search.visibility === "payload"
              ? "Abajo ves el resumen y los extractos exactos que recibió el modelo de voz."
              : "Google Live solo devolvió al cliente consultas y citas; no expuso los extractos de página leídos en sus servidores."}
          </span>
        </Disclosure>
        <div>
          <SectionLabel>
            Fuentes {search.provider ? `· ${search.provider}` : ""}
          </SectionLabel>
          <SourceList>
            {search.sources.map((source, index) => {
              const safeUrl = safeSearchSourceUrl(source.url);
              const host = safeUrl
                ? new URL(safeUrl).hostname
                : "fuente inválida";
              return (
                <Source
                  key={`${source.url}-${index}`}
                  type="button"
                  disabled={!safeUrl}
                  onClick={() => safeUrl && onOpenUrl(safeUrl)}
                >
                  <span>
                    <SourceTitle>{source.title || host}</SourceTitle>
                    <SourceHost>{host}</SourceHost>
                    {source.snippet ? (
                      <Snippet>{source.snippet}</Snippet>
                    ) : null}
                  </span>
                  <ArrowTopRightOnSquareIcon />
                </Source>
              );
            })}
            {search.sources.length === 0 ? (
              <Text>Todavía no hay fuentes disponibles.</Text>
            ) : null}
          </SourceList>
        </div>
      </Body>
    </Card>
  );
}
