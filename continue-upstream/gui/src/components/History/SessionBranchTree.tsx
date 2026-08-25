import {
  ChatBubbleLeftRightIcon,
  ChevronRightIcon,
} from "@heroicons/react/24/outline";
import type { BaseSessionMetadata } from "core";
import { getUriPathBasename } from "core/util/uri";

export interface SessionTreeNode {
  session: BaseSessionMetadata;
  children: SessionTreeNode[];
}

function dateValue(session: BaseSessionMetadata) {
  const value = new Date(session.dateCreated).getTime();
  return Number.isFinite(value) ? value : 0;
}

function wouldCreateCycle(
  sessionId: string,
  parentSessionId: string,
  sessions: Map<string, BaseSessionMetadata>,
) {
  const visited = new Set<string>([sessionId]);
  let current: string | undefined = parentSessionId;
  while (current) {
    if (visited.has(current)) return true;
    visited.add(current);
    current = sessions.get(current)?.parentSessionId;
  }
  return false;
}

export function buildSessionTree(
  sessions: BaseSessionMetadata[],
): SessionTreeNode[] {
  const metadata = new Map(
    sessions.map((session) => [session.sessionId, session]),
  );
  const nodes = new Map<string, SessionTreeNode>(
    sessions.map((session): [string, SessionTreeNode] => [
      session.sessionId,
      { session, children: [] },
    ]),
  );
  const roots: SessionTreeNode[] = [];

  for (const session of sessions) {
    const node = nodes.get(session.sessionId)!;
    const parentId = session.parentSessionId;
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (
      parent &&
      parentId &&
      !wouldCreateCycle(session.sessionId, parentId, metadata)
    ) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortNodes = (items: SessionTreeNode[]) => {
    items.sort(
      (left, right) => dateValue(right.session) - dateValue(left.session),
    );
    items.forEach((item) => sortNodes(item.children));
  };
  sortNodes(roots);
  return roots;
}

function BranchNode({
  node,
  depth,
  onOpen,
}: {
  node: SessionTreeNode;
  depth: number;
  onOpen: (sessionId: string) => void;
}) {
  const workspace = getUriPathBasename(node.session.workspaceDirectory || "");
  return (
    <div
      className={
        depth > 0
          ? "border-border ml-3 border-0 border-l border-solid pl-2"
          : ""
      }
    >
      <button
        type="button"
        className="hover:bg-input group my-1 flex w-full cursor-pointer items-start gap-2 rounded-lg border-0 bg-transparent p-2 text-left"
        onClick={() => onOpen(node.session.sessionId)}
      >
        {depth > 0 ? (
          <ChevronRightIcon className="text-description mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChatBubbleLeftRightIcon className="text-description mt-0.5 h-4 w-4 shrink-0" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <strong className="line-clamp-1 break-all text-xs">
              {node.session.title}
            </strong>
            {depth > 0 && (
              <span className="bg-vsc-background text-2xs rounded-full px-1.5 py-0.5">
                fork
              </span>
            )}
          </span>
          <span className="text-description-muted text-2xs mt-0.5 flex flex-wrap gap-x-2">
            {workspace && <span>{workspace}</span>}
            {node.session.messageCount !== undefined && (
              <span>{node.session.messageCount} respuestas</span>
            )}
            {node.children.length > 0 && (
              <span>
                {node.children.length}{" "}
                {node.children.length === 1 ? "rama" : "ramas"}
              </span>
            )}
          </span>
        </span>
      </button>
      {node.children.map((child) => (
        <BranchNode
          key={child.session.sessionId}
          node={child}
          depth={depth + 1}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

export function SessionBranchTree({
  sessions,
  onOpen,
}: {
  sessions: BaseSessionMetadata[];
  onOpen: (sessionId: string) => void;
}) {
  const roots = buildSessionTree(sessions);
  if (roots.length === 0) {
    return (
      <div className="text-description py-8 text-center text-sm">
        No hay ramas de conversación para mostrar.
      </div>
    );
  }
  return (
    <div className="px-1 pb-3" data-testid="session-branch-tree">
      {roots.map((root) => (
        <BranchNode
          key={root.session.sessionId}
          node={root}
          depth={0}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}
