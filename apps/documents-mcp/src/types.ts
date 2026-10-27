export interface DocumentPage {
  number: number;
  text: string;
}

export interface DocumentHeading {
  level: number;
  text: string;
  page: number;
  offset: number;
}

export interface ExtractedDocument {
  path: string;
  name: string;
  format: string;
  size: number;
  modifiedAt: string;
  pages: DocumentPage[];
  headings: DocumentHeading[];
  warnings: string[];
  cacheKey: string;
  chunks?: DocumentChunk[];
  embeddingChunks?: DocumentChunk[];
  embeddingModelKey?: string;
  embeddings?: Array<number[] | null>;
}

export interface DocumentChunk {
  id: string;
  page: number;
  offset: number;
  text: string;
}

export interface ReadCursor {
  version?: string;
  page: number;
  offset: number;
}
