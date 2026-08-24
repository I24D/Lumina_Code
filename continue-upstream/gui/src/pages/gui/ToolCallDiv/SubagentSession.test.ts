import { describe, expect, it } from "vitest";

import { parseSubagentMetadata } from "./subagentMetadata";

describe("parseSubagentMetadata", () => {
  it("extracts trace fields without showing protocol markup", () => {
    expect(
      parseSubagentMetadata(`Done
<task_metadata>
status: completed
session_id: child-1
parent_session_id: parent-1
</task_metadata>`),
    ).toEqual({
      output: "Done",
      status: "completed",
      sessionId: "child-1",
      parentSessionId: "parent-1",
      error: undefined,
    });
  });
});
