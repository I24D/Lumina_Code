import { ToolImpl } from ".";
import { detectRecipe, formatRecipe } from "../../verify/detectRecipe";
import { workspaceFiles } from "../../verify/workspaceFiles";

export const verifyProjectImpl: ToolImpl = async (_args, extras) => {
  const dirs = await extras.ide.getWorkspaceDirs();
  if (dirs.length === 0) {
    throw new Error("No workspace is open, so there is no project to inspect.");
  }

  const recipe = await detectRecipe(workspaceFiles(extras.ide, dirs[0]));

  if (!recipe) {
    return [
      {
        name: "Project commands not detected",
        description: "No recognised manifest",
        content:
          "None of the manifests this recognises are present at the workspace root " +
          "(package.json, pyproject.toml, requirements.txt, go.mod, Cargo.toml, " +
          "pom.xml, build.gradle, Makefile, docker-compose.yml). Ask the user how " +
          "the project builds and tests rather than guessing, and consider saving " +
          "the answer with create_skill.",
      },
    ];
  }

  return [
    {
      name: `Project: ${recipe.name}`,
      description: recipe.evidence.join(", "),
      content: formatRecipe(recipe),
    },
  ];
};
