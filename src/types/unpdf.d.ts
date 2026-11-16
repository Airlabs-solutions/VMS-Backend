declare module "unpdf" {
  export function extractText(
    data: Uint8Array | { numPages: number },
    options: { mergePages: true },
  ): Promise<{ totalPages: number; text: string }>;

  export function getDocumentProxy(data: Uint8Array): Promise<{ numPages: number }>;

  export function renderPageAsImage(
    data: Uint8Array | { numPages: number },
    pageNumber: number,
    options: {
      canvasImport: () => Promise<unknown>;
      scale?: number;
      format?: "png" | "jpeg" | "webp";
    },
  ): Promise<Uint8Array>;
}
