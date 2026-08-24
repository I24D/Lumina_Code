export interface WalkthroughLine {
  kind: "context" | "add" | "remove" | "meta";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface WalkthroughStep {
  id: string;
  filepath: string;
  oldStart: number;
  newStart: number;
  heading: string;
  additions: number;
  deletions: number;
  lines: WalkthroughLine[];
}

export interface WalkthroughFile {
  filepath: string;
  status: "modified" | "added" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  steps: WalkthroughStep[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s?(.*)$/;

function normalizeDiffPath(value: string): string {
  const path = value.trim().split("\t")[0];
  return path === "/dev/null" ? "" : path.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(input: string): WalkthroughFile[] {
  const files: WalkthroughFile[] = [];
  let file: WalkthroughFile | undefined;
  let step: WalkthroughStep | undefined;
  let oldLine = 0;
  let newLine = 0;

  const ensureFile = (filepath = "cambio-sin-ruta") => {
    if (!file) {
      file = {
        filepath,
        status: "modified",
        additions: 0,
        deletions: 0,
        steps: [],
      };
      files.push(file);
    }
    return file;
  };

  for (const line of input.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      const filepath = match?.[2] ?? match?.[1] ?? "cambio-sin-ruta";
      file = {
        filepath,
        status: "modified",
        additions: 0,
        deletions: 0,
        steps: [],
      };
      files.push(file);
      step = undefined;
      continue;
    }

    if (line.startsWith("new file mode ")) {
      ensureFile().status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      ensureFile().status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      ensureFile().status = "renamed";
      continue;
    }
    if (line.startsWith("+++ ")) {
      const filepath = normalizeDiffPath(line.slice(4));
      if (filepath) ensureFile(filepath).filepath = filepath;
      continue;
    }

    const hunk = line.match(HUNK_HEADER);
    if (hunk) {
      const currentFile = ensureFile();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      step = {
        id: `${currentFile.filepath}:${oldLine}:${newLine}:${currentFile.steps.length}`,
        filepath: currentFile.filepath,
        oldStart: oldLine,
        newStart: newLine,
        heading:
          hunk[5] ||
          `Líneas ${newLine}–${newLine + Math.max(Number(hunk[4] || 1) - 1, 0)}`,
        additions: 0,
        deletions: 0,
        lines: [],
      };
      currentFile.steps.push(step);
      continue;
    }

    if (!step) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      step.lines.push({ kind: "add", text: line.slice(1), newLine });
      step.additions++;
      ensureFile().additions++;
      newLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      step.lines.push({ kind: "remove", text: line.slice(1), oldLine });
      step.deletions++;
      ensureFile().deletions++;
      oldLine++;
    } else if (line.startsWith(" ")) {
      step.lines.push({
        kind: "context",
        text: line.slice(1),
        oldLine,
        newLine,
      });
      oldLine++;
      newLine++;
    } else if (line.startsWith("\\")) {
      step.lines.push({ kind: "meta", text: line });
    }
  }

  return files.filter((entry) => entry.steps.length > 0);
}

export function flattenWalkthrough(
  files: WalkthroughFile[],
): WalkthroughStep[] {
  return files.flatMap((file) => file.steps);
}
