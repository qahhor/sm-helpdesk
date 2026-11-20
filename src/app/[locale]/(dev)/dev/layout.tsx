import { AgentShell } from '@/ui/shell/agent/AgentShell';

// Витрина компонентов для разработчиков: открыта без входа и только при HUB_SHOWCASE=1
// (docs/decisions/0008-showcase-flag.md). Оболочка та же, что у рабочего места, но без меню пользователя.
export default function DevLayout({ children }: LayoutProps<'/[locale]/dev'>) {
  return <AgentShell>{children}</AgentShell>;
}
