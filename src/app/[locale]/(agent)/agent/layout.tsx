import { AgentShell } from '@/ui/shell/agent/AgentShell';

// Все страницы рабочего места идут в общей оболочке.
export default function AgentLayout({ children }: LayoutProps<'/[locale]/agent'>) {
  return <AgentShell>{children}</AgentShell>;
}
