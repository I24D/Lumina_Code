import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { Skill } from "core";
import { useContext } from "react";

import HeaderButtonWithToolTip from "../../../components/gui/HeaderButtonWithToolTip";
import { Card, EmptyState } from "../../../components/ui";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { useAppSelector } from "../../../redux/hooks";
import { fontSize } from "../../../util";
import { ConfigHeader } from "../components/ConfigHeader";

function SkillCard({ skill }: { skill: Skill }) {
  const ideMessenger = useContext(IdeMessengerContext);

  const openSkillFile = () => {
    ideMessenger.post("openFile", { path: skill.path });
  };

  return (
    <div
      className="border-border hover:bg-list-active hover:text-list-active-foreground flex flex-col rounded-sm px-2 py-1.5 transition-colors hover:cursor-pointer"
      onClick={openSkillFile}
    >
      <div className="flex flex-row items-start justify-between gap-2">
        <span
          className="text-vscForeground line-clamp-1 font-medium"
          style={{ fontSize: fontSize(-2) }}
        >
          {skill.name}
        </span>
        <HeaderButtonWithToolTip onClick={openSkillFile} text="Open SKILL.md">
          <ArrowTopRightOnSquareIcon className="h-3 w-3 text-gray-400" />
        </HeaderButtonWithToolTip>
      </div>
      <span
        className="mt-0.5 line-clamp-2 text-gray-400"
        style={{ fontSize: fontSize(-3) }}
      >
        {skill.description}
      </span>
      <code
        className="mt-1 line-clamp-1 text-gray-500"
        style={{ fontSize: fontSize(-4) }}
      >
        {skill.path}
      </code>
    </div>
  );
}

export function SkillsSection() {
  const skills = useAppSelector((store) => store.config.config.skills ?? []);
  const configLoading = useAppSelector((store) => store.config.loading);

  return (
    <>
      <ConfigHeader title="Skills" />

      <div className="space-y-4">
        <p className="text-gray-400" style={{ fontSize: fontSize(-3) }}>
          Skills are reusable step-by-step procedures Lumina learns and recalls
          (procedural memory). Lumina saves them automatically with the{" "}
          <code>create_skill</code> tool after solving multi-step tasks, and reads
          them back with <code>read_skill</code>. You can also add them by hand as{" "}
          <code>SKILL.md</code> files under <code>.continue/skills</code> or{" "}
          <code>.claude/skills</code>.
        </p>

        <Card>
          {skills.length > 0 ? (
            <div className="flex flex-col gap-2">
              {skills.map((skill) => (
                <SkillCard key={`${skill.path}:${skill.name}`} skill={skill} />
              ))}
              {configLoading && (
                <div className="px-2 py-1.5 text-xs opacity-65">
                  Reloading skills from your config...
                </div>
              )}
            </div>
          ) : (
            <EmptyState message="No skills yet. Lumina will save skills here as she learns, or add a SKILL.md under .continue/skills." />
          )}
        </Card>
      </div>
    </>
  );
}
