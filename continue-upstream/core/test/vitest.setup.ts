import { TextDecoder, TextEncoder } from "util";

import fetch, { Request, Response } from "node-fetch";
import { beforeAll } from "vitest";

beforeAll(() => {
  // @ts-ignore
  globalThis.fetch = fetch;
  // @ts-ignore
  globalThis.Request = Request;
  // @ts-ignore
  globalThis.Response = Response;
  // @ts-ignore
  globalThis.TextEncoder = TextEncoder;
  // @ts-ignore
  globalThis.TextDecoder = TextDecoder;
});
