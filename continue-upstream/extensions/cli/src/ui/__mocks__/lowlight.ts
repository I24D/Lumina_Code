// Mock for lowlight
export const common = {};

export function createLowlight() {
  return {
    register: () => {},
    highlight: (_lang: string, code: string) => ({
      children: [{ type: "text", value: code }],
    }),
    highlightAuto: (code: string) => ({
      children: [{ type: "text", value: code }],
    }),
  };
}
