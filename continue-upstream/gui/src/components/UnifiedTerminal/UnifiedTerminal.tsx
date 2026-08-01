import { ChevronDownIcon } from "@heroicons/react/24/outline";
import "@xterm/xterm/css/xterm.css";
import { ToolCallState } from "core";
import { useEffect, useMemo, useRef, useState } from "react";
import styled, { keyframes } from "styled-components";
import { useAppDispatch } from "../../redux/hooks";
import { moveTerminalProcessToBackground } from "../../redux/thunks/moveTerminalProcessToBackground";
import { getFontSize } from "../../util";
import { CopyButton } from "../StyledMarkdownPreview/StepContainerPreToolbar/CopyButton";
import { RunInTerminalButton } from "../StyledMarkdownPreview/StepContainerPreToolbar/RunInTerminalButton";
import { ButtonContent, SpoilerButton } from "../ui/SpoilerButton";

const blinkCursor = keyframes`
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
`;

const BlinkingCursor = styled.span`
  &::after {
    content: "\\2588";
    animation: ${blinkCursor} 1s infinite;
    color: var(--foreground);
  }
`;

const StyledTerminalContainer = styled.div<{
  fontSize?: number;
}>`
  background-color: var(--background);
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    Roboto,
    "Helvetica Neue",
    Arial,
    "Noto Sans",
    sans-serif;
  font-size: ${(props) => props.fontSize || getFontSize()}px;
  color: var(--foreground);
  line-height: 1.5;

  > *:last-child {
    margin-bottom: 0;
  }
`;

const TerminalContent = styled.div`
  pre {
    white-space: pre-wrap;
    max-width: calc(100vw - 24px);
    overflow-x: scroll;
    overflow-y: hidden;
    padding: 8px;
    margin: 0;
  }

  code {
    span.line:empty {
      display: none;
    }
    word-wrap: break-word;
    border-radius: 0.5rem;
    background-color: var(--editor-background);
    font-size: ${getFontSize() - 2}px;
    font-family:
      ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono",
      Menlo, monospace;
  }

  code:not(pre > code) {
    font-family:
      ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono",
      Menlo, monospace;
    color: var(--input-placeholder);
  }
`;

const CommandLine = styled.div`
  border-bottom: 1px solid var(--vscode-commandCenter-inactiveBorder, #555555);
  color: var(--input-placeholder);
  font-family:
    ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono",
    Menlo, monospace;
  font-size: ${getFontSize() - 2}px;
  overflow-wrap: anywhere;
  padding: 8px;
`;

const XtermOutputFrame = styled.div`
  box-sizing: border-box;
  min-height: 24px;
  width: 100%;
  overflow: hidden;
  border-radius: 4px;
  background-color: var(--editor-background);

  .xterm {
    padding: 8px;
  }

  .xterm-viewport {
    overflow-y: hidden !important;
  }
`;

function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") {
    return fallback;
  }

  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();

  return value || fallback;
}

function extractLinks(content: string): string[] {
  const links: string[] = [];
  const linkRegex = /(\s|^)(https?:\/\/[^\s]+|www\.[^\s]+\.[^\s]{2,})/g;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(content)) !== null) {
    const url = match[2];
    links.push(url.startsWith("www.") ? `http://${url}` : url);
  }

  return links;
}

function fixBackspace(txt: string) {
  let tmp = txt;
  do {
    txt = tmp;
    tmp = txt.replace(/[^\n]\x08/gm, "");
  } while (tmp.length < txt.length);
  return txt;
}

function XtermOutput({ content }: { content: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const normalizedContent = useMemo(() => fixBackspace(content), [content]);
  const links = useMemo(
    () => Array.from(new Set(extractLinks(normalizedContent))),
    [normalizedContent],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    container.textContent = "";

    const isTestEnvironment =
      typeof process !== "undefined" && process.env?.NODE_ENV === "test";
    if (isTestEnvironment) {
      return;
    }

    let isMounted = true;
    let terminal: { dispose: () => void } | undefined;
    let resizeObserver: ResizeObserver | undefined;

    const renderTerminal = async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] =
        await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/addon-web-links"),
        ]);

      if (!isMounted || !containerRef.current) {
        return;
      }

      const xterm = new Terminal({
        allowProposedApi: false,
        convertEol: true,
        cursorBlink: false,
        disableStdin: true,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
        fontSize: Math.max(getFontSize() - 2, 10),
        scrollback: 2_000,
        theme: {
          background: cssVar("--vscode-editor-background", "#1e1e1e"),
          foreground: cssVar("--vscode-editor-foreground", "#d4d4d4"),
          cursor: cssVar("--vscode-editor-foreground", "#d4d4d4"),
          selectionBackground: cssVar(
            "--vscode-editor-selectionBackground",
            "#264f78",
          ),
        },
      });
      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();

      terminal = xterm;
      xterm.loadAddon(fitAddon);
      xterm.loadAddon(webLinksAddon);
      xterm.open(containerRef.current);
      xterm.write(normalizedContent);

      const fitTerminal = () => {
        try {
          fitAddon.fit();
        } catch {
          // The terminal can be detached during React cleanup.
        }
      };

      window.requestAnimationFrame(fitTerminal);

      resizeObserver =
        typeof ResizeObserver !== "undefined"
          ? new ResizeObserver(fitTerminal)
          : undefined;
      resizeObserver?.observe(containerRef.current);
    };

    void renderTerminal();

    return () => {
      isMounted = false;
      resizeObserver?.disconnect();
      terminal?.dispose();
    };
  }, [normalizedContent]);

  return (
    <>
      <XtermOutputFrame ref={containerRef} data-testid="xterm-output" />
      <span className="hidden">{normalizedContent}</span>
      <span className="hidden">
        {links.map((href) => (
          <a key={href} href={href} target="_blank" rel="noreferrer">
            {href}
          </a>
        ))}
      </span>
    </>
  );
}

interface StatusIconProps {
  status: "running" | "completed" | "failed" | "background";
}

function StatusIcon({ status }: StatusIconProps) {
  const getStatusColor = () => {
    switch (status) {
      case "running":
        return "bg-success";
      case "completed":
        return "bg-success";
      case "background":
        return "bg-accent";
      case "failed":
        return "bg-error";
      default:
        return "bg-success";
    }
  };

  return (
    <span
      className={`mr-2 h-2 w-2 rounded-full ${getStatusColor()} ${
        status === "running" ? "animate-pulse" : ""
      }`}
    />
  );
}

interface IndicatorOnlyProps {
  hiddenLinesCount: number;
  isExpanded: boolean;
  onToggle: () => void;
}

function IndicatorOnly({
  hiddenLinesCount,
  isExpanded,
  onToggle,
}: IndicatorOnlyProps) {
  return (
    <div className="flex justify-center">
      <SpoilerButton onClick={onToggle}>
        <ButtonContent>
          <span>
            {isExpanded ? "Collapse" : `+${hiddenLinesCount} more lines`}
          </span>
          <ChevronDownIcon
            className={`h-3 w-3 ${isExpanded ? "rotate-180" : ""}`}
          />
        </ButtonContent>
      </SpoilerButton>
    </div>
  );
}

interface CollapsibleOutputContainerProps {
  limitedContent: string;
  fullContent: string;
  isExpanded: boolean;
  onToggle: () => void;
}

function CollapsibleOutputContainer({
  limitedContent,
  fullContent,
  isExpanded,
  onToggle,
}: CollapsibleOutputContainerProps) {
  return (
    <div className="relative">
      {/* Gradient overlay when collapsed */}
      {!isExpanded && (
        <div className="from-editor pointer-events-none absolute left-0 right-0 top-0 z-[5] h-[100px] rounded-t-md bg-gradient-to-b to-transparent" />
      )}

      <div onClick={onToggle} className="cursor-pointer">
        <div>
          <XtermOutput content={isExpanded ? fullContent : limitedContent} />
        </div>
      </div>
    </div>
  );
}

interface UnifiedTerminalCommandProps {
  command: string;
  output?: string;
  status?: "running" | "completed" | "failed" | "background";
  statusMessage?: string;
  toolCallState?: ToolCallState;
  toolCallId?: string;
  displayLines?: number;
}

export function UnifiedTerminalCommand({
  command,
  output = "",
  status = "completed",
  statusMessage = "",
  toolCallState,
  toolCallId,
  displayLines = 15,
}: UnifiedTerminalCommandProps) {
  const dispatch = useAppDispatch();
  const [isExpanded, setIsExpanded] = useState(true);
  const [outputExpanded, setOutputExpanded] = useState(false);

  // Determine running state
  const isRunning = toolCallState?.status === "calling" || status === "running";
  const hasOutput = output.length > 0;

  // Process terminal content for line limiting
  const processedTerminalContent = useMemo(() => {
    if (!output) {
      return {
        fullContent: "",
        limitedContent: "",
        totalLines: 0,
        isLimited: false,
        hiddenLinesCount: 0,
      };
    }

    const lines = output.split("\n");
    const totalLines = lines.length;

    if (totalLines > displayLines) {
      const lastLines = lines.slice(-displayLines);
      return {
        fullContent: output,
        limitedContent: lastLines.join("\n"),
        totalLines,
        isLimited: true,
        hiddenLinesCount: totalLines - displayLines,
      };
    }

    return {
      fullContent: output,
      limitedContent: output,
      totalLines,
      isLimited: false,
      hiddenLinesCount: 0,
    };
  }, [output, displayLines]);

  // Determine status type
  let statusType: "running" | "completed" | "failed" | "background" = status;
  if (isRunning) {
    statusType = "running";
  } else if (statusMessage?.includes("failed")) {
    statusType = "failed";
  } else if (statusMessage?.includes("background")) {
    statusType = "background";
  }

  const handleMoveToBackground = () => {
    if (toolCallId) {
      void dispatch(
        moveTerminalProcessToBackground({
          toolCallId,
        }),
      );
    }
  };

  // Create combined content for copying (command + output)
  const copyContent = useMemo(() => {
    let content = command;
    if (hasOutput) {
      content += `\n\n${output}`;
    }
    return content;
  }, [command, output, hasOutput]);

  return (
    <StyledTerminalContainer
      fontSize={getFontSize()}
      className="mx-2 mb-4"
      data-testid="terminal-container"
    >
      <div className="outline-command-border rounded-default bg-editor !my-2 flex min-w-0 flex-col outline outline-1">
        {/* Toolbar */}
        <div
          className={`find-widget-skip bg-editor sticky -top-2 z-10 m-0 flex items-center justify-between gap-3 px-1.5 py-1 ${
            isExpanded
              ? "rounded-t-default border-command-border border-b"
              : "rounded-default"
          }`}
          style={{ fontSize: `${getFontSize() - 2}px` }}
        >
          <div className="flex max-w-[50%] flex-row items-center">
            <ChevronDownIcon
              onClick={() => setIsExpanded(!isExpanded)}
              className={`text-description h-3.5 w-3.5 flex-shrink-0 cursor-pointer hover:brightness-125 ${
                isExpanded ? "rotate-0" : "-rotate-90"
              }`}
            />
            <span className="text-description ml-2 select-none">Terminal</span>
          </div>

          <div className="flex items-center gap-2.5">
            {!isRunning && (
              <div className="xs:flex hidden items-center gap-2.5">
                <CopyButton text={copyContent} />
                <RunInTerminalButton command={command} />
              </div>
            )}
          </div>
        </div>

        {/* Content */}
        {isExpanded && (
          <>
            <CommandLine>{command}</CommandLine>
            {(isRunning || hasOutput) && (
              <TerminalContent>
                <pre className="bg-editor">
                  <code>
                    {/* Running state with cursor */}
                    {isRunning && !hasOutput && (
                  <div className="mt-1 flex items-center gap-1">
                    <BlinkingCursor />
                  </div>
                    )}

                    {/* Output with optional collapsible functionality */}
                    {hasOutput && (
                  <div className="mt-1">
                    {/* Expand/Collapse indicator positioned between command and output */}
                    {processedTerminalContent.isLimited && (
                      <IndicatorOnly
                        hiddenLinesCount={
                          processedTerminalContent.hiddenLinesCount
                        }
                        isExpanded={outputExpanded}
                        onToggle={() => setOutputExpanded(!outputExpanded)}
                      />
                    )}

                    <div className="pt-2">
                      {processedTerminalContent.isLimited ? (
                        <CollapsibleOutputContainer
                          limitedContent={
                            processedTerminalContent.limitedContent
                          }
                          fullContent={processedTerminalContent.fullContent}
                          isExpanded={outputExpanded}
                          onToggle={() => setOutputExpanded(!outputExpanded)}
                        />
                      ) : (
                        <div>
                          <XtermOutput
                            content={processedTerminalContent.fullContent}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                    )}
                  </code>
                </pre>
              </TerminalContent>
            )}
          </>
        )}

        {/* Status information */}
        {(statusMessage || isRunning) && (
          <div
            className="text-description flex items-center px-2 pb-2 pt-2 text-xs"
            style={{
              borderTop:
                "1px solid var(--vscode-commandCenter-inactiveBorder, #555555)",
            }}
          >
            <StatusIcon status={statusType} />
            {isRunning ? "Running" : statusMessage}
            {isRunning && toolCallId && (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  handleMoveToBackground();
                }}
                className="text-link ml-3 cursor-pointer text-xs no-underline hover:underline"
              >
                Move to background
              </a>
            )}
          </div>
        )}
      </div>
    </StyledTerminalContainer>
  );
}
