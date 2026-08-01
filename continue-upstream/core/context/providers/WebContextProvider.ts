import { BaseContextProvider } from "..";
import {
  ContextItem,
  ContextProviderDescription,
  ContextProviderExtras,
  FetchFunction,
} from "../..";
import { getHeaders } from "../../continueServer/stubs/headers";
import { readLuminaEnv } from "../../luminaBridge/luminaEnv";
const TRIAL_PROXY_URL = "https://proxy-server-blue-l6vsfbzhba-uw.a.run.app";

/**
 * Real-time web research via Tavily. The base Continue web search routes through
 * a hosted trial proxy that needs a Continue Hub account — in the Lumina Code
 * fork that fails, so Lumina "can't access the internet". Tavily (key in the
 * root .env, TAVILY_API_KEY) gives Lumina genuine live search with no Hub.
 * Returns null when unconfigured or on failure so the caller can fall back.
 */
async function fetchTavilyResults(
  query: string,
  n: number,
  fetchFn: FetchFunction,
): Promise<ContextItem[] | null> {
  const apiKey = readLuminaEnv("TAVILY_API_KEY");
  if (!apiKey) {
    return null;
  }
  try {
    const resp = await fetchFn("https://api.tavily.com/search" as any, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: Math.max(1, Math.min(20, n)),
        search_depth: "advanced",
        include_answer: true,
      }),
    });
    if (!resp.ok) {
      return null;
    }
    const data: any = await resp.json();
    const items: ContextItem[] = [];
    if (data?.answer) {
      items.push({
        name: "Tavily answer",
        description: query,
        content: String(data.answer),
      });
    }
    for (const r of Array.isArray(data?.results) ? data.results : []) {
      const url = String(r?.url ?? "");
      const title = String(r?.title ?? url);
      const body = String(r?.content ?? r?.raw_content ?? "");
      items.push({
        name: title.slice(0, 100),
        description: url,
        content: `Source: ${url}\n\n${body}`.trim(),
      });
    }
    return items.length ? items : null;
  } catch {
    return null;
  }
}

export const fetchSearchResults = async (
  query: string,
  n: number,
  fetchFn: FetchFunction,
): Promise<ContextItem[]> => {
  // Prefer Tavily (real live search, no Hub dependency); fall back to the
  // Continue trial proxy only if Tavily is unconfigured/unavailable.
  const tavily = await fetchTavilyResults(query, n, fetchFn);
  if (tavily) {
    return tavily;
  }

  const resp = await fetchFn(WebContextProvider.ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await getHeaders()),
    },
    body: JSON.stringify({
      query,
      n,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Web search failed. Set TAVILY_API_KEY in the root .env for real-time search. Proxy error: ${text}`,
    );
  }
  return await resp.json();
};

export default class WebContextProvider extends BaseContextProvider {
  public static ENDPOINT = new URL("web", TRIAL_PROXY_URL);
  private static DEFAULT_N = 6;

  static description: ContextProviderDescription = {
    title: "web",
    displayTitle: "Web",
    description: "Search the web",
    type: "normal",
    renderInlineAs: "",
  };

  async getContextItems(
    query: string,
    extras: ContextProviderExtras,
  ): Promise<ContextItem[]> {
    return await fetchSearchResults(
      extras.fullInput,
      this.options.n ?? WebContextProvider.DEFAULT_N,
      extras.fetch,
    );
  }
}
