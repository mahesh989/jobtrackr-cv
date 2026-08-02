"use client";

/**
 * Shared card context — lets CardShell hand selection state to CardActions.
 *
 * Split out of the former single-file FeedCards.tsx (839 lines). Pure code
 * motion — component bodies and ordering are unchanged. Every component is
 * still importable from "./FeedCards".
 * 
 */
import { createContext } from "react";
export const CardActionsContext = createContext<{
  onDismiss:    () => Promise<void>;
  onEdit:       () => void;
  onToggleStar: (e: React.MouseEvent) => void;
  starred:      boolean;
  pending:      boolean;
}>({ onDismiss: async () => {}, onEdit: () => {}, onToggleStar: () => {}, starred: false, pending: false });
