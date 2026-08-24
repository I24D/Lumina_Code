import { Octokit } from "@octokit/rest";

export type GitHubWorkItemKind = "issue" | "pull";

export interface GitHubWorkItemReference {
  owner: string;
  repo: string;
  number: number;
  kind?: GitHubWorkItemKind;
}

export interface GitHubWorkItem {
  reference: Required<GitHubWorkItemReference>;
  title: string;
  url: string;
  state: string;
  author?: string;
  labels: string[];
  markdown: string;
  suggestedPrompt: string;
}

const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const MAX_BODY_CHARS = 60_000;
const MAX_COMMENT_CHARS = 4_000;
const MAX_COMMENTS = 50;
const MAX_FILES = 100;

export function parseGitHubWorkItemReference(
  input: string,
): GitHubWorkItemReference {
  const value = input.trim();
  let owner: string | undefined;
  let repo: string | undefined;
  let number: number | undefined;
  let kind: GitHubWorkItemKind | undefined;

  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") {
      throw new Error("Solo se admiten enlaces de github.com.");
    }
    const match = url.pathname.match(
      /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)\/?$/,
    );
    if (match) {
      [, owner, repo] = match;
      kind = match[3] === "pull" ? "pull" : "issue";
      number = Number(match[4]);
    }
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("github.com")) {
      throw cause;
    }
    const match = value.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
    if (match) {
      [, owner, repo] = match;
      number = Number(match[3]);
    }
  }

  repo = repo?.replace(/\.git$/i, "");
  if (
    !owner ||
    !repo ||
    !number ||
    !SAFE_SEGMENT.test(owner) ||
    !SAFE_SEGMENT.test(repo)
  ) {
    throw new Error(
      "Usa una URL como https://github.com/owner/repo/issues/123, /pull/123 o owner/repo#123.",
    );
  }

  return { owner, repo, number, kind };
}

function truncate(value: string | null | undefined, limit: number): string {
  const text = value?.trim() || "";
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n\n[contenido truncado]`;
}

function formatComments(
  comments: Array<{ user?: { login?: string } | null; body?: string | null }>,
): string {
  if (!comments.length) return "";
  return comments
    .slice(0, MAX_COMMENTS)
    .map(
      (comment) =>
        `### ${comment.user?.login ?? "usuario"}\n${truncate(comment.body, MAX_COMMENT_CHARS) || "(sin texto)"}`,
    )
    .join("\n\n");
}

export class GitHubWorkItemService {
  private readonly octokit: Octokit;

  constructor(token?: string, client?: Octokit) {
    this.octokit = client ?? new Octokit({ auth: token || undefined });
  }

  async get(input: string): Promise<GitHubWorkItem> {
    const parsed = parseGitHubWorkItemReference(input);
    const issue = await this.octokit.issues.get({
      owner: parsed.owner,
      repo: parsed.repo,
      issue_number: parsed.number,
    });
    const kind: GitHubWorkItemKind = issue.data.pull_request ? "pull" : "issue";

    if (parsed.kind && parsed.kind !== kind) {
      throw new Error(
        `La referencia apunta a un ${kind === "pull" ? "pull request" : "issue"}, no a un ${parsed.kind === "pull" ? "pull request" : "issue"}.`,
      );
    }

    const comments = await this.octokit.issues.listComments({
      owner: parsed.owner,
      repo: parsed.repo,
      issue_number: parsed.number,
      per_page: MAX_COMMENTS,
    });
    const labels = issue.data.labels
      .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
      .filter(Boolean);
    const ref: Required<GitHubWorkItemReference> = { ...parsed, kind };
    const heading = `${kind === "pull" ? "Pull request" : "Issue"} #${parsed.number}: ${issue.data.title}`;
    const sections = [
      `# ${heading}`,
      `- Repositorio: ${parsed.owner}/${parsed.repo}`,
      `- Estado: ${issue.data.state}`,
      `- Autor: ${issue.data.user?.login ?? "desconocido"}`,
      labels.length ? `- Etiquetas: ${labels.join(", ")}` : "",
      `- URL: ${issue.data.html_url}`,
      `\n## Descripción\n${truncate(issue.data.body, MAX_BODY_CHARS) || "(sin descripción)"}`,
    ];

    if (kind === "pull") {
      const [pull, files, reviews] = await Promise.all([
        this.octokit.pulls.get({
          owner: parsed.owner,
          repo: parsed.repo,
          pull_number: parsed.number,
        }),
        this.octokit.pulls.listFiles({
          owner: parsed.owner,
          repo: parsed.repo,
          pull_number: parsed.number,
          per_page: MAX_FILES,
        }),
        this.octokit.pulls.listReviews({
          owner: parsed.owner,
          repo: parsed.repo,
          pull_number: parsed.number,
          per_page: 30,
        }),
      ]);
      sections.push(
        `\n## Ramas\n${pull.data.head.ref} → ${pull.data.base.ref}`,
        `\n## Cambios\n${
          files.data
            .slice(0, MAX_FILES)
            .map(
              (file) =>
                `- ${file.status}: ${file.filename} (+${file.additions}/-${file.deletions})`,
            )
            .join("\n") || "(sin archivos)"
        }`,
      );
      const reviewText = formatComments(
        reviews.data.map((review) => ({
          user: review.user,
          body: review.body || `Revisión: ${review.state}`,
        })),
      );
      if (reviewText) sections.push(`\n## Revisiones\n${reviewText}`);
    }

    const commentText = formatComments(comments.data);
    if (commentText) sections.push(`\n## Comentarios\n${commentText}`);

    return {
      reference: ref,
      title: issue.data.title,
      url: issue.data.html_url,
      state: issue.data.state,
      author: issue.data.user?.login,
      labels,
      markdown: sections.filter(Boolean).join("\n"),
      suggestedPrompt:
        kind === "pull"
          ? `Revisa y atiende el pull request #${parsed.number} de ${parsed.owner}/${parsed.repo}. Verifica el código local antes de proponer o aplicar cambios.`
          : `Atiende el issue #${parsed.number} de ${parsed.owner}/${parsed.repo}. Analiza el código local, implementa la solución y verifica que funcione.`,
    };
  }
}
