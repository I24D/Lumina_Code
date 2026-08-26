// Mock for highlight.js language modules
// eslint-disable-next-line import/no-default-export -- mirrors highlight.js modules
export default function mockLanguage() {
  return {
    keywords: "mock keywords",
    contains: [] as unknown[],
  };
}
