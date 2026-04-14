export type SourceType =
  | "youtube"
  | "pdf"
  | "article"
  | "podcast"
  | "note"
  | "tiktok"
  | "reddit"
  | "x";

export type CardConnection = {
  cardId: string;
  reason: "manual" | "ai-extracted" | "mention" | "semantic";
  weight: number;
};

export type ContextBundle = {
  query: string;
  cards: Array<{
    id: string;
    title: string;
    summary: string;
    tags: string[];
    sourceType: string;
    score?: number;
  }>;
  graph: Array<{
    fromId: string;
    toId: string;
    reason: string;
    weight: number;
  }>;
};
