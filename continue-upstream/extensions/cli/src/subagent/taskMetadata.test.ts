import { describe, expect, it } from "vitest";

import { parseSubagentTaskMetadata } from "./taskMetadata.js";

describe("parseSubagentTaskMetadata", () => {
  it("separates visible output from trace metadata", () => {
    expect(
      parseSubagentTaskMetadata(`Reviewed files
<task_metadata>
status: completed
session_id: child-1
parent_session_id: parent-1
</task_metadata>`),
    ).toEqual({
      output: "Reviewed files",
      status: "completed",
      sessionId: "child-1",
      parentSessionId: "parent-1",
      error: undefined,
    });
  });

  it("preserves streaming output before metadata exists", () => {
    expect(parseSubagentTaskMetadata("Working...  ")).toEqual({
      output: "Working...",
    });
  });
});
