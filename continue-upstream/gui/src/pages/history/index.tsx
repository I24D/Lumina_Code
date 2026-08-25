import { useLocation, useNavigate } from "react-router-dom";
import { History } from "../../components/History";
import { Worktrees } from "../../components/History/Worktrees";
import { PageHeader } from "../../components/PageHeader";
import { getFontSize } from "../../util";

export default function HistoryPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const showWorktrees = location.pathname === "/worktrees";

  return (
    <div
      className="flex flex-1 flex-col overflow-auto"
      style={{ fontSize: getFontSize() }}
    >
      <PageHeader
        showBorder
        onTitleClick={() => navigate("/")}
        title="Sesiones y entornos"
      />
      <div className="border-border mx-2 mt-3 flex rounded-lg border border-solid p-1">
        <button
          type="button"
          className={`flex-1 cursor-pointer rounded-md border-0 px-2 py-1.5 text-xs ${
            !showWorktrees
              ? "bg-input text-foreground"
              : "text-description bg-transparent"
          }`}
          onClick={() => navigate("/history")}
        >
          Sesiones
        </button>
        <button
          type="button"
          className={`flex-1 cursor-pointer rounded-md border-0 px-2 py-1.5 text-xs ${
            showWorktrees
              ? "bg-input text-foreground"
              : "text-description bg-transparent"
          }`}
          onClick={() => navigate("/worktrees")}
        >
          Worktrees
        </button>
      </div>
      {showWorktrees ? <Worktrees /> : <History />}
    </div>
  );
}
