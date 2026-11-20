import { House, Lightbulb, type LucideIcon, MessageSquareText, UserRound } from 'lucide-react';
import type { ClientNavKey } from './nav-config';

/** Значки разделов: lucide, размер 24, толщина 2. */
export const NAV_ICONS: Record<ClientNavKey, LucideIcon> = {
  home: House,
  tickets: MessageSquareText,
  ideas: Lightbulb,
  profile: UserRound,
};
