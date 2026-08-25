import {
  ArchiveBoxArrowDownIcon,
  ArchiveBoxXMarkIcon,
  ArrowTopRightOnSquareIcon,
  StarIcon,
} from "@heroicons/react/24/outline";
import { StarIcon as StarIconSolid } from "@heroicons/react/24/solid";
import type { SkillCurateAction, SkillWithUsage } from "core/protocol/core";
import { useCallback, useContext, useEffect, useState } from "react";

import HeaderButtonWithToolTip from "../../../components/gui/HeaderButtonWithToolTip";
import { Card, EmptyState } from "../../../components/ui";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { useAppSelector } from "../../../redux/hooks";
import { fontSize } from "../../../util";
import { ConfigHeader } from "../components/ConfigHeader";

/**
 * The one-line summary of what a skill has done for the user.
 *
 * A skill with no telemetry is reported as "not used yet" rather than
 * "used 0 times": the first means Lumina has never reached for it, which is
 * also true of every hand-written skill the moment it is added, and reading
 * that as a failing grade would be wrong.
 */
function usageSummary(skill: SkillWithUsage): string {
  const usage = skill.usage;
  if (!usage) {
    return "Not used yet";
  }
  const parts: string[] = [
    usage.useCount === 0
      ? "Not used yet"
      : `Used ${usage.useCount} time${usage.useCount === 1 ? "" : "s"}`,
  ];
  if (usage.patchCount > 0) {
    parts.push(
      `revised ${usage.patchCount} time${usage.patchCount === 1 ? "" : "s"}`,
    );
  }
  if (usage.lastUsedAt) {
    parts.push(`last ${new Date(usage.lastUsedAt).toLocaleDateString()}`);
  }
  return parts.join(" · ");
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="bg-vsc-background text-description-muted rounded-full px-1.5 py-0.5"
      style={{ fontSize: fontSize(-4) }}
    >
      {children}
    </span>
  );
}

function SkillCard({
  skill,
  onCurate,
}: {
  skill: SkillWithUsage;
  onCurate: (name: string, action: SkillCurateAction) => void;
}) {
  const ideMessenger = useContext(IdeMessengerContext);
  const usage = skill.usage;
  const archived = usage?.state === "archived";
  const pinned = usage?.pinned === true;

  const openSkillFile = () => {
    ideMessenger.post("openFile", { path: skill.path });
  };

  return (
    <div
      className={`border-border hover:bg-list-active hover:text-list-active-foreground flex flex-col rounded-sm px-2 py-1.5 transition-colors hover:cursor-pointer ${
        archived ? "opacity-50" : ""
      }`}
      onClick={openSkillFile}
      data-testid={`skill-card-${skill.name}`}
    >
      <div className="flex flex-row items-start justify-between gap-2">
        <span
          className="text-vscForeground line-clamp-1 font-medium"
          style={{ fontSize: fontSize(-2) }}
        >
          {skill.name}
        </span>
        <div className="flex flex-none flex-row items-center">
          <HeaderButtonWithToolTip
            testId={`skill-pin-${skill.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onCurate(skill.name, pinned ? "unpin" : "pin");
            }}
            text={
              pinned
                ? "Unpin — allow this skill to be flagged stale when unused"
                : "Pin — never flag this skill as stale"
            }
          >
            {pinned ? (
              <StarIconSolid className="h-3 w-3 text-yellow-500" />
            ) : (
              <StarIcon className="h-3 w-3 text-gray-400" />
            )}
          </HeaderButtonWithToolTip>
          <HeaderButtonWithToolTip
            testId={`skill-archive-${skill.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onCurate(skill.name, archived ? "unarchive" : "archive");
            }}
            text={
              archived
                ? "Restore — show this skill to Lumina again"
                : "Archive — hide from Lumina's skill list without deleting the file"
            }
          >
            {archived ? (
              <ArchiveBoxXMarkIcon className="h-3 w-3 text-gray-400" />
            ) : (
              <ArchiveBoxArrowDownIcon className="h-3 w-3 text-gray-400" />
            )}
          </HeaderButtonWithToolTip>
          <HeaderButtonWithToolTip
            onClick={(e) => {
              e.stopPropagation();
              openSkillFile();
            }}
            text="Open SKILL.md"
          >
            <ArrowTopRightOnSquareIcon className="h-3 w-3 text-gray-400" />
          </HeaderButtonWithToolTip>
        </div>
      </div>

      <span
        className="mt-0.5 line-clamp-2 text-gray-400"
        style={{ fontSize: fontSize(-3) }}
      >
        {skill.description}
      </span>

      <div className="mt-1 flex flex-row flex-wrap items-center gap-1">
        <span
          className="text-gray-500"
          style={{ fontSize: fontSize(-4) }}
          data-testid={`skill-usage-${skill.name}`}
        >
          {usageSummary(skill)}
        </span>
        {usage?.createdBy === "agent" && <Badge>Learned by Lumina</Badge>}
        {usage?.state === "stale" && <Badge>Stale</Badge>}
        {archived && <Badge>Archived</Badge>}
      </div>

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
  const ideMessenger = useContext(IdeMessengerContext);
  const configLoading = useAppSelector((store) => store.config.loading);
  // The config copy carries no telemetry, but its reference changes whenever a
  // skill is created or edited on disk — which is exactly when this list goes
  // stale. Selected without a `?? []` default on purpose: that would allocate a
  // fresh array every render, and as an effect dependency it would re-fetch
  // forever.
  const configSkills = useAppSelector((store) => store.config.config.skills);

  const [skills, setSkills] = useState<SkillWithUsage[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void ideMessenger.request("skills/list", undefined).then((result) => {
      if (cancelled) {
        return;
      }
      if (result.status === "success") {
        setSkills(result.content);
      }
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [ideMessenger, configSkills]);

  const onCurate = useCallback(
    (name: string, action: SkillCurateAction) => {
      void ideMessenger
        .request("skills/curate", { name, action })
        .then((result) => {
          if (result.status === "success") {
            setSkills(result.content);
          }
        });
    },
    [ideMessenger],
  );

  return (
    <>
      <ConfigHeader title="Skills" />

      <div className="space-y-4">
        <p className="text-gray-400" style={{ fontSize: fontSize(-3) }}>
          Skills are reusable step-by-step procedures Lumina learns and recalls
          (procedural memory). Lumina saves them automatically with the{" "}
          <code>create_skill</code> tool after solving multi-step tasks, and
          reads them back with <code>read_skill</code>. You can also add them by
          hand as <code>SKILL.md</code> files under <code>.continue/skills</code>{" "}
          or <code>.claude/skills</code>.
        </p>
        <p className="text-gray-400" style={{ fontSize: fontSize(-3) }}>
          Archiving hides a skill from Lumina without deleting the file — she
          can still open it by name, and using it again restores it.
        </p>

        <Card>
          {skills.length > 0 ? (
            <div className="flex flex-col gap-2">
              {skills.map((skill) => (
                <SkillCard
                  key={`${skill.path}:${skill.name}`}
                  skill={skill}
                  onCurate={onCurate}
                />
              ))}
              {configLoading && (
                <div className="px-2 py-1.5 text-xs opacity-65">
                  Reloading skills from your config...
                </div>
              )}
            </div>
          ) : (
            <EmptyState
              message={
                loaded
                  ? "No skills yet. Lumina will save skills here as she learns, or add a SKILL.md under .continue/skills."
                  : "Loading skills..."
              }
            />
          )}
        </Card>
      </div>
    </>
  );
}
